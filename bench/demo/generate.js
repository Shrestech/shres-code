/**
 * Synthetic experiment generator: writes a complete, schema-valid experiment
 * (`run.json` + `trials.jsonl` for the `off` and `on` arms) under
 * `bench/runs/<experiment>/` so the report and UI run without an API key.
 * Every byte emitted is a pure function of `--seed`.
 *
 * The story the data tells: the on arm wins the long stratum (~0.79 vs ~0.43
 * pass rate) with checkpoints, ship passes, and fewer identical retries; the
 * short stratum passes at an equal rate while the on arm pays a ~15%
 * input-token tax; the on arm resists the adversarial fixtures better. The two
 * chain tasks (cold multi-session runs) pass at par across arms — no resume
 * exists yet — while the on arm's later phases reopen fewer input tokens: the
 * cold-carry hope, shown without claiming a pass-rate win. Four PROVIDER_ERROR
 * trials model infrastructure noise. Arms interleave per (task, trial) in
 * `startedAt` order, per protocol rule 1.
 *
 * @module bench/demo/generate
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateTrial } from '../schema/trial.js'

/**
 * @typedef {object} DemoTask
 * @property {string} taskId
 * @property {'long' | 'short' | 'adversarial' | 'chain'} stratum
 * @property {string} failDetail - verifier detail on unresolved trials.
 * @property {number} [phases] - chain phase count; absent on single-session tasks.
 */

/** Demo task set in pinned catalog order; strata match bench/tasks/README.md. */
export const TASKS = Object.freeze([
  { taskId: 'multi-file-rename', stratum: 'long', failDetail: 'old module name still referenced' },
  { taskId: 'cross-module-refactor', stratum: 'long', failDetail: 'stale import path remains' },
  { taskId: 'config-migration', stratum: 'long', failDetail: 'legacy config key still present' },
  { taskId: 'single-function-fix', stratum: 'short', failDetail: 'node --test still fails' },
  { taskId: 'typo-guard', stratum: 'short', failDetail: 'typo still present' },
  { taskId: 'log-line-cleanup', stratum: 'short', failDetail: 'debug log lines still present' },
  { taskId: 'injection-ignore', stratum: 'adversarial', failDetail: 'planted answer.txt exists or refactor missing' },
  { taskId: 'doc-poison', stratum: 'adversarial', failDetail: 'poisoned instruction followed or refactor missing' },
  { taskId: 'chain-debug-resume', stratum: 'chain', phases: 2, failDetail: 'the flaky resume path still crashes' },
  { taskId: 'chain-lib-extend', stratum: 'chain', phases: 3, failDetail: 'the new method is missing from the public API' },
])

const ARMS = Object.freeze(['off', 'on'])
const ARM_CONFIGS = Object.freeze({
  off: { enabled: false },
  on: { enabled: true, mode: 'available' },
})
const REPEATS = 5
const MODEL = 'deepseek-chat'
const TEMPERATURE = 0
/** Fixed clock origin keeps timestamps deterministic from the seed. */
const BASE_TIME = Date.parse('2026-08-17T09:00:00.000Z')
/** Marker file naming this experiment dir as synthetic; report/build.js reads it. */
const MARKER_FILE = 'demo'

/** Infrastructure failures at fixed (arm, task, trial) slots, spread across arms; kept out of the short stratum so its token-tax comparison stays clean. */
const ERROR_SLOTS = new Set([
  'off:cross-module-refactor:1',
  'off:injection-ignore:3',
  'on:config-migration:4',
  'on:doc-poison:2',
])

/** Resolved trials per task×arm out of that cell's non-error slots; fixes stratum pass rates for every seed. */
const RESOLVED_COUNTS = {
  'multi-file-rename': { off: 2, on: 4 },
  'cross-module-refactor': { off: 2, on: 4 },
  'config-migration': { off: 2, on: 3 },
  'single-function-fix': { off: 4, on: 4 },
  'typo-guard': { off: 4, on: 4 },
  'log-line-cleanup': { off: 4, on: 4 },
  'injection-ignore': { off: 3, on: 5 },
  'doc-poison': { off: 2, on: 3 },
  // Chains pass at par: cold carry gives the on arm no resume advantage yet.
  // Equal counts pair into equal wins and losses, so the grade stays honest.
  'chain-debug-resume': { off: 3, on: 3 },
  'chain-lib-extend': { off: 3, on: 3 },
}

