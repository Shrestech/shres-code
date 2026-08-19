/**
 * Bench runner CLI: execute the task catalog against the real harness, once
 * per arm, interleaved per (task, trial) so provider drift cannot confound the
 * toggle (protocol rule 1).
 *
 * ```
 * node bench/runner/run.js --experiment w0-2026-08-18 [--arms off,on] [--repeats 3] [--tasks globs] [--dry-run]
 * ```
 *
 * Per trial the runner copies the fixture into a fresh scratch dir, writes the
 * arm's `--patch` overlay (jspace toggle + per-trial session-log root), spawns
 * the headless profile, folds the session log into metrics, runs the verifier,
 * and appends one validated Trial to `trials.jsonl`. `run.json` is written
 * before the first trial (endedAt empty) and completed at the end, so a crash
 * keeps every finished trial.
 *
 * Chain tasks (`phases` in task.json) run one scratch dir but one spawn per
 * phase, each with a fresh session root (`sessions/<taskId>/<trial>/phase-<i>`):
 * the session boundary is the experiment. Today every phase starts cold —
 * `resumedFrom` stays null until the harness grows a headless resume/fork. A
 * phase that ends in PROVIDER_ERROR or HARNESS_ERROR aborts the chain; the
 * verifier runs once, after the final phase, on the carried workspace.
 *
 * Every trial passes an arm-integrity audit: no session root may pre-exist
 * (leakage from a previous trial), and the off arm's logs must contain zero
 * `jspace/` events (overlay leakage). Violations land on `trial.integrity`;
 * the trial is still recorded and the experiment never aborts.
 *
 * Status policy: `error` is reserved for infrastructure noise that must not
 * count against the pass rate — PROVIDER_ERROR (provider failure signature in
 * output) and HARNESS_ERROR (crash without a session log, or a missing log
 * after a clean exit, which would corrupt token means with a zero row).
 * Agent timeouts still run the verifier and stay status `success` with
 * failureMode AGENT_TIMEOUT when unresolved: the task's time budget is part of
 * the task. A nonzero exit with a session log is an incomplete turn — a valid
 * attempt the verifier judges. One failed trial never aborts the experiment.
 *
 * @module bench/runner/run
 */

import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getArm, listArms, renderArmOverlay } from './arms.js'
import { executeTrial } from './execute.js'
import { emptyMetrics, foldSessionLog } from './metrics.js'
import { runVerifier } from './verify.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateTrial } from '../schema/trial.js'

const execFileAsync = promisify(execFile)

const USAGE = `Usage: node bench/runner/run.js --experiment <name> [options]

Options:
  --experiment <name>   experiment directory under bench/runs/ (required)
  --arms <a,b>          arms to run, comma-separated (default: ${listArms().join(',')})
  --repeats <n>         trials per task per arm (default: 3)
  --tasks <globs>       task-id filter; * and ? wildcards, comma-separated (default: all)
  --model <id>          model pin for run.json (default: $BENCH_MODEL or deepseek-v4-flash)
  --provider <id>       provider pin, patched into agent-default-model (default: $BENCH_PROVIDER or deepseek-official)
  --base-url <url>      provider base URL pin (default: $DEEPSEEK_BASE_URL or null)
  --context-window <n>  harness-side context-window pin (ollama-cloud only); forces real compaction when small
  --dry-run             print the plan and exit without writing or executing
  --help                this text
`

/** Exit code for usage and environment errors (bad flags, missing API key). */
const EXIT_USAGE = 2

/** Default model pin, overridable by flag or env; recorded in run.json. */
const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Default provider pin; the overlay re-pins `agent-default-model` to it. */
const DEFAULT_PROVIDER = 'deepseek-official'

/**
 * Credential environment variable each non-default provider resolves, per the
 * provider rows in `packages/bundle/base/cordis.patch.yml` (`apiKeyEnv`).
 * Providers absent here resolve `DEEPSEEK_API_KEY`.
 */
const PROVIDER_KEY_ENV = Object.freeze({ 'ollama-cloud': 'OLLAMA_API_KEY' })

/**
 * Provider-failure signature matched against captured output. Heuristic by
 * nature; a false positive costs one excluded trial, a false negative turns
 * provider noise into a VERIFY_FAILED row.
 */
