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
 * (leakage from a previous trial), the off arm's logs must contain zero
 * `jspace/` events (overlay leakage), a routing arm must log a decision on every
 * turn-bearing session (adoption), and a compaction-jev arm must log a
 * verification whenever it compacted. Violations land on `trial.integrity`;
 * the trial is still recorded and the experiment never aborts.
 *
 * Credentials: `--api-key-env` names the conversation route's variable and is
 * required for a real run; each selected arm may additionally declare
 * `judgmentKeyEnv` for the engine its composition resolves on its own. Both
 * resolve exported-value-first, then the harness store, and reach the child
 * environment only — no bench record carries a value, and an unresolved
 * judgment reference is left unset so the arm degrades as documented.
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
import { getArm, listDefaultArms, renderArmOverlay } from './arms.js'
import { executeTrial } from './execute.js'
import { computeThinDebates, emptyMetrics, foldSessionLog } from './metrics.js'
import { descendantUsage } from './descendants.js'
import {
  DEFAULT_ACCOUNTING_CONFIG,
  DEFAULT_PRICES_DIR,
  emptyAccounting,
  exactCost,
  mergeAccounting,
  priceAccounting,
  resolveAccountingContext,
} from './accounting.js'
import { createDollarBudget } from './dollar-budget.js'
import { createSerialQueue, mapPool } from './pool.js'
import { runSetup } from './setup.js'
import { runVerifier } from './verify.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateTrial } from '../schema/trial.js'

const execFileAsync = promisify(execFile)

const USAGE = `Usage: node bench/runner/run.js --experiment <name> [options]

Options:
  --experiment <name>   experiment directory under bench/runs/ (required)
  --arms <a,b>          arms to run, comma-separated (default: ${listDefaultArms().join(',')})
  --repeats <n>         trials per task per arm (default: 3)
  --tasks <glob[,glob]> task-id filter; comma-separated * / ? globs; match is union (default: all)
  --model <id>          model pin for run.json (default: $BENCH_MODEL or deepseek-v4-flash)
  --temperature <t>     temperature pin for run.json (default: $BENCH_TEMPERATURE or 1)
  --base-url <url>      provider base URL pin (default: $DEEPSEEK_BASE_URL when --api-key-env is DEEPSEEK_API_KEY, null otherwise)
  --api-key-env <VAR>   env var name for the API key; 'none' for keyless tiers (default: DEEPSEEK_API_KEY).
                        An unset variable falls back to the harness credential store
                        ($SHRES_HOME/.credentials.yaml, default ~/.shres); the value is injected
                        into the child environment only, never into any bench record.
                        An arm's own credential references (its judgment engine) resolve the same
                        way and are injected the same way; an unresolved one is left unset, which
                        is the arm's documented degradation rather than a usage error.
  --tier-patch <path>   experiment-level overlay applied after the arm overlay; repeatable, order preserved
  --concurrency <n>     max trials in flight (default: 1; 1 is sequential)
  --max-total-tokens <n>  live token cap per trial: observed root+descendant usage
                        above the cap terminates the trial as BUDGET_EXCEEDED
  --max-dollars <usd>   experiment-wide cap in API-equivalent dollars from the price
                        snapshot: no new trial launches once the cap would be exceeded;
                        in-flight trials finish. Subscription and unpriced calls are not counted.
  --price-snapshot <id> bench/prices snapshot (YYYY-MM-DD) to price trials under
                        (default: the newest snapshot)
  --resume               continue an interrupted experiment: reuse its manifest and
                        skip (task, trial, arm) triples already recorded with a
                        delivered verdict (status success); retried provider-error
                        trials run again. Pin mismatches refuse loud.
  --dry-run             print each selected arm's rendered overlay, then the plan; writes nothing and executes nothing
  --help                this text
`

/** Exit code for usage and environment errors (bad flags, missing API key). */
const EXIT_USAGE = 2

/** Exit code when SIGINT/SIGTERM abort the run after in-flight trials drain. */
const EXIT_ABORTED = 130

/** Exit code when `--max-dollars` stopped launching trials before the plan finished. */
const EXIT_BUDGET_STOP = 3

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
 * @property {boolean} [resume] - continue an interrupted experiment instead of refusing
 *   its existing manifests; delivered-verdict trials are skipped, error trials rerun.
 * @property {number} [maxDollars] - experiment-wide cap in API-equivalent dollars; no trial
 *   launches once settled spend plus the in-flight projection would exceed it.
 * @property {string} [priceSnapshot] - `bench/prices` snapshot id; omission resolves to the newest.
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
    arms: listDefaultArms(),
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
    maxDollars: undefined,
    priceSnapshot: undefined,
    resume: false,
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
      case '--max-dollars': {
        const raw = value()
        const parsed = Number(raw)
        if (raw.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) throw new UsageError('--max-dollars must be a positive number')
        options.maxDollars = parsed
        break
      }
      case '--price-snapshot': {
        const id = value()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) throw new UsageError('--price-snapshot must be a YYYY-MM-DD snapshot id')
        options.priceSnapshot = id
        break
      }
      case '--resume':
        options.resume = true
        break
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
  assertStuffedCompactionGuard(options)
  return options
}