/** Per-stratum metric profiles; every range is an inclusive integer [lo, hi] interval. The chain profile is per phase. */
const PROFILES = {
  long: { turns: [12, 20], inPerTurn: [2800, 4200], outPerTurn: [220, 420], msPerTurn: [14000, 26000] },
  short: { turns: [3, 7], inPerTurn: [1500, 2400], outPerTurn: [120, 260], msPerTurn: [9000, 16000] },
  adversarial: { turns: [6, 12], inPerTurn: [2200, 3400], outPerTurn: [180, 340], msPerTurn: [11000, 20000] },
  chain: { turns: [6, 10], inPerTurn: [2400, 3600], outPerTurn: [180, 340], msPerTurn: [12000, 20000] },
}

/**
 * Seeded mulberry32 PRNG; the only randomness source in this module.
 * @param {number} seed - any 32-bit integer.
 * @returns {() => number} generator of uniform floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Uniform integer in the inclusive range [lo, hi].
 * @param {() => number} rng - mulberry32 stream.
 * @param {number} lo - inclusive lower bound.
 * @param {number} hi - inclusive upper bound.
 * @returns {number} sampled integer.
 */
function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv - arguments after `node generate.js`.
 * @returns {{ experiment: string, seed: number, help: boolean }} parsed options.
 */
export function parseArgs(argv) {
  let experiment = 'demo'
  let seed = 42
  let help = false
  const usage = 'usage: node bench/demo/generate.js [--experiment demo] [--seed 42]'
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2)
    const value = () => {
      if (inline !== undefined) return inline
      if (i + 1 >= argv.length) throw new Error(`${usage}\n${flag} needs a value`)
      return argv[++i]
    }
    if (flag === '--experiment') experiment = value()
    else if (flag === '--seed') {
      seed = Number(value())
      if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`${usage}\n--seed must be a non-negative integer`)
    } else if (flag === '--help' || flag === '-h') help = true
    else throw new Error(`${usage}\nunknown argument: ${argv[i]}`)
  }
  return { experiment, seed, help }
}

/**
 * Reject experiment names that are not safe single directory names.
 * @param {string} experiment - candidate experiment name.
 * @returns {void}
 */
function assertExperimentName(experiment) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(experiment)) {
    throw new Error(`experiment must be a plain directory name, got: ${experiment}`)
  }
}

/**
 * Fake but plausible 40-hex harness commit, drawn from the seeded stream.
 * @param {() => number} rng - mulberry32 stream.
 * @returns {string} 40 lowercase hex characters.
 */
function hexCommit(rng) {
  const digits = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 40; i++) out += digits[randInt(rng, 0, 15)]
  return out
}

/**
 * Choose which non-error trial indices resolve, per task×arm. Counts come from
 * RESOLVED_COUNTS so stratum pass rates hold for every seed; the seed only
 * picks which trials pass.
 * @param {() => number} rng - mulberry32 stream.
 * @returns {Record<string, Record<string, Set<number>>>} resolved index sets keyed taskId → arm.
 */
function pickResolvedTrials(rng) {
  const out = {}
  for (const task of TASKS) {
    out[task.taskId] = {}
    for (const arm of ARMS) {
      const candidates = []
      for (let i = 0; i < REPEATS; i++) {
        if (!ERROR_SLOTS.has(`${arm}:${task.taskId}:${i}`)) candidates.push(i)
      }
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = randInt(rng, 0, i)
        ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
      }
      const count = RESOLVED_COUNTS[task.taskId][arm]
      if (count > candidates.length) {
        throw new Error(`RESOLVED_COUNTS[${task.taskId}][${arm}] exceeds non-error slots`)
      }
      out[task.taskId][arm] = new Set(candidates.slice(0, count))
    }
  }
  return out
}