const PROVIDER_ERROR_PATTERN =
  /deepseek|rate.?limit|too many requests|\b40[13]\b|\b429\b|\b5\d\d\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|provider/i

/**
 * CLI usage error, printed without a stack.
 */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * @typedef {object} RunnerOptions
 * @property {string} experiment
 * @property {string[]} arms
 * @property {number} repeats
 * @property {string | null} taskGlob
 * @property {boolean} dryRun
 * @property {boolean} help
 * @property {string | undefined} model
 * @property {string | undefined} provider
 * @property {string | undefined} baseUrl
 */

/**
 * Parse CLI arguments. Throws UsageError on anything malformed.
 * @param {string[]} argv - arguments after `node run.js`.
 * @returns {RunnerOptions} parsed options.
 */
export function parseArgs(argv) {
  /** @type {RunnerOptions} */
  const options = {
    experiment: '',
    arms: listArms(),
    repeats: 3,
    taskGlob: null,
    dryRun: false,
    help: false,
    model: undefined,
    provider: undefined,
    baseUrl: undefined,
    contextWindow: undefined,
  }
  let armsSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError(`${flag} needs a value`)
      index += 1
      return next
    }
    switch (flag) {
      case '--help':
        options.help = true
        break
      case '--experiment':
        options.experiment = value()
        break
      case '--arms':
        if (armsSeen) throw new UsageError('--arms given twice')
        armsSeen = true
        options.arms = value().split(',').map(name => {
          const trimmed = name.trim()
          getArm(trimmed)
          return trimmed
        })
        break
      case '--repeats': {
        const parsed = Number(value())
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError('--repeats must be a positive integer')
        options.repeats = parsed
        break
      }
      case '--tasks':
        options.taskGlob = value()
        break
      case '--model':
        options.model = value()
        break
      case '--provider':
        options.provider = value()
        break
      case '--base-url':
        options.baseUrl = value()
        break
      case '--context-window': {
        const parsed = Number(value())
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError('--context-window must be a positive integer')
        options.contextWindow = parsed
        break
      }
      case '--dry-run':
        options.dryRun = true
        break
      default:
        throw new UsageError(`unknown argument "${flag}"`)
    }
  }
  if (options.help) return options
  if (options.experiment === '') throw new UsageError('--experiment is required')
  if (options.experiment.includes('/') || options.experiment.includes('\\')) {
    throw new UsageError('--experiment must be a plain directory name')
  }
  return options
}

/**
 * Filter task ids by `*`/`?` globs; a comma separates alternative globs.
 * Null keeps the whole catalog.
 * @param {string[]} taskIds - catalog ids.
 * @param {string | null} glob - the `--tasks` pattern(s).
 * @returns {string[]} matching ids, catalog order preserved.
 */
export function matchTaskIds(taskIds, glob) {
  if (glob === null) return taskIds
  const patterns = glob.split(',').map((part) => {
    const source = part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
    return new RegExp(`^${source}$`)
  })
  return taskIds.filter(id => patterns.some(pattern => pattern.test(id)))
}

/**
 * @typedef {object} PlanEntry
 * @property {string} taskId
 * @property {number} trialIndex
 * @property {string} arm
 */

/**
 * Build the interleaved execution plan. Each (task, trial) pair remains
 * adjacent, while two-arm experiments use ABBA order across each four-repeat
 * block so provider drift does not always favor the first arm.
 * @param {{ taskIds: string[], arms: string[], repeats: number }} options
 * @returns {PlanEntry[]} plan in execution order.
 */
export function buildPlan({ taskIds, arms, repeats }) {
  /** @type {PlanEntry[]} */
  const plan = []
  for (const taskId of taskIds) {
    for (let trialIndex = 0; trialIndex < repeats; trialIndex += 1) {
      const reverse = arms.length === 2 && (trialIndex % 4 === 1 || trialIndex % 4 === 2)
      const ordered = reverse ? [...arms].reverse() : arms
      for (const arm of ordered) plan.push({ taskId, trialIndex, arm })
    }
  }
  return plan
}

/**
 * Decide whether a failed run's captured output points at the provider.
 * @param {string} stdout - captured stdout.
 * @param {string} stderr - captured stderr.
 * @returns {boolean} true when the failure signature matches.
 */
