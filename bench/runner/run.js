/**
 * Bench runner CLI: execute the task catalog against the real harness, once
 * per arm, interleaved per (task, trial) so provider drift cannot confound the
 * toggle (protocol rule 1).
 *
 * ```
 * node bench/runner/run.js --experiment w0-2026-08-18 [--arms off,on] [--repeats 3] [--concurrency 1] [--tasks glob[,glob]] [--dry-run]
 * ```
 *
 * Per trial the runner copies the fixture into a fresh scratch dir, runs an
 * optional task `setup` (used to plant a prior session into the persistence
 * root), writes the arm's `--patch` overlay, spawns the headless profile,
 * folds the session log into metrics, runs the verifier, and appends one
 * validated Trial to `trials.jsonl`. `--concurrency <n>` (default 1) runs up
 * to n plan entries at once; 1 is sequential. Concurrent completions share
 * one in-process writer so each JSONL line is whole. `run.json` is written
 * before the first trial (endedAt empty) and completed at the end, so a crash
 * keeps every finished trial. SIGINT/SIGTERM abort in-flight children, skip
 * `endedAt`, and leave already-appended lines intact.
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
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getArm, listArms, renderArmOverlay } from './arms.js'
import { executeTrial } from './execute.js'
import { emptyMetrics, foldSessionLog } from './metrics.js'
import { descendantUsage } from './descendants.js'
import { createSerialQueue, mapPool } from './pool.js'
import { runSetup } from './setup.js'
import { runVerifier } from './verify.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateTrial } from '../schema/trial.js'

const execFileAsync = promisify(execFile)

const USAGE = `Usage: node bench/runner/run.js --experiment <name> [options]

Options:
  --experiment <name>   experiment directory under bench/runs/ (required)
  --arms <a,b>          arms to run, comma-separated (default: ${listArms().join(',')})
  --repeats <n>         trials per task per arm (default: 3)
  --tasks <glob[,glob]> task-id filter; comma-separated * / ? globs; match is union (default: all)
  --model <id>          model pin for run.json (default: $BENCH_MODEL or deepseek-v4-flash)
  --temperature <t>     temperature pin for run.json (default: $BENCH_TEMPERATURE or 1)
  --base-url <url>      provider base URL pin (default: $DEEPSEEK_BASE_URL when --api-key-env is DEEPSEEK_API_KEY, null otherwise)
  --api-key-env <VAR>   env var name for the API key; 'none' for keyless tiers (default: DEEPSEEK_API_KEY).
                        An unset variable falls back to the harness credential store
                        ($SHRES_HOME/.credentials.yaml, default ~/.shres); the value is injected
                        into the child environment only, never into any bench record.
  --tier-patch <path>   experiment-level overlay applied after the arm overlay; repeatable, order preserved
  --concurrency <n>     max trials in flight (default: 1; 1 is sequential)
  --max-total-tokens <n>  live token cap per trial: observed root+descendant usage
                        above the cap terminates the trial as BUDGET_EXCEEDED
  --dry-run             print the plan and exit without writing or executing
  --help                this text
`

/** Exit code for usage and environment errors (bad flags, missing API key). */
const EXIT_USAGE = 2

/** Exit code when SIGINT/SIGTERM abort the run after in-flight trials drain. */
const EXIT_ABORTED = 130