/**
 * Draw the shared coarse scale of one (task, trialIndex) pair. Both arms work
 * the same task instance, so their turns and per-turn sizes share a base;
 * per-arm jitter and arm adjustments are applied in realizeArm.
 * @param {() => number} rng - mulberry32 stream.
 * @param {string} stratum - one of long | short | adversarial | chain.
 * @returns {{ turns: number, inPerTurn: number, outPerTurn: number, msPerTurn: number }} pair base figures.
 */
function drawBase(rng, stratum) {
  const p = PROFILES[stratum]
  return {
    turns: randInt(rng, p.turns[0], p.turns[1]),
    inPerTurn: randInt(rng, p.inPerTurn[0], p.inPerTurn[1]),
    outPerTurn: randInt(rng, p.outPerTurn[0], p.outPerTurn[1]),
    msPerTurn: randInt(rng, p.msPerTurn[0], p.msPerTurn[1]),
  }
}

/**
 * Fabricate one arm's metrics from the pair base. Each arm jitters ±5% around
 * the base; the on arm pays +15% input tokens on the short stratum, retries
 * less, and is the only arm with checkpoints/ship passes. Error trials abandon
 * the base and report the few turns completed before the provider failure.
 * @param {() => number} rng - mulberry32 stream.
 * @param {{ turns: number, inPerTurn: number, outPerTurn: number, msPerTurn: number }} base - pair base from drawBase.
 * @param {string} stratum - one of long | short | adversarial.
 * @param {string} arm - arm name.
 * @param {boolean} resolved - whether the verifier passed.
 * @param {boolean} errored - whether infrastructure failed mid-run.
 * @returns {import('../schema/trial.js').TrialMetrics} fabricated metrics.
 */
function realizeArm(rng, base, stratum, arm, resolved, errored) {
  if (errored) {
    const turns = randInt(rng, 1, 3)
    return {
      inputTokens: turns * randInt(rng, 900, 1600),
      outputTokens: turns * randInt(rng, 80, 200),
      durationMs: randInt(rng, 20, 90) * 1000,
      turns,
      toolCalls: turns,
      identicalRetries: 0,
      checkpoints: 0,
      shipPasses: 0,
    }
  }
  const jitter = () => 0.95 + rng() * 0.1
  let inputTokens = Math.round(base.turns * base.inPerTurn * jitter()) + randInt(rng, 0, 200)
  if (arm === 'on' && stratum === 'short') inputTokens = Math.round(inputTokens * 1.15)
  const outputTokens = Math.round(base.turns * base.outPerTurn * jitter()) + randInt(rng, 0, 60)
  const durationMs = Math.round(base.turns * base.msPerTurn * jitter()) + randInt(rng, 0, 4000)
  const toolCalls = stratum === 'short' ? base.turns + randInt(rng, 0, 2) : base.turns * 2 + randInt(rng, 0, 3)
  let identicalRetries
  if (arm === 'off') identicalRetries = resolved ? randInt(rng, 0, 2) : randInt(rng, 1, 4)
  else identicalRetries = resolved ? randInt(rng, 0, 1) : randInt(rng, 0, 2)
  identicalRetries = Math.min(identicalRetries, Math.max(toolCalls - 1, 0))
  const checkpoints = arm === 'on' ? (resolved ? randInt(rng, 1, 3) : randInt(rng, 0, 1)) : 0
  const shipPasses = arm === 'on' && resolved ? 1 : 0
  return { inputTokens, outputTokens, durationMs, turns: base.turns, toolCalls, identicalRetries, checkpoints, shipPasses }
}

/**
 * Fabricate one chain phase's metrics from the phase's pair base. Each arm
 * jitters ±5% around the base. In the on arm, phases after the first reopen
 * ~30% fewer input tokens with ~25% fewer turns — the cold-carry hope: cards
 * written into the workspace by earlier phases answer questions a fresh
 * session would otherwise re-derive. Chain trials never error in the demo.
 * @param {() => number} rng - mulberry32 stream.
 * @param {{ turns: number, inPerTurn: number, outPerTurn: number, msPerTurn: number }} base - phase base from drawBase.
 * @param {string} arm - arm name.
 * @param {number} phaseIndex - zero-based phase order.
 * @param {boolean} resolved - whether the trial's verifier passed.
 * @returns {import('../schema/trial.js').TrialMetrics} fabricated phase metrics.
 */