export function looksLikeProviderError(stdout, stderr) {
  return PROVIDER_ERROR_PATTERN.test(stderr) || PROVIDER_ERROR_PATTERN.test(stdout)
}

/**
 * @typedef {object} TaskPhase
 * @property {string} instruction - the phase prompt.
 * @property {number | null} timeoutMs - per-phase timeout override; null defers to the task's `timeoutMs`.
 */

/**
 * @typedef {object} TaskDefinition
 * @property {string} taskId
 * @property {string | null} instruction - single-session prompt; null on chain tasks.
 * @property {TaskPhase[] | null} phases - chain phases (at least 2); null on single-session
 *   tasks. Exactly one of `instruction`/`phases` is non-null.
 * @property {string} verify
 * @property {number} timeoutMs - per-spawn timeout; the per-phase default on chains.
 * @property {string} dir - absolute task directory.
 */

/**
 * Load the task catalog from bench/tasks. Authoring errors (missing fixture,
 * instruction, or verify command; malformed chain phases) fail the run before
 * any trial starts.
 * @param {string} tasksRoot - absolute bench/tasks path.
 * @returns {Promise<TaskDefinition[]>} tasks in sorted directory order.
 */
export async function loadTaskCatalog(tasksRoot) {
  const entries = await readdir(tasksRoot, { withFileTypes: true })
  /** @type {TaskDefinition[]} */
  const tasks = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(tasksRoot, entry.name)
    /** @type {Record<string, unknown>} */
    let definition
    try {
      definition = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'))
    } catch (error) {
      throw new Error(`task ${entry.name}: cannot read task.json: ${/** @type {Error} */ (error).message}`)
    }
    if (definition.taskId !== entry.name) {
      throw new Error(`task ${entry.name}: task.json taskId must equal the directory name`)
    }
    /** @type {string | null} */
    let instruction = null
    /** @type {TaskPhase[] | null} */
    let phases = null
    if (definition.phases !== undefined) {
      if (definition.instruction !== undefined) {
        throw new Error(`task ${entry.name}: task.json instruction is not allowed when phases is present`)
      }
      if (!Array.isArray(definition.phases) || definition.phases.length < 2) {
        throw new Error(`task ${entry.name}: task.json phases must be an array of at least 2 phases`)
      }
      phases = definition.phases.map((phase, index) => {
        const p = /** @type {Record<string, unknown>} */ (phase)
        if (typeof p !== 'object' || p === null || Array.isArray(p)) {
          throw new Error(`task ${entry.name}: task.json phases[${index}] must be a record`)
        }
        if (typeof p.instruction !== 'string' || p.instruction.trim() === '') {
          throw new Error(`task ${entry.name}: task.json phases[${index}].instruction must be a non-empty string`)
        }
        if (p.timeoutMs !== undefined && (!Number.isSafeInteger(p.timeoutMs) || /** @type {number} */ (p.timeoutMs) < 1)) {
          throw new Error(`task ${entry.name}: task.json phases[${index}].timeoutMs must be a positive integer`)
        }
        return { instruction: p.instruction, timeoutMs: p.timeoutMs === undefined ? null : /** @type {number} */ (p.timeoutMs) }
      })
    } else {
      if (typeof definition.instruction !== 'string' || definition.instruction.trim() === '') {
        throw new Error(`task ${entry.name}: task.json instruction must be a non-empty string`)
      }
      instruction = definition.instruction
    }
    if (typeof definition.verify !== 'string' || definition.verify.trim() === '') {
      throw new Error(`task ${entry.name}: task.json verify must be a non-empty string`)
    }
    if (!Number.isSafeInteger(definition.timeoutMs) || /** @type {number} */ (definition.timeoutMs) < 1) {
      throw new Error(`task ${entry.name}: task.json timeoutMs must be a positive integer`)
    }
    try {
      await readdir(join(dir, 'fixture'))
    } catch {
      throw new Error(`task ${entry.name}: missing fixture/ directory`)
    }
    tasks.push({
      taskId: entry.name,
      instruction,
      phases,
      verify: definition.verify,
      timeoutMs: /** @type {number} */ (definition.timeoutMs),
      dir,
    })
  }
  return tasks
}