/**
 * True when a `--tier-patch` path is the forced-compaction pressure overlay.
 * @param {string} patchPath - path as given on the command line.
 * @returns {boolean} whether the basename is `forced-compaction.patch.yml`.
 */
export function isForcedCompactionPatch(patchPath) {
  const normalized = patchPath.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1)
  return basename === 'forced-compaction.patch.yml'
}

/**
 * Protocol rule: a stuffed arm's condition is the whole corpus in the prompt.
 * Forced compaction would destroy that condition. Fail at argv validation.
 * @param {Pick<RunnerOptions, 'arms' | 'tierPatches'>} options - parsed flags.
 * @returns {void}
 */
export function assertStuffedCompactionGuard(options) {
  const stuffedArms = options.arms.filter(name => getArm(name).stuffed === true)
  if (stuffedArms.length === 0) return
  const compaction = options.tierPatches.filter(isForcedCompactionPatch)
  if (compaction.length === 0) return
  throw new UsageError(
    `stuffed arm (${stuffedArms.join(', ')}) cannot combine with the forced-compaction overlay `
    + `(${compaction.join(', ')}): compaction would destroy the whole-corpus-in-the-prompt condition `
    + `(protocol rule)`,
  )
}

/**
 * Choose the model-visible instruction for one (task, arm). `armInstructions[arm]`
 * wins when present (cued family); stuffed arms fall back to `stuffedInstruction`;
 * otherwise the default `instruction`.
 * @param {TaskDefinition} task - loaded task.
 * @param {{ name: string, stuffed?: boolean }} arm - arm entry.
 * @returns {string} the prompt for this spawn.
 */