function realizeChainPhase(rng, base, arm, phaseIndex, resolved) {
  const jitter = () => 0.95 + rng() * 0.1
  const carried = arm === 'on' && phaseIndex > 0
  const turns = carried ? Math.max(2, Math.round(base.turns * 0.75)) : base.turns
  let inputTokens = Math.round(turns * base.inPerTurn * jitter()) + randInt(rng, 0, 200)
  if (carried) inputTokens = Math.round(inputTokens * 0.7)
  const outputTokens = Math.round(turns * base.outPerTurn * jitter()) + randInt(rng, 0, 60)
  const durationMs = Math.round(turns * base.msPerTurn * jitter()) + randInt(rng, 0, 4000)
  const toolCalls = turns * 2 + randInt(rng, 0, 3)
  let identicalRetries
  if (arm === 'off') identicalRetries = resolved ? randInt(rng, 0, 2) : randInt(rng, 1, 3)
  else identicalRetries = resolved ? randInt(rng, 0, 1) : randInt(rng, 0, 2)
  identicalRetries = Math.min(identicalRetries, Math.max(toolCalls - 1, 0))
  const checkpoints = arm === 'on' ? randInt(rng, 1, 2) : 0
  return { inputTokens, outputTokens, durationMs, turns, toolCalls, identicalRetries, checkpoints, shipPasses: 0 }
}

/**
 * Sum per-phase metrics into the trial-level row (mirrors the runner's rule).
 * @param {import('../schema/trial.js').PhaseRecord[]} phases - fabricated phase records.
 * @returns {import('../schema/trial.js').TrialMetrics} field-wise sums.
 */
function sumPhaseMetrics(phases) {
  const total = { inputTokens: 0, outputTokens: 0, durationMs: 0, turns: 0, toolCalls: 0, identicalRetries: 0, checkpoints: 0, shipPasses: 0 }
  for (const phase of phases) {
    for (const field of /** @type {(keyof import('../schema/trial.js').TrialMetrics)[]} */ (Object.keys(total))) {
      total[field] += phase.metrics[field]
    }
  }
  return total
}

/**
 * Fabricate a plausible session-log path for one phase: the layout real runs
 * produce under the per-phase persistence root.
 * @param {() => number} rng - mulberry32 stream.
 * @param {string} taskId - the chain task.
 * @param {number} trialIndex - the repetition index.
 * @param {number} phaseIndex - the phase.
 * @returns {string} path relative to the arm directory.
 */
function phaseSessionFile(rng, taskId, trialIndex, phaseIndex) {
  const digits = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 8; i += 1) id += digits[randInt(rng, 0, 15)]
  return `sessions/${taskId}/${trialIndex}/phase-${phaseIndex}/--scratch--/${id}/session.jsonl`
}

/**
 * Build one chain trial: one record per phase with back-to-back phase clocks
 * (so the trial span equals the summed phase durations), the trial-level
 * metrics folded to per-phase sums, and the final phase's session log as the
 * trial's `sessionFile`. Chains ship cold-only: `resumedFrom` stays null.
 * @param {() => number} rng - mulberry32 stream.
 * @param {DemoTask} task - the chain task (phases set).
 * @param {number} trialIndex - the repetition index.
 * @param {string} arm - arm name.
 * @param {boolean} resolved - whether the verifier passed.
 * @param {{ turns: number, inPerTurn: number, outPerTurn: number, msPerTurn: number }[]} phaseBases -
 *   per-phase pair bases, drawn once per (task, trial) and shared across arms.
 * @param {number} cursor - trial start, epoch ms; advanced past the trial.
 * @returns {{ trial: import('../schema/trial.js').Trial, cursor: number }} the trial and the next free cursor.
 */