/**
 * The harness commit the experiment runs against; 'unknown' outside a git repo.
 * @param {string} repoRoot - absolute repository root.
 * @returns {Promise<string>} the HEAD commit hash.
 */
async function resolveGitCommit(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    return stdout.trim()
  } catch {
    // A source snapshot without .git still runs; the manifest records the gap.
    return 'unknown'
  }
}

/**
 * @typedef {'ran' | 'timeout' | 'provider-error' | 'harness-error'} SpawnOutcome
 */

/**
 * Classify one finished harness spawn. A timeout is a valid attempt the
 * verifier still judges — the task's time budget is part of the task. Provider
 * and harness failures are infrastructure noise: they exclude the trial from
 * the pass rate and abort a chain before its remaining phases.
 * @param {import('./execute.js').ExecutionResult} execution - the finished spawn.
 * @returns {SpawnOutcome} the classification.
 */
function classifySpawn(execution) {
  if (execution.timedOut) return 'timeout'
  if (execution.exitCode !== 0 && looksLikeProviderError(execution.stdout, execution.stderr)) return 'provider-error'
  if (execution.sessionLogPath === null) return 'harness-error'
  return 'ran'
}

/**
 * Verifier-skip detail for a spawn that ended in infrastructure failure.
 * @param {'provider-error' | 'harness-error'} outcome - the failure classification.
 * @param {import('./execute.js').ExecutionResult} execution - the failed spawn.
 * @param {string} [where] - chain phase suffix, e.g. ` in phase 1`.
 * @returns {string} the verifier record's detail.
 */
function spawnFailureDetail(outcome, execution, where = '') {
  const agentExit = `agent exit ${execution.exitCode ?? 'signal'}`
  if (outcome === 'provider-error') return `not run: provider error${where} (${agentExit})`
  // Two roads here: a nonzero exit that never logged (harness died), or a clean
  // exit without a log (persistence broke — a zero-token row would corrupt
  // token means, so the trial is excluded either way).
  return execution.exitCode === 0
    ? `not run: session log missing after a clean exit${where}`
    : `not run: harness died before logging${where} (${agentExit})`
}

/**
 * Execute one harness spawn — a whole single-session trial or one chain phase —
 * and fold its session log into metrics.
 * @param {object} options
 * @param {string} options.repoRoot - harness repository root.
 * @param {{ name: string, jspace: Record<string, unknown> }} options.arm - the arm entry.
 * @param {string} options.armDir - the arm's output directory (sessionFile is relative to it).
 * @param {string} options.sessionLogRoot - per-spawn persistence root; the overlay lands here too.
 * @param {{ provider: string, model: string, contextWindow?: number }} options.route - the provider/model pinned into the overlay's agent-default-model row, plus an optional context-window pin.
 * @param {string} options.taskText - the prompt for this spawn.
 * @param {string} options.scratchDir - trial scratch dir; becomes the child cwd.
 * @param {number} options.timeoutMs - spawn timeout.
 * @param {NodeJS.ProcessEnv} options.env - child environment.
 * @returns {Promise<{ execution: import('./execute.js').ExecutionResult, metrics: import('../schema/trial.js').TrialMetrics, sessionFile: string | null }>}
 */
async function executeSpawn({ repoRoot, arm, armDir, sessionLogRoot, route, taskText, scratchDir, timeoutMs, env }) {
  await mkdir(sessionLogRoot, { recursive: true })
  const overlayPath = join(sessionLogRoot, 'arm-overlay.yml')
  await writeFile(overlayPath, renderArmOverlay(arm, { sessionLogRoot, ...route }))
  const execution = await executeTrial({ repoRoot, overlayPath, taskText, scratchDir, sessionLogRoot, timeoutMs, env })
  const metrics = execution.sessionLogPath === null
    ? emptyMetrics()
    : foldSessionLog(await readFile(execution.sessionLogPath, 'utf8'))
  metrics.durationMs = execution.durationMs
  const sessionFile = execution.sessionLogPath === null
    ? null
    : relative(armDir, execution.sessionLogPath).split(sep).join('/')
  return { execution, metrics, sessionFile }
}

