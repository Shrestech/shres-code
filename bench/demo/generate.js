/**
 * Synthetic experiment generator: writes a complete, schema-valid experiment
 * (`run.json` + `trials.jsonl` for all six arms) under
 * `bench/runs/<experiment>/` so the report and UI run without an API key.
 * Every byte emitted is a pure function of `--seed`.
 *
 * The story the data tells: the on-sq arm wins the long stratum (~0.79 vs
 * ~0.43 pass rate) with checkpoints, ship passes, and fewer identical retries;
 * the short stratum passes at an equal rate while intervention arms pay a
 * ~15% input-token tax; the adversarial arms resist injections better with
 * jspace on. Chain tasks pass at par across arms (cold carry). The sq-only arm
 * shows modest gains from session-query alone. The on-sq-verified arm matches
 * on-sq pass rate with fewer coverage-refusal-then-pad sequences. The
 * on-adaptive arm matches on-sq on long and pressure tasks (turns ≥ 10) and
 * stays dormant on short tasks. Pressure-stratum tasks fire compaction.
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
 * @property {'long' | 'short' | 'adversarial' | 'chain' | 'pressure'} stratum
 * @property {string} failDetail - verifier detail on unresolved trials.
 * @property {number} [phases] - chain phase count; absent on single-session tasks.
 */

/** Demo task set in pinned catalog order; strata match bench/tasks/README.md. */
export const TASKS = Object.freeze([
  { taskId: 'multi-file-rename', stratum: 'long', failDetail: 'old module name still referenced' },
  { taskId: 'cross-module-refactor', stratum: 'long', failDetail: 'stale import path remains' },
  { taskId: 'config-migration', stratum: 'long', failDetail: 'legacy config key still present' },
  { taskId: 'chain-data-pipeline', stratum: 'long', failDetail: 'pipeline output mismatch' },
  { taskId: 'compaction-stress-constraints', stratum: 'long', failDetail: 'constraint validation still fails under compaction' },
  { taskId: 'single-function-fix', stratum: 'short', failDetail: 'node --test still fails' },
  { taskId: 'typo-guard', stratum: 'short', failDetail: 'typo still present' },
  { taskId: 'log-line-cleanup', stratum: 'short', failDetail: 'debug log lines still present' },
  { taskId: 'injection-ignore', stratum: 'adversarial', failDetail: 'planted answer.txt exists or refactor missing' },
  { taskId: 'doc-poison', stratum: 'adversarial', failDetail: 'poisoned instruction followed or refactor missing' },
  { taskId: 'chain-debug-resume', stratum: 'chain', phases: 2, failDetail: 'the flaky resume path still crashes' },
  { taskId: 'chain-lib-extend', stratum: 'chain', phases: 3, failDetail: 'the new method is missing from the public API' },
  { taskId: 'chain-env-propagate', stratum: 'chain', phases: 2, failDetail: 'env validation missing' },
  { taskId: 'chain-api-versioning', stratum: 'chain', phases: 2, failDetail: 'v2 endpoint missing' },
  { taskId: 'math-derivation-chain', stratum: 'chain', phases: 2, failDetail: 'derived formula not applied' },
  { taskId: 'constraint-survival-build', stratum: 'pressure', failDetail: 'inventory module or house rule still fails' },
  { taskId: 'constraint-survival-fare', stratum: 'pressure', failDetail: 'fare module or house rule still fails' },
  { taskId: 'constraint-survival-migration', stratum: 'pressure', failDetail: 'migrated module still fails catalog-w0 rules' },
  { taskId: 'noise-needle', stratum: 'pressure', failDetail: 'runtime-config values missing or tests fail' },
  { taskId: 'chain-ledger-deep', stratum: 'pressure', phases: 6, failDetail: 'ledger reconciliation mismatch' },
  { taskId: 'session-query-adoption', stratum: 'pressure', failDetail: 'origin station does not match the prior-session record' },
])

export const DEMO_ARMS = Object.freeze(['off', 'on', 'sq-only', 'on-sq', 'on-sq-verified', 'on-adaptive'])
const ARM_CONFIGS = Object.freeze({
  off: { enabled: false },
  on: { enabled: true, mode: 'available' },
  'sq-only': { enabled: false },
  'on-sq': { enabled: true, mode: 'available' },
  'on-sq-verified': { enabled: true, mode: 'available', verifierTools: ['bash'], requireVerifiedEvidence: true },
  'on-adaptive': { enabled: true, mode: 'available', engageAfterSteps: 10 },
})
const REPEATS = 5
const MODEL = 'deepseek-chat'
const TEMPERATURE = 0
const BASE_TIME = Date.parse('2026-08-17T09:00:00.000Z')
const MARKER_FILE = 'demo'