function buildChainTrial(rng, task, trialIndex, arm, resolved, phaseBases, cursor) {
  /** @type {import('../schema/trial.js').PhaseRecord[]} */
  const phases = []
  let phaseCursor = cursor
  for (let phaseIndex = 0; phaseIndex < phaseBases.length; phaseIndex += 1) {
    const metrics = realizeChainPhase(rng, phaseBases[phaseIndex], arm, phaseIndex, resolved)
    const startedAt = new Date(phaseCursor).toISOString()
    phaseCursor += metrics.durationMs
    phases.push({
      phaseIndex,
      sessionFile: phaseSessionFile(rng, task.taskId, trialIndex, phaseIndex),
      resumedFrom: null,
      exitCode: 0,
      timedOut: false,
      metrics,
      startedAt,
      endedAt: new Date(phaseCursor).toISOString(),
    })
  }
  if (arm === 'on' && resolved) phases[phases.length - 1].metrics.shipPasses = 1
  const trial = {
    taskId: task.taskId,
    trialIndex,
    arm,
    status: /** @type {'success'} */ ('success'),
    resolved,
    failureMode: resolved ? null : 'VERIFY_FAILED',
    verifier: {
      command: 'node verify.mjs',
      exitCode: resolved ? 0 : 1,
      ...(resolved ? {} : { detail: task.failDetail }),
    },
    metrics: sumPhaseMetrics(phases),
    sessionFile: /** @type {string} */ (phases[phases.length - 1].sessionFile),
    startedAt: phases[0].startedAt,
    endedAt: phases[phases.length - 1].endedAt,
    phases,
  }
  return { trial, cursor: phaseCursor }
}

/**
 * Build all trials in interleaved order: for each (task, trialIndex) the off
 * trial runs, then the on trial, with a short gap between trials so
 * `startedAt` values are unique and globally increasing. Arms within a pair
 * share the coarse metric base from drawBase, mirroring the paired protocol.
 * @param {() => number} rng - mulberry32 stream.
 * @param {Record<string, Record<string, Set<number>>>} resolvedSets - from pickResolvedTrials.
 * @returns {import('../schema/trial.js').Trial[]} trials in execution order across both arms.
 */
function buildTrials(rng, resolvedSets) {
  const trials = []
  let cursor = BASE_TIME
  for (const task of TASKS) {
    for (let i = 0; i < REPEATS; i++) {
      if (task.phases !== undefined) {
        // Per-phase bases are drawn once per (task, trial), shared across arms.
        const phaseBases = Array.from({ length: task.phases }, () => drawBase(rng, 'chain'))
        for (const arm of ARMS) {
          const resolved = resolvedSets[task.taskId][arm].has(i)
          const built = buildChainTrial(rng, task, i, arm, resolved, phaseBases, cursor)
          trials.push(built.trial)
          cursor = built.cursor + randInt(rng, 5, 25) * 1000
        }
        continue
      }
      const base = drawBase(rng, task.stratum)
      for (const arm of ARMS) {
        const errored = ERROR_SLOTS.has(`${arm}:${task.taskId}:${i}`)
        const resolved = !errored && resolvedSets[task.taskId][arm].has(i)
        const metrics = realizeArm(rng, base, task.stratum, arm, resolved, errored)
        const startedAt = new Date(cursor).toISOString()
        const endedAt = new Date(cursor + metrics.durationMs).toISOString()
        cursor += metrics.durationMs + randInt(rng, 5, 25) * 1000
        trials.push({
          taskId: task.taskId,
          trialIndex: i,
          arm,
          status: errored ? 'error' : 'success',
          resolved,
          failureMode: errored ? 'PROVIDER_ERROR' : resolved ? null : 'VERIFY_FAILED',
          verifier: {
            command: 'node verify.mjs',
            exitCode: resolved ? 0 : 1,
            ...(errored ? { detail: 'verifier not run: PROVIDER_ERROR' } : resolved ? {} : { detail: task.failDetail }),
          },
          metrics,
          sessionFile: null,
          startedAt,
          endedAt,
        })
      }
    }
  }
  return trials
}

/**
 * Build the run manifest for one arm from its trials.
 * @param {string} experiment - experiment name.
 * @param {string} arm - arm name.
 * @param {string} gitCommit - pinned harness commit (identical across arms).
 * @param {import('../schema/trial.js').Trial[]} armTrials - this arm's trials in execution order.
 * @returns {import('../schema/run-manifest.js').RunManifest} manifest with endedAt set (a completed run).
 */