/**
 * Sum per-phase metrics into the trial-level row.
 * @param {import('../schema/trial.js').PhaseRecord[]} phases - completed phases.
 * @returns {import('../schema/trial.js').TrialMetrics} field-wise sums.
 */
function sumPhaseMetrics(phases) {
  const total = emptyMetrics()
  for (const phase of phases) {
    for (const field of /** @type {(keyof import('../schema/trial.js').TrialMetrics)[]} */ (Object.keys(total))) {
      total[field] += phase.metrics[field]
    }
  }
  return total
}

/**
 * Shared per-trial record fields and the verifier-skip record factory.
 * @param {TaskDefinition} task - the task under trial.
 * @param {PlanEntry} entry - the plan entry.
 * @param {string} scratchDir - trial scratch dir.
 * @param {string} startedAt - trial start, ISO 8601.
 * @returns {{ base: object, skippedVerifier: (detail: string) => { command: string, exitCode: number, detail: string } }}
 */
function trialRecordFrame(task, entry, scratchDir, startedAt) {
  return {
    base: { taskId: entry.taskId, trialIndex: entry.trialIndex, arm: entry.arm, startedAt },
    skippedVerifier: detail => ({ command: `${task.verify} ${scratchDir}`, exitCode: -1, detail }),
  }
}

/**
 * Run one single-session trial: one spawn, then the verifier unless the spawn
 * was infrastructure noise.
 * @param {object} options
 * @param {TaskDefinition} options.task - the task under trial.
 * @param {PlanEntry} options.entry - the plan entry.
 * @param {{ name: string, jspace: Record<string, unknown> }} options.arm - the arm entry.
 * @param {string} options.armDir - the arm's output directory.
 * @param {string} options.scratchDir - prepared trial scratch dir (fixture already copied).
 * @param {string} options.sessionLogRoot - per-trial persistence root.
 * @param {string} options.repoRoot - harness repository root.
 * @param {{ provider: string, model: string, contextWindow?: number }} options.route - the pinned provider/model route, plus an optional context-window pin.
 * @param {NodeJS.ProcessEnv} options.env - child environment.
 * @param {string} options.startedAt - trial start, ISO 8601.
 * @returns {Promise<import('../schema/trial.js').Trial>} the trial record (pre-audit).
 */
async function runSingleSessionTrial({ task, entry, arm, armDir, scratchDir, sessionLogRoot, repoRoot, route, env, startedAt }) {
  const { base, skippedVerifier } = trialRecordFrame(task, entry, scratchDir, startedAt)
  const { execution, metrics, sessionFile } = await executeSpawn({
    repoRoot,
    arm,
    armDir,
    sessionLogRoot,
    route,
    taskText: /** @type {string} */ (task.instruction),
    scratchDir,
    timeoutMs: task.timeoutMs,
    env,
  })
  const outcome = classifySpawn(execution)
  const endedAt = new Date().toISOString()
  if (outcome === 'provider-error' || outcome === 'harness-error') {
    return {
      ...base,
      status: 'error',
      resolved: false,
      failureMode: outcome === 'provider-error' ? 'PROVIDER_ERROR' : 'HARNESS_ERROR',
      verifier: skippedVerifier(spawnFailureDetail(outcome, execution)),
      metrics,
      sessionFile,
      endedAt,
    }
  }
  // A nonzero exit with a log is an incomplete turn: a valid attempt.
  const verifier = await runVerifier({ taskDir: task.dir, verify: task.verify, scratchDir })
  return {
    ...base,
    status: 'success',
    resolved: verifier.resolved,
    failureMode: verifier.resolved ? null : outcome === 'timeout' ? 'AGENT_TIMEOUT' : verifier.failureMode,
    verifier,
    metrics,
    sessionFile,
    endedAt,
  }
}