/** Default model/temperature pins, overridable by flag or env; recorded in run.json. */
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_TEMPERATURE = 1

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
 * @property {number | undefined} temperature
 * @property {string | undefined} baseUrl
 * @property {string} apiKeyEnv - env var name; `none` for keyless tiers.
 * @property {string[]} tierPatches - overlay paths in given order; empty when unused.
 * @property {number} concurrency - max trials in flight; 1 is sequential.
 * @property {number} [maxTotalTokens] - live per-trial token cap; a spawn whose observed
 *   root+descendant usage exceeds it is terminated and recorded `BUDGET_EXCEEDED`.
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
    temperature: undefined,
    baseUrl: undefined,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    tierPatches: [],
    concurrency: 1,
    maxTotalTokens: undefined,
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
      case '--temperature': {
        const parsed = Number(value())
        if (!Number.isFinite(parsed)) throw new UsageError('--temperature must be a number')
        options.temperature = parsed
        break
      }
      case '--base-url':
        options.baseUrl = value()
        break
      case '--api-key-env':
        options.apiKeyEnv = value()
        break
      case '--tier-patch':
        options.tierPatches.push(value())
        break
      case '--concurrency': {
        const parsed = Number(value())
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError('--concurrency must be an integer >= 1')
        options.concurrency = parsed
        break
      }
      case '--max-total-tokens': {
        const parsed = Number(value())
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError('--max-total-tokens must be a positive integer')
        options.maxTotalTokens = parsed
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
 * Compile one `*`/`?` glob into an anchored regular expression.
 * @param {string} glob - a single pattern; leading/trailing space is trimmed.
 * @returns {RegExp} matcher for a whole task id.
 */
function compileTaskGlob(glob) {
  const source = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${source}$`)
}

/**
 * Filter task ids by a comma-separated list of `*`/`?` globs. An id matches
 * when any glob matches. Null keeps the whole catalog.
 * @param {string[]} taskIds - catalog ids.
 * @param {string | null} glob - the `--tasks` pattern, or a comma-separated list.
 * @returns {string[]} matching ids, catalog order preserved.
 */
export function matchTaskIds(taskIds, glob) {
  if (glob === null) return taskIds
  const patterns = glob.split(',').map(compileTaskGlob)
  return taskIds.filter(id => patterns.some(pattern => pattern.test(id)))
}

/**
 * @typedef {object} PlanEntry
 * @property {string} taskId
 * @property {number} trialIndex
 * @property {string} arm
 */

/**
 * Build the interleaved execution plan: arms alternate inside every
 * (task, trial) pair, never all-off-then-all-on.
 * @param {{ taskIds: string[], arms: string[], repeats: number }} options
 * @returns {PlanEntry[]} plan in execution order.
 */
export function buildPlan({ taskIds, arms, repeats }) {
  /** @type {PlanEntry[]} */
  const plan = []
  for (const taskId of taskIds) {
    for (let trialIndex = 0; trialIndex < repeats; trialIndex += 1) {
      for (const arm of arms) plan.push({ taskId, trialIndex, arm })
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
 * @property {string | null} setup - optional pre-spawn command (`node setup.mjs`); null when absent.
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
    /** @type {string | null} */
    let setup = null
    if (definition.setup !== undefined) {
      if (typeof definition.setup !== 'string' || definition.setup.trim() === '') {
        throw new Error(`task ${entry.name}: task.json setup must be a non-empty string`)
      }
      setup = definition.setup
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
      setup,
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
 * @param {string} options.taskText - the prompt for this spawn.
 * @param {string} options.scratchDir - trial scratch dir; becomes the child cwd.
 * @param {number} options.timeoutMs - spawn timeout.
 * @param {NodeJS.ProcessEnv} options.env - child environment.
 * @param {string[]} [options.extraPatchPaths] - additional patch overlays (e.g. tier patch).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ execution: import('./execute.js').ExecutionResult, metrics: import('../schema/trial.js').TrialMetrics, sessionFile: string | null }>}
 */
async function executeSpawn({ repoRoot, arm, armDir, sessionLogRoot, taskText, scratchDir, timeoutMs, env, extraPatchPaths = [], signal, maxTotalTokens }) {
  await mkdir(sessionLogRoot, { recursive: true })
  const overlayPath = join(sessionLogRoot, 'arm-overlay.yml')
  await writeFile(overlayPath, renderArmOverlay(arm, { sessionLogRoot }))
  const execution = await executeTrial({ repoRoot, overlayPath, extraPatchPaths, taskText, scratchDir, sessionLogRoot, timeoutMs, env, signal, maxTotalTokens })
  const metrics = execution.sessionLogPath === null
    ? emptyMetrics()
    : foldSessionLog(await readFile(execution.sessionLogPath, 'utf8'), {
        expectsSessionQuery: arm.expectsSessionQuery ?? true,
        expectsJspace: arm.expectsJspace ?? true,
      })
  metrics.durationMs = execution.durationMs
  if (execution.sessionLogPath !== null) {
    const descendants = await descendantUsage(sessionLogRoot, execution.sessionLogPath)
    if (descendants.tokensIncludingDescendants !== null) {
      metrics.tokensIncludingDescendants = descendants.tokensIncludingDescendants
      metrics.descendantSessions = descendants.descendantSessions
    }
  }
  const sessionFile = execution.sessionLogPath === null
    ? null
    : relative(armDir, execution.sessionLogPath).split(sep).join('/')
  return { execution, metrics, sessionFile }
}

/** Fields summed across phases. */
const SUMMABLE_METRICS = ['inputTokens', 'outputTokens', 'durationMs', 'turns', 'toolCalls', 'identicalRetries', 'checkpoints', 'shipPasses', 'coverageRefusalThenPad', 'noopNoteRefusals', 'noteCapRefusals', 'compactionCount', 'tokensIncludingDescendants', 'descendantSessions']

/**
 * Sum per-phase metrics into the trial-level row.
 * @param {import('../schema/trial.js').PhaseRecord[]} phases - completed phases.
 * @returns {import('../schema/trial.js').TrialMetrics} field-wise sums.
 */
function sumPhaseMetrics(phases) {
  const total = emptyMetrics()
  for (const phase of phases) {
    for (const field of SUMMABLE_METRICS) {
      total[field] += phase.metrics[field]
    }
  }
  const last = phases[phases.length - 1].metrics
  total.danglingCard = last.danglingCard
  const sqValues = phases.map(p => p.metrics.sessionQueryCalls).filter(v => v !== null)
  total.sessionQueryCalls = sqValues.length > 0 ? sqValues.reduce((a, b) => a + b, 0) : null
  const cpShares = phases.map(p => p.metrics.verifiedCheckpointShare).filter(v => v !== null)
  total.verifiedCheckpointShare = cpShares.length > 0 ? cpShares.reduce((a, b) => a + b, 0) / cpShares.length : null
  total.pressureFired = total.compactionCount > 0
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
 * @param {NodeJS.ProcessEnv} options.env - child environment.
 * @param {string} options.startedAt - trial start, ISO 8601.
 * @param {string[]} [options.extraPatchPaths] - additional patch overlays (e.g. tier patch).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('../schema/trial.js').Trial>} the trial record (pre-audit).
 */
async function runSingleSessionTrial({ task, entry, arm, armDir, scratchDir, sessionLogRoot, repoRoot, env, startedAt, extraPatchPaths = [], signal, maxTotalTokens }) {
  const { base, skippedVerifier } = trialRecordFrame(task, entry, scratchDir, startedAt)
  if (task.setup !== null) {
    await runSetup({ taskDir: task.dir, setup: task.setup, scratchDir, sessionLogRoot, signal })
  }
  const { execution, metrics, sessionFile } = await executeSpawn({
    repoRoot,
    arm,
    armDir,
    sessionLogRoot,
    taskText: /** @type {string} */ (task.instruction),
    scratchDir,
    timeoutMs: task.timeoutMs,
    env,
    extraPatchPaths,
    signal,
    maxTotalTokens,
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
  const verifier = await runVerifier({ taskDir: task.dir, verify: task.verify, scratchDir, signal })
  return {
    ...base,
    status: 'success',
    resolved: verifier.resolved,
    failureMode: verifier.resolved ? null : execution.budgetExceeded ? 'BUDGET_EXCEEDED' : outcome === 'timeout' ? 'AGENT_TIMEOUT' : verifier.failureMode,
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
 * @param {NodeJS.ProcessEnv} options.env - child environment.
 * @param {string} options.startedAt - trial start, ISO 8601.
 * @param {import('../schema/trial.js').PhaseRecord[]} options.phases - shared sink: completed
 *   phase records are pushed here so a mid-chain runner failure keeps the evidence.
 * @param {string[]} [options.extraPatchPaths] - additional patch overlays (e.g. tier patch).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('../schema/trial.js').Trial>} the trial record (pre-audit).
 */
async function runChainTrial({ task, entry, arm, armDir, scratchDir, sessionRoot, repoRoot, env, startedAt, phases, extraPatchPaths = [], signal, maxTotalTokens }) {
  const { base, skippedVerifier } = trialRecordFrame(task, entry, scratchDir, startedAt)
  const definitions = /** @type {TaskPhase[]} */ (task.phases)
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]
    const phaseStartedAt = new Date().toISOString()
    const sessionLogRoot = join(sessionRoot, `phase-${index}`)
    if (task.setup !== null) {
      await runSetup({ taskDir: task.dir, setup: task.setup, scratchDir, sessionLogRoot, signal })
    }
    const { execution, metrics, sessionFile } = await executeSpawn({
      repoRoot,
      arm,
      armDir,
      sessionLogRoot,
      taskText: definition.instruction,
      scratchDir,
      timeoutMs: definition.timeoutMs ?? task.timeoutMs,
      env,
      extraPatchPaths,
      signal,
      maxTotalTokens,
    })
    phases.push({
      phaseIndex: index,
      sessionFile,
      resumedFrom: null,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      budgetExceeded: execution.budgetExceeded,
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
  const verifier = await runVerifier({ taskDir: task.dir, verify: task.verify, scratchDir, signal })
  const anyPhaseTimedOut = phases.some(phase => phase.timedOut)
  const anyPhaseBudgetExceeded = phases.some(phase => phase.budgetExceeded)
  return {
    ...base,
    status: 'success',
    resolved: verifier.resolved,
    failureMode: verifier.resolved ? null : anyPhaseBudgetExceeded ? 'BUDGET_EXCEEDED' : anyPhaseTimedOut ? 'AGENT_TIMEOUT' : verifier.failureMode,
    verifier,
    metrics: sumPhaseMetrics(phases),
    sessionFile: /** @type {string | null} */ (phases.at(-1).sessionFile),
    phases: [...phases],
    endedAt: new Date().toISOString(),
  }
}

/** Session-query tool names checked by the integrity audit. */
const SESSION_QUERY_TOOL_NAMES = new Set([
  'session_search', 'session_event_search', 'session_event_read',
  'session_event_trace', 'session_trace',
])

/**
 * Scan one session log for jspace events and session-query tool calls.
 * The metrics fold has already read this file, so its lines parse.
 * @param {string} sessionLogPath - absolute session.jsonl path.
 * @returns {Promise<{ jspaceTypes: string[], sessionQueryTools: string[] }>}
 *   distinct `jspace/` event types and session-query tool names in first-seen order.
 */
async function findIntegrityViolationEvents(sessionLogPath) {
  const text = await readFile(sessionLogPath, 'utf8')
  /** @type {string[]} */
  const jspaceTypes = []
  /** @type {string[]} */
  const sessionQueryTools = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const event = /** @type {{ type?: unknown, data?: Record<string, unknown> }} */ (JSON.parse(line))
    if (typeof event.type === 'string' && event.type.startsWith('jspace/') && !jspaceTypes.includes(event.type)) {
      jspaceTypes.push(event.type)
    }
    if (event.type === 'tool/call' && event.data && typeof event.data.name === 'string') {
      if (SESSION_QUERY_TOOL_NAMES.has(event.data.name) && !sessionQueryTools.includes(event.data.name)) {
        sessionQueryTools.push(event.data.name)
      }
    }
  }
  return { jspaceTypes, sessionQueryTools }
}

/**
 * @typedef {object} RunnerIo - injectable environment for tests.
 * @property {string} [benchRoot] - absolute bench directory (default: this repo's bench/).
 * @property {NodeJS.ProcessEnv} [env] - environment (default: process.env).
 * @property {(line: string) => void} [print] - plan/progress sink (default: console.log).
 * @property {AbortSignal} [signal] - abort in-flight trials; omit for an uninterruptible run.
 */

/**
 * Read a credential from the harness credential store when the variable is
 * absent from the environment. The store is the flat `KEY: value` YAML the
 * harness keeps at `$SHRES_HOME/.credentials.yaml` (default `~/.shres`). The
 * runner overrides SHRES_HOME per experiment for session isolation, so the
 * spawned harness cannot read the real store itself; the caller injects the
 * resolved value into the child environment and never writes it to any bench
 * record.
 * @param {NodeJS.ProcessEnv} env - runner environment (pre-override SHRES_HOME).
 * @param {string} name - credential variable name.
 * @returns {Promise<string | null>} the stored value, or null when absent.
 */
export async function readStoredCredential(env, name) {
  const home = env.SHRES_HOME ?? join(homedir(), '.shres')
  const text = await readFile(join(home, '.credentials.yaml'), 'utf8').catch(() => null)
  if (text === null) return null
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line)
    if (match === null || match[1] !== name) continue
    const raw = /** @type {string} */ (match[2])
    const unquoted = /^(['"])(.*)\1$/.exec(raw)
    const value = unquoted === null ? raw : /** @type {string} */ (unquoted[2])
    return value === '' ? null : value
  }
  return null
}

/**
 * Run the experiment (or, with --dry-run, print the plan).
 * @param {string[]} argv - arguments after `node run.js`.
 * @param {RunnerIo} [io] - injectable environment.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv, io = {}) {
  const options = parseArgs(argv)
  let env = io.env ?? process.env
  const print = io.print ?? (line => console.log(line))
  const signal = io.signal
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
  const temperature = options.temperature ?? (env.BENCH_TEMPERATURE === undefined ? DEFAULT_TEMPERATURE : Number(env.BENCH_TEMPERATURE))
  const apiKeyEnv = options.apiKeyEnv
  const baseUrl = options.baseUrl ?? (apiKeyEnv === 'DEEPSEEK_API_KEY' ? (env.DEEPSEEK_BASE_URL ?? null) : null)

  /** @type {import('../schema/run-manifest.js').TierPatchRecord[]} */
  const tierPatchRecords = []
  /** @type {string[]} */
  const extraPatchPaths = []
  for (const given of options.tierPatches) {
    const absPath = resolve(given)
    const tierContent = await readFile(absPath, 'utf8').catch(() => {
      throw new UsageError(`--tier-patch file not found: ${given}`)
    })
    const sha256 = createHash('sha256').update(tierContent).digest('hex')
    tierPatchRecords.push({ path: relative(benchRoot, absPath).split(sep).join('/'), sha256 })
    extraPatchPaths.push(absPath)
  }

  const plan = buildPlan({ taskIds, arms: options.arms, repeats: options.repeats })

  if (options.dryRun) {
    print(`experiment: ${options.experiment}`)
    print(`model: ${model}  temperature: ${temperature}  baseUrl: ${baseUrl ?? '(provider default)'}`)
    const tierSummary = tierPatchRecords.length === 0
      ? ''
      : `  tierPatches: ${tierPatchRecords.map(r => `${r.path} (${r.sha256.slice(0, 12)}…)`).join(', ')}`
    print(`apiKeyEnv: ${apiKeyEnv}${tierSummary}`)
    print(`tasks: ${taskIds.join(', ')}`)
    print(`plan: ${plan.length} trials (${taskIds.length} tasks × ${options.repeats} repeats × ${options.arms.length} arms)`)
    if (options.concurrency > 1) print(`concurrency: ${options.concurrency}`)
    for (const entry of plan) {
      const task = /** @type {TaskDefinition} */ (tasks.get(entry.taskId))
      const suffix = task.phases === null ? '' : ` (${task.phases.length} phases)`
      print(`  ${entry.taskId} #${entry.trialIndex} [${entry.arm}]${suffix}`)
    }
    return 0
  }

  if (apiKeyEnv !== 'none') {
    const fromEnv = env[apiKeyEnv]
    const key = typeof fromEnv === 'string' && fromEnv !== ''
      ? fromEnv
      : await readStoredCredential(env, apiKeyEnv)
    if (key === null) {
      throw new UsageError(
        `${apiKeyEnv} is required for real runs: export it or add it to the harness credential store `
        + `($SHRES_HOME/.credentials.yaml, default ~/.shres); or use --dry-run, or --api-key-env none for keyless tiers`,
      )
    }
    if (fromEnv !== key) env = { ...env, [apiKeyEnv]: key }
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
      model,
      baseUrl,
      temperature,
      repeats: options.repeats,
      taskIds,
      gitCommit,
      apiKeyEnv,
      tierPatches: tierPatchRecords,
      maxTotalTokens: options.maxTotalTokens ?? null,
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
  const recordQueue = createSerialQueue()

  /**
   * One interleaved plan entry: isolated scratch + session root, then a
   * serialized append of one complete trials.jsonl line.
   * @param {PlanEntry} entry
   */
  const runPlanEntry = async entry => {
    if (signal?.aborted) return
    const task = /** @type {TaskDefinition} */ (tasks.get(entry.taskId))
    const arm = getArm(entry.arm)
    const armDir = /** @type {string} */ (armDirs.get(entry.arm))
    const scratchDir = join(experimentDir, 'scratch', entry.arm, entry.taskId, String(entry.trialIndex))
    const sessionRoot = join(armDir, 'sessions', entry.taskId, String(entry.trialIndex))
    const trialStartedAt = new Date().toISOString()
    const trialEnv = { ...env, SHRES_HOME: shresHome }

    if (options.concurrency > 1) {
      print(`[${options.experiment}] ${entry.taskId} #${entry.trialIndex} [${entry.arm}] running`)
    }

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
    // across its phases while sessions do not. Paths include arm/task/trial
    // so concurrent workers never share a directory.
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
          repoRoot, env: trialEnv, startedAt: trialStartedAt,
          extraPatchPaths,
          signal,
          maxTotalTokens: options.maxTotalTokens,
        })
      } else {
        chainPhases = []
        trial = await runChainTrial({
          task, entry, arm, armDir, scratchDir,
          sessionRoot,
          repoRoot, env: trialEnv, startedAt: trialStartedAt,
          phases: chainPhases,
          extraPatchPaths,
          maxTotalTokens: options.maxTotalTokens,
          signal,
        })
      }
    } catch (error) {
      if (signal?.aborted) return
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

    if (signal?.aborted) return

    // Integrity audit, part 2: arms that exclude jspace must log zero jspace
    // events; arms that exclude session-query must log zero session-query
    // tool/call events.
    const sessionFiles = (trial.phases ?? [{ sessionFile: trial.sessionFile }])
      .map(record => record.sessionFile)
      .filter(file => file !== null)
    if (!arm.expectsJspace || !arm.expectsSessionQuery) {
      for (const file of sessionFiles) {
        const { jspaceTypes, sessionQueryTools } = await findIntegrityViolationEvents(join(armDir, file))
        if (!arm.expectsJspace) {
          for (const type of jspaceTypes) {
            violations.push(`off-arm-jspace-event:${type}`)
          }
        }
        if (!arm.expectsSessionQuery) {
          for (const name of sessionQueryTools) {
            violations.push(`excluded-session-query-tool:${name}`)
          }
        }
      }
    }
    if (violations.length > 0) trial.integrity = { violations }

    validateTrial(trial)
    const line = `${JSON.stringify(trial)}\n`
    await recordQueue.enqueue(async () => {
      await appendFile(join(armDir, 'trials.jsonl'), line)
      if (trial.status === 'error') failed += 1
      else finished += 1
      print(
        `[${options.experiment}] ${entry.taskId} #${entry.trialIndex} [${entry.arm}] `
        + `${trial.status}${trial.resolved ? ' resolved' : ''}${trial.failureMode ? ` ${trial.failureMode}` : ''}`,
      )
    })
  }

  await mapPool(plan, options.concurrency, runPlanEntry, { signal })
  if (signal?.aborted) {
    print(`[${options.experiment}] aborted: ${finished} completed, ${failed} infrastructure errors`)
    return EXIT_ABORTED
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
  const abort = new AbortController()
  const onSignal = () => {
    if (abort.signal.aborted) process.exit(EXIT_ABORTED)
    abort.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const detachSignals = () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  main(process.argv.slice(2), { signal: abort.signal }).then(
    code => {
      detachSignals()
      process.exitCode = code
    },
    error => {
      detachSignals()
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