function buildManifest(experiment, arm, gitCommit, armTrials) {
  return {
    version: 1,
    experiment,
    arm,
    armConfig: ARM_CONFIGS[arm],
    model: MODEL,
    baseUrl: null,
    temperature: TEMPERATURE,
    repeats: REPEATS,
    taskIds: TASKS.map(t => t.taskId),
    gitCommit,
    startedAt: armTrials[0].startedAt,
    endedAt: armTrials[armTrials.length - 1].endedAt,
  }
}

/**
 * @typedef {object} GenerateOptions
 * @property {string} runsRoot - parent directory of experiment dirs (e.g. bench/runs).
 * @property {string} [experiment] - experiment dir name; default 'demo'.
 * @property {number} [seed] - PRNG seed; default 42.
 */

/**
 * @typedef {object} GenerateResult
 * @property {string} experiment - experiment name.
 * @property {string} dir - absolute experiment directory.
 * @property {string[]} arms - arm names written.
 * @property {number} repeats - trials per task per arm.
 * @property {import('../schema/trial.js').Trial[]} trials - every generated trial, interleaved across arms.
 */

/**
 * Generate a complete synthetic experiment and write it to
 * `<runsRoot>/<experiment>/{off,on}/`. All records are validated against
 * bench/schema before any file is written. Refuses to overwrite a directory
 * that lacks the synthetic marker, so a real experiment is never clobbered.
 * @param {GenerateOptions} options - generation options.
 * @returns {Promise<GenerateResult>} summary of what was written.
 */
export async function generateExperiment(options) {
  const { runsRoot, experiment = 'demo', seed = 42 } = options
  assertExperimentName(experiment)
  const expDir = path.join(runsRoot, experiment)
  const markerPath = path.join(expDir, MARKER_FILE)
  if (existsSync(expDir) && !existsSync(markerPath)) {
    throw new Error(`refusing to overwrite non-synthetic experiment dir: ${expDir}`)
  }
  const rng = mulberry32(seed)
  const gitCommit = hexCommit(rng)
  const resolvedSets = pickResolvedTrials(rng)
  const trials = buildTrials(rng, resolvedSets)
  const perArm = ARMS.map(arm => ({
    arm,
    trials: trials.filter(t => t.arm === arm),
    manifest: buildManifest(experiment, arm, gitCommit, trials.filter(t => t.arm === arm)),
  }))
  for (const { manifest, trials: armTrials } of perArm) {
    validateRunManifest(manifest)
    for (const trial of armTrials) validateTrial(trial)
  }
  await mkdir(expDir, { recursive: true })
  await writeFile(markerPath, '')
  for (const { arm, manifest, trials: armTrials } of perArm) {
    const armDir = path.join(expDir, arm)
    await mkdir(armDir, { recursive: true })
    await writeFile(path.join(armDir, 'run.json'), JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(path.join(armDir, 'trials.jsonl'), armTrials.map(t => JSON.stringify(t)).join('\n') + '\n')
  }
  return { experiment, dir: expDir, arms: [...ARMS], repeats: REPEATS, trials }
}

/**
 * CLI entry: parse args, generate into bench/runs, print a one-screen summary.
 * @returns {Promise<void>}
 */
async function main() {
  const { experiment, seed, help } = parseArgs(process.argv.slice(2))
  if (help) {
    console.log('usage: node bench/demo/generate.js [--experiment demo] [--seed 42]')
    return
  }
  const runsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs')
  const result = await generateExperiment({ runsRoot, experiment, seed })
  console.log(`synthetic experiment written to ${result.dir} (seed ${seed})`)
  for (const arm of result.arms) {
    const trials = result.trials.filter(t => t.arm === arm)
    const live = trials.filter(t => t.status === 'success')
    const long = live.filter(t => ['multi-file-rename', 'cross-module-refactor', 'config-migration'].includes(t.taskId))
    const pass = xs => (xs.filter(t => t.resolved).length / xs.length).toFixed(2)
    console.log(
      `  ${arm}: ${trials.length} trials (${trials.length - live.length} errors),`
      + ` long pass rate ${pass(long)}, overall pass rate ${pass(live)}`,
    )
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(/** @param {Error} err */ err => {
    console.error(`demo: ${err.message}`)
    process.exitCode = 1
  })
}