/**
 * Run one chain trial: one scratch dir, one spawn per phase with a fresh
 * session root each (cold carry). PROVIDER_ERROR/HARNESS_ERROR aborts the
 * chain with the phases completed so far; otherwise the verifier runs once on
 * the final workspace.
 * @param {object} options
 * @param {TaskDefinition} options.task - the chain task under trial (`phases` non-null).
 * @param {PlanEntry} options.entry - the plan entry.
 * @param {{ name: string, jspace: Record<string, unknown> }} options.arm - the arm entry.
 * @param {string} options.armDir - the arm's output directory.
 * @param {string} options.scratchDir - prepared trial scratch dir (fixture already copied).
 * @param {string} options.sessionRoot - per-trial session root; phase roots are `phase-<i>` below it.
 * @param {string} options.repoRoot - harness repository root.
 * @param {{ provider: string, model: string, contextWindow?: number }} options.route - the pinned provider/model route, plus an optional context-window pin.
 * @param {NodeJS.ProcessEnv} options.env - child environment.
 * @param {string} options.startedAt - trial start, ISO 8601.
 * @param {import('../schema/trial.js').PhaseRecord[]} options.phases - shared sink: completed
 *   phase records are pushed here so a mid-chain runner failure keeps the evidence.
 * @returns {Promise<import('../schema/trial.js').Trial>} the trial record (pre-audit).
 */
async function runChainTrial({ task, entry, arm, armDir, scratchDir, sessionRoot, repoRoot, route, env, startedAt, phases }) {
  const { base, skippedVerifier } = trialRecordFrame(task, entry, scratchDir, startedAt)
  const definitions = /** @type {TaskPhase[]} */ (task.phases)
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]
    const phaseStartedAt = new Date().toISOString()
    const { execution, metrics, sessionFile } = await executeSpawn({
      repoRoot,
      arm,
      armDir,
      sessionLogRoot: join(sessionRoot, `phase-${index}`),
      route,
      taskText: definition.instruction,
      scratchDir,
      timeoutMs: definition.timeoutMs ?? task.timeoutMs,
      env,
    })
    phases.push({
      phaseIndex: index,
      sessionFile,
      resumedFrom: null,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      metrics,
      startedAt: phaseStartedAt,
      endedAt: new Date().toISOString(),
    })
    const outcome = classifySpawn(execution)
    if (outcome === 'provider-error' || outcome === 'harness-error') {
      return {
        ...base,
        status: 'error',
        resolved: false,
        failureMode: outcome === 'provider-error' ? 'PROVIDER_ERROR' : 'HARNESS_ERROR',
        verifier: skippedVerifier(spawnFailureDetail(outcome, execution, ` in phase ${index}`)),
        metrics: sumPhaseMetrics(phases),
        sessionFile: phases.at(-1).sessionFile,
        phases: [...phases],
        endedAt: new Date().toISOString(),
      }
    }
  }
  const verifier = await runVerifier({ taskDir: task.dir, verify: task.verify, scratchDir })
  const anyPhaseTimedOut = phases.some(phase => phase.timedOut)
  return {
    ...base,
    status: 'success',
    resolved: verifier.resolved,
    failureMode: verifier.resolved ? null : anyPhaseTimedOut ? 'AGENT_TIMEOUT' : verifier.failureMode,
    verifier,
    metrics: sumPhaseMetrics(phases),
    sessionFile: /** @type {string | null} */ (phases.at(-1).sessionFile),
    phases: [...phases],
    endedAt: new Date().toISOString(),
  }
}

/**
 * Scan one session log for jspace events — off-arm proof of overlay leakage.
 * The metrics fold has already read this file, so its lines parse.
 * @param {string} sessionLogPath - absolute session.jsonl path.
 * @returns {Promise<string[]>} distinct `jspace/` event types in first-seen order.
 */
async function findJspaceEventTypes(sessionLogPath) {
  const text = await readFile(sessionLogPath, 'utf8')
  /** @type {string[]} */
  const types = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const event = /** @type {{ type?: unknown }} */ (JSON.parse(line))
    if (typeof event.type === 'string' && event.type.startsWith('jspace/') && !types.includes(event.type)) {
      types.push(event.type)
    }
  }
  return types
}

/**
 * @typedef {object} RunnerIo - injectable environment for tests.
 * @property {string} [benchRoot] - absolute bench directory (default: this repo's bench/).
 * @property {NodeJS.ProcessEnv} [env] - environment (default: process.env).
 * @property {(line: string) => void} [print] - plan/progress sink (default: console.log).
 */