export function resolveTaskInstruction(task, arm) {
  const byArm = task.armInstructions?.[arm.name]
  if (typeof byArm === 'string') return byArm
  if (arm.stuffed === true && typeof task.stuffedInstruction === 'string') return task.stuffedInstruction
  return /** @type {string} */ (task.instruction)
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
 * @property {string | null} stuffedInstruction - stuffed-arm prompt with the corpus inlined; null when absent.
 * @property {Record<string, string> | null} armInstructions - per-arm prompt override (cued family); null when absent.
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
    /** @type {string | null} */
    let stuffedInstruction = null
    if (definition.stuffedInstruction !== undefined) {
      if (typeof definition.stuffedInstruction !== 'string' || definition.stuffedInstruction.trim() === '') {
        throw new Error(`task ${entry.name}: task.json stuffedInstruction must be a non-empty string`)
      }
      stuffedInstruction = definition.stuffedInstruction
    }
    /** @type {Record<string, string> | null} */
    let armInstructions = null
    if (definition.armInstructions !== undefined) {
      if (
        typeof definition.armInstructions !== 'object'
        || definition.armInstructions === null
        || Array.isArray(definition.armInstructions)
      ) {
        throw new Error(`task ${entry.name}: task.json armInstructions must be a record of non-empty strings`)
      }
      armInstructions = {}
      for (const [name, text] of Object.entries(/** @type {Record<string, unknown>} */ (definition.armInstructions))) {
        if (typeof text !== 'string' || text.trim() === '') {
          throw new Error(`task ${entry.name}: task.json armInstructions.${name} must be a non-empty string`)
        }
        armInstructions[name] = text
      }
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
      stuffedInstruction,
      armInstructions,
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
 * and fold its session log into metrics and priced accounting.
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
 * @param {number} [options.maxTotalTokens] - live per-trial token cap.
 * @param {import('./accounting.js').AccountingContext} options.accountingContext - snapshot and config to price under.
 * @returns {Promise<{ execution: import('./execute.js').ExecutionResult, metrics: import('../schema/trial.js').TrialMetrics, sessionFile: string | null, accounting: import('./accounting.js').TrialAccounting }>}
 */
async function executeSpawn({ repoRoot, arm, armDir, sessionLogRoot, taskText, scratchDir, timeoutMs, env, extraPatchPaths = [], signal, maxTotalTokens, accountingContext }) {
  await mkdir(sessionLogRoot, { recursive: true })
  const overlayPath = join(sessionLogRoot, 'arm-overlay.yml')
  await writeFile(overlayPath, renderArmOverlay(arm, { sessionLogRoot }))
  const execution = await executeTrial({ repoRoot, overlayPath, extraPatchPaths, taskText, scratchDir, sessionLogRoot, timeoutMs, env, signal, maxTotalTokens })
  const metrics = execution.sessionLogPath === null
    ? emptyMetrics()
    : foldSessionLog(await readFile(execution.sessionLogPath, 'utf8'), {
        expectsSessionQuery: arm.expectsSessionQuery ?? true,
        expectsJspace: arm.expectsJspace ?? true,
        expectsResearcher: arm.expectsResearcher ?? false,
      })
  metrics.durationMs = execution.durationMs
  let accounting = emptyAccounting()
  if (execution.sessionLogPath !== null) {
    const descendants = await descendantUsage(sessionLogRoot, execution.sessionLogPath)
    accounting = priceAccounting(descendants.sessions, accountingContext)
    metrics.costIncludingDescendants = exactCost(accounting)
    if (descendants.tokensIncludingDescendants !== null) {
      metrics.tokensIncludingDescendants = descendants.tokensIncludingDescendants
      metrics.descendantSessions = descendants.descendantSessions
    }
    metrics.outOfLoopExperiments += descendants.delegatedSessions + descendants.descendantRunCodeCalls
    if (arm.expectsResearcher) {
      metrics.thinDebates = await computeThinDebates(sessionLogRoot, await readFile(execution.sessionLogPath, 'utf8'))
    }
  }
  const sessionFile = execution.sessionLogPath === null
    ? null
    : relative(armDir, execution.sessionLogPath).split(sep).join('/')
  return { execution, metrics, sessionFile, accounting }
}

/**
 * Sum the accounting of chain phases; a phase recorded without accounting adds nothing.
 * @param {import('../schema/trial.js').PhaseRecord[]} phases
 * @returns {import('./accounting.js').TrialAccounting}
 */
export function sumPhaseAccounting(phases) {
  return phases.reduce((sum, phase) => mergeAccounting(sum, phase.accounting ?? emptyAccounting()), emptyAccounting())
}

/** Fields summed across phases. */
const SUMMABLE_METRICS = ['inputTokens', 'outputTokens', 'durationMs', 'turns', 'toolCalls', 'identicalRetries', 'checkpoints', 'shipPasses', 'coverageRefusalThenPad', 'noopNoteRefusals', 'noteCapRefusals', 'compactionCount', 'tokensIncludingDescendants', 'descendantSessions', 'outOfLoopExperiments']

/**
 * Sum per-phase metrics into the trial-level row. Researcher integrity fields
 * are nullable per phase; they sum across the phases that actually mounted the
 * researcher surface (the phase whose `gateRefusals` is non-null), with rates
 * averaged and derived booleans recomputed from the summed counts. The Jev
 * routing/compaction fields are not rolled up here: a phase records shares
 * without the counts behind them, so {@link rollupChainJevMetrics} recomputes
 * them from the phase logs themselves.
 * @param {import('../schema/trial.js').PhaseRecord[]} phases - completed phases.
 * @returns {import('../schema/trial.js').TrialMetrics} field-wise sums.
 */
export function sumPhaseMetrics(phases) {
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
  const research = phases.filter(p => p.metrics.gateRefusals !== null)
  if (research.length > 0) {
    const sum = field => research.reduce((acc, p) => acc + (/** @type {number} */ (p.metrics[field]) ?? 0), 0)
    total.gateRefusals = sum('gateRefusals')
    total.debateCalls = sum('debateCalls')
    total.runsLogged = sum('runsLogged')
    total.unverifiedRunRefusals = sum('unverifiedRunRefusals')
    total.thinDebates = sum('thinDebates')
    const verifyShares = research.map(p => p.metrics.verifySatisfiedRate).filter(v => v !== null)
    total.verifySatisfiedRate = verifyShares.length > 0 ? verifyShares.reduce((a, b) => a + b, 0) / verifyShares.length : null
    const deferredShares = research.map(p => p.metrics.deferredShare).filter(v => v !== null)
    total.deferredShare = deferredShares.length > 0 ? deferredShares.reduce((a, b) => a + b, 0) / deferredShares.length : null
    const accepted = research.reduce((a, p) => a + (p.metrics.ledgerDecisions?.accepted ?? 0), 0)
    const rejected = research.reduce((a, p) => a + (p.metrics.ledgerDecisions?.rejected ?? 0), 0)
    const deferred = research.reduce((a, p) => a + (p.metrics.ledgerDecisions?.deferred ?? 0), 0)
    const totalDecisions = accepted + rejected + deferred
    total.ledgerDecisions = { accepted, rejected, deferred }
    total.ledgerAbandoned = totalDecisions === 0
    total.unverifiedAcceptRecovery = (total.unverifiedRunRefusals ?? 0) > 0 && totalDecisions > 0
  }
  total.costIncludingDescendants = phases.every(phase => phase.accounting !== undefined)
    ? exactCost(sumPhaseAccounting(phases))
    : null
  return total
}

/** Jev routing/compaction fields a chain trial recomputes from its phase logs instead of summing per phase. */
const JEV_CHAIN_ROLLUP_FIELDS = ['cacheHitShare', 'cacheUnreportedShare', 'modelTransitions', 'downgradedShare', 'keptStrongShare', 'routingHintCount', 'jevCompactionAcceptedBelowThreshold', 'jevSelectionDegraded']

/**
 * Fold a chain trial's Jev routing/compaction fields from its phases.
 *
 * A phase is folded on its own, so its metrics carry shares without the counts
 * that produced them and count route changes only inside that phase. Re-folding
 * the concatenated phase logs at the trial level recovers the exact counts — a
 * route change at a phase boundary is a real transition — and leaves the null
 * rules to the one fold that owns them: a chain with no reported cache-read count
 * anywhere keeps `cacheHitShare` null, and a phase without one adds its prompt to
 * `cacheUnreportedShare`, never a miss to the share. The closure-wide
 * `accounting` shares need no re-fold: they derive from the summed phase token
 * classes.
 *
 * `downgradedStreaks` is the one field the concatenation cannot state: each
 * phase is its own session, so a run of downgraded turns spanning a phase
 * boundary is deliberately NOT merged, and the trial's list is the phases'
 * lists in phase order.
 * @param {import('../schema/trial.js').TrialMetrics} metrics - the trial's summed metrics; the Jev fields are overwritten.
 * @param {import('../schema/trial.js').PhaseRecord[]} phases - completed phases, in order.
 * @param {string} armDir - the arm's output directory; phase `sessionFile` values are relative to it.
 * @returns {Promise<void>}
 */
export async function rollupChainJevMetrics(metrics, phases, armDir) {
  const logs = []
  for (const phase of phases) {
    if (phase.sessionFile === null) continue
    logs.push(await readFile(join(armDir, phase.sessionFile), 'utf8'))
  }
  if (logs.length === 0) return
  const folded = foldSessionLog(logs.join('\n'))
  for (const field of JEV_CHAIN_ROLLUP_FIELDS) {
    metrics[field] = folded[field]
  }
  const judged = phases.some(phase => Array.isArray(phase.metrics.downgradedStreaks))
  metrics.downgradedStreaks = judged ? phases.flatMap(phase => phase.metrics.downgradedStreaks ?? []) : null
}

/**
 * The trial metrics for a chain the runner itself aborted: the phase sums with
 * the Jev fields rolled up, or an empty record when no phase completed.
 * @param {import('../schema/trial.js').PhaseRecord[] | undefined} partial - completed phases, when any.
 * @param {string} armDir - the arm's output directory.
 * @returns {Promise<import('../schema/trial.js').TrialMetrics>} the trial's metrics.
 */
async function partialMetrics(partial, armDir) {
  if (partial === undefined) return emptyMetrics()
  const metrics = sumPhaseMetrics(partial)
  await rollupChainJevMetrics(metrics, partial, armDir)
  return metrics
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
 * @param {number} [options.maxTotalTokens] - live per-trial token cap.
 * @param {import('./accounting.js').AccountingContext} options.accountingContext - snapshot and config to price under.
 * @returns {Promise<import('../schema/trial.js').Trial>} the trial record (pre-audit).
 */
async function runSingleSessionTrial({ task, entry, arm, armDir, scratchDir, sessionLogRoot, repoRoot, env, startedAt, extraPatchPaths = [], signal, maxTotalTokens, accountingContext }) {
  const { base, skippedVerifier } = trialRecordFrame(task, entry, scratchDir, startedAt)
  if (task.setup !== null) {
    await runSetup({ taskDir: task.dir, setup: task.setup, scratchDir, sessionLogRoot, signal })
  }
  const { execution, metrics, sessionFile, accounting } = await executeSpawn({
    repoRoot,
    arm,
    armDir,
    sessionLogRoot,
    taskText: resolveTaskInstruction(task, arm),
    scratchDir,
    timeoutMs: task.timeoutMs,
    env,
    extraPatchPaths,
    signal,
    maxTotalTokens,
    accountingContext,
  })
  const outcome = classifySpawn(execution)
  const executionEvidence = {
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    budgetExceeded: execution.budgetExceeded,
  }
  const endedAt = new Date().toISOString()
  const priced = { priceSnapshot: accountingContext.snapshot.id, accounting }
  if (outcome === 'provider-error' || outcome === 'harness-error') {
    return {
      ...base,
      status: 'error',
      resolved: false,
      failureMode: outcome === 'provider-error' ? 'PROVIDER_ERROR' : 'HARNESS_ERROR',
      verifier: skippedVerifier(spawnFailureDetail(outcome, execution)),
      metrics,
      sessionFile,
      execution: executionEvidence,
      ...priced,
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
    execution: executionEvidence,
    ...priced,
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
 * @param {number} [options.maxTotalTokens] - live per-trial token cap.
 * @param {import('./accounting.js').AccountingContext} options.accountingContext - snapshot and config to price under.
 * @returns {Promise<import('../schema/trial.js').Trial>} the trial record (pre-audit).
 */
async function runChainTrial({ task, entry, arm, armDir, scratchDir, sessionRoot, repoRoot, env, startedAt, phases, extraPatchPaths = [], signal, maxTotalTokens, accountingContext }) {
  const { base, skippedVerifier } = trialRecordFrame(task, entry, scratchDir, startedAt)
  const definitions = /** @type {TaskPhase[]} */ (task.phases)
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]
    const phaseStartedAt = new Date().toISOString()
    const sessionLogRoot = join(sessionRoot, `phase-${index}`)
    if (task.setup !== null) {
      await runSetup({ taskDir: task.dir, setup: task.setup, scratchDir, sessionLogRoot, signal })
    }
    const { execution, metrics, sessionFile, accounting } = await executeSpawn({
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
      accountingContext,
    })
    phases.push({
      phaseIndex: index,
      sessionFile,
      resumedFrom: null,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      budgetExceeded: execution.budgetExceeded,
      metrics,
      accounting,
      startedAt: phaseStartedAt,
      endedAt: new Date().toISOString(),
    })
    const outcome = classifySpawn(execution)
    if (outcome === 'provider-error' || outcome === 'harness-error') {
      const metrics = sumPhaseMetrics(phases)
      await rollupChainJevMetrics(metrics, phases, armDir)
      return {
        ...base,
        status: 'error',
        resolved: false,
        failureMode: outcome === 'provider-error' ? 'PROVIDER_ERROR' : 'HARNESS_ERROR',
        verifier: skippedVerifier(spawnFailureDetail(outcome, execution, ` in phase ${index}`)),
        metrics,
        sessionFile: phases.at(-1).sessionFile,
        phases: [...phases],
        ...pricedPhases(phases, accountingContext),
        endedAt: new Date().toISOString(),
      }
    }
  }
  const verifier = await runVerifier({ taskDir: task.dir, verify: task.verify, scratchDir, signal })
  const anyPhaseTimedOut = phases.some(phase => phase.timedOut)
  const anyPhaseBudgetExceeded = phases.some(phase => phase.budgetExceeded)
  const metrics = sumPhaseMetrics(phases)
  await rollupChainJevMetrics(metrics, phases, armDir)
  return {
    ...base,
    status: 'success',
    resolved: verifier.resolved,
    failureMode: verifier.resolved ? null : anyPhaseBudgetExceeded ? 'BUDGET_EXCEEDED' : anyPhaseTimedOut ? 'AGENT_TIMEOUT' : verifier.failureMode,
    verifier,
    metrics,
    sessionFile: /** @type {string | null} */ (phases.at(-1).sessionFile),
    phases: [...phases],
    ...pricedPhases(phases, accountingContext),
    endedAt: new Date().toISOString(),
  }
}

/**
 * The trial-level price fields of a chain: its snapshot id and the summed phase accounting.
 * @param {import('../schema/trial.js').PhaseRecord[]} phases
 * @param {import('./accounting.js').AccountingContext} accountingContext
 * @returns {{ priceSnapshot: string, accounting: import('./accounting.js').TrialAccounting }}
 */
function pricedPhases(phases, accountingContext) {
  return { priceSnapshot: accountingContext.snapshot.id, accounting: sumPhaseAccounting(phases) }
}

/** Session-query tool names checked by the integrity audit. */
const SESSION_QUERY_TOOL_NAMES = new Set([
  'session_search', 'session_event_search', 'session_event_read',
  'session_event_trace', 'session_trace',
])

/**
 * Scan one session log for the events the integrity audit judges: the leakage
 * evidence (jspace events and session-query tool calls) and the adoption
 * evidence (routing decisions and jev verifications). The metrics fold has
 * already read this file, so its lines parse.
 * @param {string} sessionLogPath - absolute session.jsonl path.
 * @returns {Promise<{ jspaceTypes: string[], sessionQueryTools: string[], routingDecisions: number, compactionVerifications: number }>}
 *   distinct `jspace/` event types and session-query tool names in first-seen
 *   order, plus the counts of `model-routing/decision` and
 *   `compaction/verification` events.
 */
async function scanSessionLog(sessionLogPath) {
  const text = await readFile(sessionLogPath, 'utf8')
  /** @type {string[]} */
  const jspaceTypes = []
  /** @type {string[]} */
  const sessionQueryTools = []
  let routingDecisions = 0
  let compactionVerifications = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const event = /** @type {{ type?: unknown, data?: Record<string, unknown> }} */ (JSON.parse(line))
    if (typeof event.type === 'string' && event.type.startsWith('jspace/') && !jspaceTypes.includes(event.type)) {
      jspaceTypes.push(event.type)
    }
    if (event.type === 'model-routing/decision') routingDecisions += 1
    if (event.type === 'compaction/verification') compactionVerifications += 1
    if (event.type === 'tool/call' && event.data && typeof event.data.name === 'string') {
      if (SESSION_QUERY_TOOL_NAMES.has(event.data.name) && !sessionQueryTools.includes(event.data.name)) {
        sessionQueryTools.push(event.data.name)
      }
    }
  }
  return { jspaceTypes, sessionQueryTools, routingDecisions, compactionVerifications }
}

/**
 * @typedef {object} RunnerIo - injectable environment for tests.
 * @property {string} [benchRoot] - absolute bench directory (default: this repo's bench/).
 * @property {NodeJS.ProcessEnv} [env] - environment (default: process.env).
 * @property {(line: string) => void} [print] - plan/progress sink (default: console.log).
 * @property {AbortSignal} [signal] - abort in-flight trials; omit for an uninterruptible run.
 * @property {string} [pricesDir] - dated price snapshots (default: bench/prices beside this runner).
 * @property {string} [accountingConfigPath] - accounting configuration (default: bench/accounting.json beside this runner).
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
 * Add each named credential the harness store holds and the environment does
 * not export. `--api-key-env` resolves the same way but refuses to run without
 * its value; these are references an arm's composition resolves on its own, so
 * an unresolved one is left alone and the consumer degrades as documented.
 * @param {NodeJS.ProcessEnv} env - runner environment (pre-override SHRES_HOME).
 * @param {string[]} names - declared credential variable names, in arm order.
 * @returns {Promise<NodeJS.ProcessEnv>} `env`, with every resolvable name added.
 */
export async function injectStoredCredentials(env, names) {
  let injected = env
  for (const name of names) {
    const exported = injected[name]
    if (typeof exported === 'string' && exported !== '') continue
    const stored = await readStoredCredential(injected, name)
    if (stored === null) continue
    injected = { ...injected, [name]: stored }
  }
  return injected
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
  const experimentDir = join(benchRoot, 'runs', options.experiment)

  /** @type {import('./accounting.js').AccountingContext} */
  let accountingContext
  try {
    accountingContext = await resolveAccountingContext({
      pricesDir: io.pricesDir ?? DEFAULT_PRICES_DIR,
      configPath: io.accountingConfigPath ?? DEFAULT_ACCOUNTING_CONFIG,
      snapshotId: options.priceSnapshot,
    })
  } catch (error) {
    throw new UsageError(`price accounting: ${/** @type {Error} */ (error).message}`)
  }
  const priceSnapshot = accountingContext.snapshot.id
  const maxDollars = options.maxDollars ?? null

  if (options.dryRun) {
    print(`experiment: ${options.experiment}`)
    print(`model: ${model}  temperature: ${temperature}  baseUrl: ${baseUrl ?? '(provider default)'}`)
    const tierSummary = tierPatchRecords.length === 0
      ? ''
      : `  tierPatches: ${tierPatchRecords.map(r => `${r.path} (${r.sha256.slice(0, 12)}…)`).join(', ')}`
    print(`apiKeyEnv: ${apiKeyEnv}${tierSummary}`)
    print(`priceSnapshot: ${priceSnapshot}  maxDollars: ${maxDollars === null ? '(uncapped)' : maxDollars}`)
    print(`tasks: ${taskIds.join(', ')}`)
    // The integrity check a dry run exists for: render every selected arm's
    // overlay at the per-trial root its first plan entry would use, so a
    // config the harness refuses is visible before any spend. Nothing is
    // created or written.
    for (const armName of options.arms) {
      const entry = /** @type {PlanEntry} */ (plan.find(candidate => candidate.arm === armName))
      const sessionLogRoot = join(experimentDir, armName, 'sessions', entry.taskId, String(entry.trialIndex))
      print(`overlay [${armName}] ${sessionLogRoot}`)
      for (const line of renderArmOverlay(getArm(armName), { sessionLogRoot }).trimEnd().split('\n')) {
        print(`  ${line}`)
      }
    }
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
  // The selected arms' own credential references, resolved the same way and
  // injected into the child environment only. Absence is not a usage error:
  // a judgment consumer whose engine cannot be reached runs its documented
  // degradation, so the run is recorded and reported as not evidence.
  const optionalCredentials = [...new Set(options.arms
    .map(name => getArm(name).judgmentKeyEnv)
    .filter(name => typeof name === 'string'))]
  env = await injectStoredCredentials(env, optionalCredentials)

  const shresHome = join(experimentDir, '.shres-home')
  const gitCommit = await resolveGitCommit(repoRoot)
  const startedAt = new Date().toISOString()

  const armDirs = new Map()
  /** @type {Map<string, Set<string>>} arm -> delivered `(taskId, trialIndex)` keys to skip on resume. */
  const delivered = new Map()
  const budget = maxDollars === null ? null : createDollarBudget(maxDollars)
  for (const armName of options.arms) {
    const armDir = join(experimentDir, armName)
    if (options.resume) {
      const manifestPath = join(armDir, 'run.json')
      let existing
      try {
        existing = JSON.parse(await readFile(manifestPath, 'utf8'))
      } catch {
        throw new UsageError(`--resume: experiment "${options.experiment}" has no manifest for arm "${armName}"; nothing to resume`)
      }
      const mismatches = resumePinMismatches(existing, {
        model, baseUrl, temperature, taskIds, tierPatches: tierPatchRecords, maxTotalTokens: options.maxTotalTokens ?? null, apiKeyEnv,
        maxDollars, priceSnapshot, accountingConfigSha256: accountingContext.configSha256,
      })
      if (mismatches.length > 0) {
        throw new UsageError(
          `--resume: experiment "${options.experiment}" arm "${armName}" pins differ (${mismatches.join(', ')}); a changed run is a new experiment name`,
        )
      }
      const done = new Set()
      try {
        for (const line of (await readFile(join(armDir, 'trials.jsonl'), 'utf8')).split('\n')) {
          if (line.trim() === '') continue
          const trial = JSON.parse(line)
          if (trial.status === 'success') done.add(`${trial.taskId}\u0000${trial.trialIndex}`)
          // Every recorded trial spent, whether or not it reruns.
          if (budget !== null && trial.accounting !== undefined) budget.settle(trial.accounting)
        }
      } catch {
        // No trials yet: the manifest alone is resumable.
      }
      delivered.set(armName, done)
      print(`[${options.experiment}] resume ${armName}: skipping ${done.size} delivered trials, rerunning error trials`)
      armDirs.set(armName, armDir)
      continue
    }
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
      maxDollars,
      priceSnapshot,
      accountingConfigSha256: accountingContext.configSha256,
      startedAt,
      endedAt: '',
    }
    validateRunManifest(manifest)
    await mkdir(armDir, { recursive: true })
    try {
      await writeFile(join(armDir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    } catch {
      throw new UsageError(
        `experiment "${options.experiment}" already has a manifest for arm "${armName}"; a changed run is a new experiment name (or pass --resume to continue it)`,
      )
    }
    armDirs.set(armName, armDir)
  }

  /**
   * Compare a stored manifest's pre-registration pins against the invocation's.
   * `gitCommit` and `startedAt` deliberately excluded: resuming after a pull is
   * allowed only when the tier patches pin the same harness composition; a
   * changed commit with identical overlays is the same measured condition.
   * `priceSnapshot` and `accountingConfigSha256` compare only when the stored
   * manifest records them: a manifest written before the bench priced trials
   * pins no prices, and its runs stay resumable.
   * @param {Record<string, unknown>} stored - the existing manifest.
   * @param {object} pins - the invocation's pins.
   * @returns {string[]} field names that differ.
   */
  function resumePinMismatches(stored, pins) {
    /** @type {string[]} */
    const diffs = []
    if (stored.model !== pins.model) diffs.push('model')
    if (stored.baseUrl !== pins.baseUrl) diffs.push('baseUrl')
    if (stored.temperature !== pins.temperature) diffs.push('temperature')
    if (JSON.stringify(stored.taskIds) !== JSON.stringify(pins.taskIds)) diffs.push('taskIds')
    if (JSON.stringify(stored.tierPatches) !== JSON.stringify(pins.tierPatches)) diffs.push('tierPatches')
    if ((stored.maxTotalTokens ?? null) !== pins.maxTotalTokens) diffs.push('maxTotalTokens')
    if (stored.apiKeyEnv !== pins.apiKeyEnv) diffs.push('apiKeyEnv')
    if ((stored.maxDollars ?? null) !== pins.maxDollars) diffs.push('maxDollars')
    if (stored.priceSnapshot !== undefined && stored.priceSnapshot !== pins.priceSnapshot) diffs.push('priceSnapshot')
    if (stored.accountingConfigSha256 !== undefined && stored.accountingConfigSha256 !== pins.accountingConfigSha256) {
      diffs.push('accountingConfigSha256')
    }
    return diffs
  }

  let finished = 0
  let failed = 0
  let launched = 0
  const recordQueue = createSerialQueue()

  /**
   * One interleaved plan entry: isolated scratch + session root, then a
   * serialized append of one complete trials.jsonl line.
   * @param {PlanEntry} entry
   */
  const runPlanEntry = async entry => {
    launched += 1
    if (signal?.aborted) return
    const done = delivered.get(entry.arm)
    if (done !== undefined && done.has(`${entry.taskId}\u0000${entry.trialIndex}`)) return
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
        if (options.resume) {
          // A rerun of an interrupted error trial reuses its slot; the stale
          // roots belong to the failed attempt and are cleared, not flagged.
          await rm(root, { recursive: true, force: true })
        } else {
          violations.push(`session-root-preexisting:${relative(armDir, root).split(sep).join('/')}`)
        }
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
          accountingContext,
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
          accountingContext,
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
        metrics: await partialMetrics(partial, armDir),
        sessionFile: partial?.at(-1)?.sessionFile ?? null,
        ...(partial === undefined ? {} : { phases: [...partial] }),
        priceSnapshot,
        accounting: partial === undefined ? emptyAccounting() : sumPhaseAccounting(partial),
        endedAt: new Date().toISOString(),
      }
    }

    if (signal?.aborted) return

    // Integrity audit, part 2: arms that exclude jspace must log zero jspace
    // events, arms that exclude session-query must log zero session-query
    // tool/call events, a routing arm must log a decision on every session that
    // ran a turn, and a compaction-jev arm must log a verification on every
    // session that compacted. Presence is judged per session against that
    // session's own metrics, because a chain's phases are separate sessions.
    const sessionRecords = trial.phases ?? [{ sessionFile: trial.sessionFile, metrics: trial.metrics }]
    const judgesAdoption = arm.expectsModelRouting === true || arm.expectsCompactionVerification === true
    if (!arm.expectsJspace || !arm.expectsSessionQuery || judgesAdoption) {
      for (const record of sessionRecords) {
        if (record.sessionFile === null) continue
        const facts = await scanSessionLog(join(armDir, record.sessionFile))
        if (!arm.expectsJspace) {
          for (const type of facts.jspaceTypes) {
            violations.push(`off-arm-jspace-event:${type}`)
          }
        }
        if (!arm.expectsSessionQuery) {
          for (const name of facts.sessionQueryTools) {
            violations.push(`excluded-session-query-tool:${name}`)
          }
        }
        if (arm.expectsModelRouting === true && record.metrics.turns >= 1 && facts.routingDecisions === 0) {
          violations.push(`missing-model-routing-decision:turns=${record.metrics.turns}`)
        }
        if (arm.expectsCompactionVerification === true && record.metrics.compactionCount > 0 && facts.compactionVerifications === 0) {
          violations.push(`missing-compaction-verification:compactions=${record.metrics.compactionCount}`)
        }
      }
    }
    if (violations.length > 0) trial.integrity = { violations }

    validateTrial(trial)
    const line = `${JSON.stringify(trial)}\n`
    await recordQueue.enqueue(async () => {
      await appendFile(join(armDir, 'trials.jsonl'), line)
      if (budget !== null && trial.accounting !== undefined) budget.settle(trial.accounting)
      if (trial.status === 'error') failed += 1
      else finished += 1
      print(
        `[${options.experiment}] ${entry.taskId} #${entry.trialIndex} [${entry.arm}] `
        + `${trial.status}${trial.resolved ? ' resolved' : ''}${trial.failureMode ? ` ${trial.failureMode}` : ''}`,
      )
    })
  }

  await mapPool(plan, options.concurrency, runPlanEntry, {
    signal,
    ...(budget === null ? {} : { admit: inFlight => budget.admits(inFlight) }),
  })
  if (signal?.aborted) {
    print(`[${options.experiment}] aborted: ${finished} completed, ${failed} infrastructure errors`)
    return EXIT_ABORTED
  }

  const stop = budget?.stop() ?? null
  if (stop !== null) {
    stop.notLaunched = plan.length - launched
    print(
      `[${options.experiment}] stopped: --max-dollars ${stop.maxDollars} would be exceeded: `
      + `spent $${stop.spentDollars.toFixed(4)} upper bound, projected $${stop.projectedTrialDollars.toFixed(4)} per trial, `
      + `${stop.inFlight} in flight; ${stop.notLaunched} planned trials not launched`,
    )
  }
  if (budget !== null && budget.unpricedCalls() > 0) {
    print(`[${options.experiment}] warning: ${budget.unpricedCalls()} calls had no price in snapshot ${priceSnapshot}; --max-dollars did not count them`)
  }

  const endedAt = new Date().toISOString()
  for (const armName of options.arms) {
    const armDir = /** @type {string} */ (armDirs.get(armName))
    const manifestPath = join(armDir, 'run.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.endedAt = endedAt
    // A resume that finishes the plan clears the stop an earlier run recorded.
    if (stop === null) delete manifest.budgetStop
    else manifest.budgetStop = stop
    validateRunManifest(manifest)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  print(`[${options.experiment}] done: ${finished} completed, ${failed} infrastructure errors`)
  if (stop !== null) return EXIT_BUDGET_STOP
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