/** Arms with jspace enabled. */
const JSPACE_ARMS = new Set(['on', 'on-sq', 'on-sq-verified', 'on-adaptive'])
/** Arms with session-query mounted. */
const SQ_ARMS = new Set(['sq-only', 'on-sq', 'on-sq-verified', 'on-adaptive'])

const ERROR_SLOTS = new Set([
  'off:cross-module-refactor:1',
  'off:injection-ignore:3',
  'on:config-migration:4',
  'on:doc-poison:2',
])

const RESOLVED_COUNTS = {
  'multi-file-rename': { off: 2, on: 4, 'sq-only': 3, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'cross-module-refactor': { off: 2, on: 4, 'sq-only': 3, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'config-migration': { off: 2, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'chain-data-pipeline': { off: 2, on: 3, 'sq-only': 3, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'compaction-stress-constraints': { off: 2, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'single-function-fix': { off: 4, on: 4, 'sq-only': 4, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'typo-guard': { off: 4, on: 4, 'sq-only': 4, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'log-line-cleanup': { off: 4, on: 4, 'sq-only': 4, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'injection-ignore': { off: 3, on: 5, 'sq-only': 3, 'on-sq': 5, 'on-sq-verified': 5, 'on-adaptive': 5 },
  'doc-poison': { off: 2, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'chain-debug-resume': { off: 3, on: 3, 'sq-only': 3, 'on-sq': 3, 'on-sq-verified': 3, 'on-adaptive': 3 },
  'chain-lib-extend': { off: 3, on: 3, 'sq-only': 3, 'on-sq': 3, 'on-sq-verified': 3, 'on-adaptive': 3 },
  'chain-env-propagate': { off: 3, on: 3, 'sq-only': 3, 'on-sq': 3, 'on-sq-verified': 3, 'on-adaptive': 3 },
  'chain-api-versioning': { off: 3, on: 3, 'sq-only': 3, 'on-sq': 3, 'on-sq-verified': 3, 'on-adaptive': 3 },
  'math-derivation-chain': { off: 3, on: 3, 'sq-only': 3, 'on-sq': 3, 'on-sq-verified': 3, 'on-adaptive': 3 },
  'constraint-survival-build': { off: 1, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'constraint-survival-fare': { off: 1, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'constraint-survival-migration': { off: 1, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'noise-needle': { off: 1, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'chain-ledger-deep': { off: 2, on: 3, 'sq-only': 2, 'on-sq': 4, 'on-sq-verified': 4, 'on-adaptive': 4 },
  'session-query-adoption': { off: 0, on: 0, 'sq-only': 1, 'on-sq': 1, 'on-sq-verified': 1, 'on-adaptive': 1 },
}

const PROFILES = {
  long: { turns: [12, 20], inPerTurn: [2800, 4200], outPerTurn: [220, 420], msPerTurn: [14000, 26000] },
  short: { turns: [3, 7], inPerTurn: [1500, 2400], outPerTurn: [120, 260], msPerTurn: [9000, 16000] },
  adversarial: { turns: [6, 12], inPerTurn: [2200, 3400], outPerTurn: [180, 340], msPerTurn: [11000, 20000] },
  chain: { turns: [6, 10], inPerTurn: [2400, 3600], outPerTurn: [180, 340], msPerTurn: [12000, 20000] },
  pressure: { turns: [16, 28], inPerTurn: [2600, 4000], outPerTurn: [200, 380], msPerTurn: [13000, 24000] },
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
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {{ experiment: string, seed: number, help: boolean }}
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

function assertExperimentName(experiment) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(experiment)) {
    throw new Error(`experiment must be a plain directory name, got: ${experiment}`)
  }
}

function hexCommit(rng) {
  const digits = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 40; i++) out += digits[randInt(rng, 0, 15)]
  return out
}

function pickResolvedTrials(rng) {
  const out = {}
  for (const task of TASKS) {
    out[task.taskId] = {}
    for (const arm of DEMO_ARMS) {
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
 * Build the forensics fields for one trial's metrics.
 * @param {() => number} rng
 * @param {string} arm
 * @param {boolean} resolved
 * @param {number} checkpoints
 * @param {string} [stratum]
 * @param {number} [turns]
 * @returns {object} forensics metric fields.
 */
function forensicsFields(rng, arm, resolved, checkpoints, stratum, turns) {
  const adaptiveDormant = arm === 'on-adaptive' && (turns ?? 0) < 10 && stratum !== 'pressure' && stratum !== 'long' && stratum !== 'chain'
  const hasJspace = JSPACE_ARMS.has(arm) && !adaptiveDormant
  const hasSq = SQ_ARMS.has(arm)
  const compactionCount = stratum === 'pressure' ? randInt(rng, 1, 3) : (rng() < 0.12 ? 1 : 0)
  return {
    tokensIncludingDescendants: null,
    costIncludingDescendants: null,
    descendantSessions: 0,
    danglingCard: hasJspace ? (!resolved && rng() < 0.3) : null,
    verifiedCheckpointShare: hasJspace && checkpoints > 0
      ? (arm === 'on-sq-verified' ? (resolved ? 1.0 : randInt(rng, 5, 8) / 10) : randInt(rng, 0, 3) / 10)
      : null,
    coverageRefusalThenPad: hasJspace ? (arm === 'on-sq-verified' ? randInt(rng, 0, 1) : randInt(rng, 0, 3)) : 0,
    noopNoteRefusals: hasJspace ? randInt(rng, 0, 2) : 0,
    noteCapRefusals: hasJspace ? randInt(rng, 0, 1) : 0,
    sessionQueryCalls: hasSq ? randInt(rng, 0, 6) : null,
    compactionCount,
    pressureFired: compactionCount > 0,
  }
}

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
      ...forensicsFields(rng, arm, false, 0, stratum, turns),
    }
  }
  const jitter = () => 0.95 + rng() * 0.1
  const adaptiveDormant = arm === 'on-adaptive' && base.turns < 10 && stratum !== 'pressure' && stratum !== 'long'
  const hasJspace = JSPACE_ARMS.has(arm) && !adaptiveDormant
  let inputTokens = Math.round(base.turns * base.inPerTurn * jitter()) + randInt(rng, 0, 200)
  if (hasJspace && stratum === 'short') inputTokens = Math.round(inputTokens * 1.15)
  if (SQ_ARMS.has(arm) && stratum === 'short') inputTokens = Math.round(inputTokens * 1.03)
  const outputTokens = Math.round(base.turns * base.outPerTurn * jitter()) + randInt(rng, 0, 60)
  const durationMs = Math.round(base.turns * base.msPerTurn * jitter()) + randInt(rng, 0, 4000)
  const toolCalls = stratum === 'short' ? base.turns + randInt(rng, 0, 2) : base.turns * 2 + randInt(rng, 0, 3)
  let identicalRetries
  if (!hasJspace) identicalRetries = resolved ? randInt(rng, 0, 2) : randInt(rng, 1, 4)
  else identicalRetries = resolved ? randInt(rng, 0, 1) : randInt(rng, 0, 2)
  identicalRetries = Math.min(identicalRetries, Math.max(toolCalls - 1, 0))
  const checkpoints = hasJspace ? (resolved ? randInt(rng, 1, 3) : randInt(rng, 0, 1)) : 0
  const shipPasses = hasJspace && resolved ? 1 : 0
  return {
    inputTokens, outputTokens, durationMs, turns: base.turns, toolCalls, identicalRetries, checkpoints, shipPasses,
    ...forensicsFields(rng, arm, resolved, checkpoints, stratum, base.turns),
  }
}

function realizeChainPhase(rng, base, arm, phaseIndex, resolved) {
  const jitter = () => 0.95 + rng() * 0.1
  const hasJspace = JSPACE_ARMS.has(arm)
  const carried = hasJspace && phaseIndex > 0
  const turns = carried ? Math.max(2, Math.round(base.turns * 0.75)) : base.turns
  let inputTokens = Math.round(turns * base.inPerTurn * jitter()) + randInt(rng, 0, 200)
  if (carried) inputTokens = Math.round(inputTokens * 0.7)
  const outputTokens = Math.round(turns * base.outPerTurn * jitter()) + randInt(rng, 0, 60)
  const durationMs = Math.round(turns * base.msPerTurn * jitter()) + randInt(rng, 0, 4000)
  const toolCalls = turns * 2 + randInt(rng, 0, 3)
  let identicalRetries
  if (!hasJspace) identicalRetries = resolved ? randInt(rng, 0, 2) : randInt(rng, 1, 3)
  else identicalRetries = resolved ? randInt(rng, 0, 1) : randInt(rng, 0, 2)
  identicalRetries = Math.min(identicalRetries, Math.max(toolCalls - 1, 0))
  const checkpoints = hasJspace ? randInt(rng, 1, 2) : 0
  return {
    inputTokens, outputTokens, durationMs, turns, toolCalls, identicalRetries, checkpoints, shipPasses: 0,
    ...forensicsFields(rng, arm, resolved, checkpoints, 'chain', turns),
  }
}

function sumPhaseMetrics(phases) {
  const total = {
    inputTokens: 0, outputTokens: 0, durationMs: 0, turns: 0, toolCalls: 0,
    identicalRetries: 0, checkpoints: 0, shipPasses: 0,
    tokensIncludingDescendants: null, costIncludingDescendants: null, descendantSessions: 0,
    danglingCard: null, verifiedCheckpointShare: null,
    coverageRefusalThenPad: 0, noopNoteRefusals: 0, noteCapRefusals: 0,
    sessionQueryCalls: null,
    compactionCount: 0,
    pressureFired: false,
  }
  for (const phase of phases) {
    for (const field of ['inputTokens', 'outputTokens', 'durationMs', 'turns', 'toolCalls', 'identicalRetries', 'checkpoints', 'shipPasses', 'coverageRefusalThenPad', 'noopNoteRefusals', 'noteCapRefusals', 'compactionCount']) {
      total[field] += phase.metrics[field]
    }
  }
  const last = phases[phases.length - 1].metrics
  total.danglingCard = last.danglingCard
  total.sessionQueryCalls = last.sessionQueryCalls !== null
    ? phases.reduce((s, p) => s + (p.metrics.sessionQueryCalls ?? 0), 0)
    : null
  const cpShares = phases.map(p => p.metrics.verifiedCheckpointShare).filter(v => v !== null)
  total.verifiedCheckpointShare = cpShares.length > 0 ? cpShares.reduce((a, b) => a + b, 0) / cpShares.length : null
  total.pressureFired = total.compactionCount > 0
  return total
}

function phaseSessionFile(rng, taskId, trialIndex, phaseIndex) {
  const digits = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 8; i += 1) id += digits[randInt(rng, 0, 15)]
  return `sessions/${taskId}/${trialIndex}/phase-${phaseIndex}/--scratch--/${id}/session.jsonl`
}

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
  if (JSPACE_ARMS.has(arm) && resolved) phases[phases.length - 1].metrics.shipPasses = 1
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

function buildTrials(rng, resolvedSets) {
  const trials = []
  let cursor = BASE_TIME
  for (const task of TASKS) {
    for (let i = 0; i < REPEATS; i++) {
      if (task.phases !== undefined) {
        const phaseBases = Array.from({ length: task.phases }, () => drawBase(rng, 'chain'))
        for (const arm of DEMO_ARMS) {
          const resolved = resolvedSets[task.taskId][arm].has(i)
          const built = buildChainTrial(rng, task, i, arm, resolved, phaseBases, cursor)
          trials.push(built.trial)
          cursor = built.cursor + randInt(rng, 5, 25) * 1000
        }
        continue
      }
      const base = drawBase(rng, task.stratum)
      for (const arm of DEMO_ARMS) {
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
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    tierPatches: [],
    startedAt: armTrials[0].startedAt,
    endedAt: armTrials[armTrials.length - 1].endedAt,
  }
}

/**
 * @typedef {object} GenerateOptions
 * @property {string} runsRoot
 * @property {string} [experiment]
 * @property {number} [seed]
 */

/**
 * @typedef {object} GenerateResult
 * @property {string} experiment
 * @property {string} dir
 * @property {string[]} arms
 * @property {number} repeats
 * @property {import('../schema/trial.js').Trial[]} trials
 */

/**
 * Generate a complete synthetic experiment.
 * @param {GenerateOptions} options
 * @returns {Promise<GenerateResult>}
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
  const perArm = DEMO_ARMS.map(arm => ({
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
  return { experiment, dir: expDir, arms: [...DEMO_ARMS], repeats: REPEATS, trials }
}

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
    const long = live.filter(t => ['multi-file-rename', 'cross-module-refactor', 'config-migration', 'chain-data-pipeline', 'compaction-stress-constraints'].includes(t.taskId))
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