/**
 * Run the experiment (or, with --dry-run, print the plan).
 * @param {string[]} argv - arguments after `node run.js`.
 * @param {RunnerIo} [io] - injectable environment.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv, io = {}) {
  const options = parseArgs(argv)
  const env = io.env ?? process.env
  const print = io.print ?? (line => console.log(line))
  if (options.help) {
    print(USAGE)
    return 0
  }
  const benchRoot = resolve(io.benchRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const repoRoot = dirname(benchRoot)

  const catalog = await loadTaskCatalog(join(benchRoot, 'tasks'))
  const taskIds = matchTaskIds(catalog.map(task => task.taskId), options.taskGlob)
  if (taskIds.length === 0) throw new UsageError(`no tasks match ${options.taskGlob ?? '(empty catalog)'}`)
  const tasks = new Map(catalog.filter(task => taskIds.includes(task.taskId)).map(task => [task.taskId, task]))
  const model = options.model ?? env.BENCH_MODEL ?? DEFAULT_MODEL
  const provider = options.provider ?? env.BENCH_PROVIDER ?? DEFAULT_PROVIDER
  if (options.contextWindow !== undefined && provider !== 'ollama-cloud') {
    throw new UsageError(`--context-window cannot be pinned for provider "${provider}" (only ollama-cloud is reproducible in the overlay)`)
  }
  const route = {
    provider,
    model,
    ...options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow },
  }
  const baseUrl = options.baseUrl ?? env.DEEPSEEK_BASE_URL ?? null
  const plan = buildPlan({ taskIds, arms: options.arms, repeats: options.repeats })

  if (options.dryRun) {
    print(`experiment: ${options.experiment}`)
    print(`provider: ${provider}  model: ${model}  baseUrl: ${baseUrl ?? '(provider default)'}  contextWindow: ${options.contextWindow ?? '(shipped pin)'}`)
    print(`tasks: ${taskIds.join(', ')}`)
    print(`plan: ${plan.length} trials (${taskIds.length} tasks × ${options.repeats} repeats × ${options.arms.length} arms)`)
    for (const entry of plan) {
      const task = /** @type {TaskDefinition} */ (tasks.get(entry.taskId))
      const suffix = task.phases === null ? '' : ` (${task.phases.length} phases)`
      print(`  ${entry.taskId} #${entry.trialIndex} [${entry.arm}]${suffix}`)
    }
    return 0
  }

  const keyEnv = PROVIDER_KEY_ENV[provider] ?? 'DEEPSEEK_API_KEY'
  if (typeof env[keyEnv] !== 'string' || env[keyEnv] === '') {
    throw new UsageError(`${keyEnv} is required for real runs with provider "${provider}" (or use --dry-run)`)
  }

  const experimentDir = join(benchRoot, 'runs', options.experiment)
  const shresHome = join(experimentDir, '.shres-home')
  const gitCommit = await resolveGitCommit(repoRoot)
  const startedAt = new Date().toISOString()

  const armDirs = new Map()
  for (const armName of options.arms) {
    const armDir = join(experimentDir, armName)
    const manifest = {
      version: 1,
      experiment: options.experiment,
      arm: armName,
      armConfig: getArm(armName).jspace,
      provider,
      model,
      baseUrl,
      contextWindow: options.contextWindow ?? null,
      repeats: options.repeats,
      taskIds,
      gitCommit,
      startedAt,
      endedAt: '',
    }
    validateRunManifest(manifest)
    await mkdir(armDir, { recursive: true })
    try {
      await writeFile(join(armDir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    } catch {
      throw new UsageError(
        `experiment "${options.experiment}" already has a manifest for arm "${armName}"; a changed run is a new experiment name`,
      )
    }
    armDirs.set(armName, armDir)
  }

  let finished = 0
  let failed = 0
  for (const entry of plan) {
    const task = /** @type {TaskDefinition} */ (tasks.get(entry.taskId))
    const arm = getArm(entry.arm)
    const armDir = /** @type {string} */ (armDirs.get(entry.arm))
    const scratchDir = join(experimentDir, 'scratch', entry.arm, entry.taskId, String(entry.trialIndex))
    const sessionRoot = join(armDir, 'sessions', entry.taskId, String(entry.trialIndex))
    const trialStartedAt = new Date().toISOString()
    // SHRES_SHIELD=off: trials measure model+jspace capability inside a
    // throwaway scratch dir, not the paid shield payload. In headless
    // compositions the shield's `ask` posture fail-closes (no approval
    // channel), and its tool_args shape heuristics false-positive on ordinary
    // bench paths, silently denying every tool call (smoke: w0-smoke-ollama).
    const trialEnv = { ...env, SHRES_HOME: shresHome, SHRES_SHIELD: 'off' }

    // Integrity audit, part 1: none of this trial's session roots may
    // pre-exist — a leftover root means leakage from a previous trial.
    /** @type {string[]} */
    const violations = []
    const phaseRoots = task.phases === null
      ? [sessionRoot]
      : task.phases.map((_, index) => join(sessionRoot, `phase-${index}`))
    for (const root of phaseRoots) {
      if (existsSync(root)) {
        violations.push(`session-root-preexisting:${relative(armDir, root).split(sep).join('/')}`)
      }
    }

    // The scratch dir is created once per trial; a chain's workspace carries
    // across its phases while sessions do not.
    await rm(scratchDir, { recursive: true, force: true })
    await mkdir(scratchDir, { recursive: true })
    await cp(join(task.dir, 'fixture'), scratchDir, { recursive: true })

    /** @type {import('../schema/trial.js').Trial} */
    let trial
    /** @type {import('../schema/trial.js').PhaseRecord[] | undefined} */
    let chainPhases
    try {
      if (task.phases === null) {
        trial = await runSingleSessionTrial({
          task, entry, arm, armDir, scratchDir,
          sessionLogRoot: sessionRoot,
          repoRoot, route, env: trialEnv, startedAt: trialStartedAt,
        })
      } else {
        chainPhases = []
        trial = await runChainTrial({
          task, entry, arm, armDir, scratchDir,
          sessionRoot,
          repoRoot, route, env: trialEnv, startedAt: trialStartedAt,
          phases: chainPhases,
        })
      }
    } catch (error) {
      const partial = chainPhases !== undefined && chainPhases.length > 0 ? chainPhases : undefined
      trial = {
        taskId: entry.taskId,
        trialIndex: entry.trialIndex,
        arm: entry.arm,
        startedAt: trialStartedAt,
        status: 'error',
        resolved: false,
        failureMode: 'HARNESS_ERROR',
        verifier: {
          command: `${task.verify} ${scratchDir}`,
          exitCode: -1,
          detail: `runner failure: ${/** @type {Error} */ (error).message}`.slice(0, 200),
        },
        metrics: partial === undefined ? emptyMetrics() : sumPhaseMetrics(partial),
        sessionFile: partial?.at(-1)?.sessionFile ?? null,
        ...(partial === undefined ? {} : { phases: [...partial] }),
        endedAt: new Date().toISOString(),
      }
    }

    // Integrity audit, part 2: the off arm must log zero jspace events.
    if (arm.name === 'off') {
      const sessionFiles = (trial.phases ?? [{ sessionFile: trial.sessionFile }])
        .map(record => record.sessionFile)
        .filter(file => file !== null)
      for (const file of sessionFiles) {
        for (const type of await findJspaceEventTypes(join(armDir, file))) {
          violations.push(`off-arm-jspace-event:${type}`)
        }
      }
    }
    if (violations.length > 0) trial.integrity = { violations }

    validateTrial(trial)
    await appendFile(join(armDir, 'trials.jsonl'), `${JSON.stringify(trial)}\n`)
    if (trial.status === 'error') failed += 1
    else finished += 1
    print(
      `[${options.experiment}] ${entry.taskId} #${entry.trialIndex} [${entry.arm}] `
      + `${trial.status}${trial.resolved ? ' resolved' : ''}${trial.failureMode ? ` ${trial.failureMode}` : ''}`,
    )
  }

  const endedAt = new Date().toISOString()
  for (const armName of options.arms) {
    const armDir = /** @type {string} */ (armDirs.get(armName))
    const manifestPath = join(armDir, 'run.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.endedAt = endedAt
    validateRunManifest(manifest)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  print(`[${options.experiment}] done: ${finished} completed, ${failed} infrastructure errors`)
  return failed === plan.length ? 1 : 0
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code
    },
    error => {
      if (error instanceof UsageError) {
        console.error(error.message)
        process.exitCode = EXIT_USAGE
      } else {
        console.error(error)
        process.exitCode = 1
      }
    },
  )
}
