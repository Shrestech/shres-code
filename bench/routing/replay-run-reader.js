/**
 * Offline PR16 run reader: turn one recorded routing run directory into the
 * explicit trial descriptors `hostReplayRun` consumes. Arms come from the
 * registration, every trial is included regardless of status, and unusable
 * trial inputs aggregate into one class-C refusal that names each trial.
 * @module
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { UsageError } from '../runner/run.js'
import { validateTrial } from '../schema/trial.js'
import { decodePhysicalJsonl, TrialInputIncompleteError } from './replay-frontend.js'

/** The registration arms the replay population covers. */
const REPLAY_ARMS = ['S', 'C']

/**
 * The effective route one logged request/header carries, read directly from
 * `header.config`: provider and model always, reasoningEffort when the logged
 * config has it. The `adapterDefaults` provenance markers are ignored for
 * route identity — a resume promotes the effort to explicit without changing
 * the effective call, so marker-only differences are not route changes.
 * @param {{ config: { provider?: unknown, model?: unknown, reasoningEffort?: unknown } }} header - the logged request/header payload.
 * @returns {{ provider: unknown, model: unknown, reasoningEffort?: unknown }}
 */
function ownRouteOf(header) {
  const config = header.config
  const route = { provider: config.provider, model: config.model }
  if (config.reasoningEffort !== undefined) route.reasoningEffort = config.reasoningEffort
  return route
}

/**
 * The canonical real location of `path`, or null when it does not exist.
 * Metadata resolution only; file contents are never read here.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function realLocation(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Whether a real location is the canonical root itself or outside it — a
 * declared child must live strictly below the root.
 * @param {string} canonicalRoot
 * @param {string | null} real - null counts as outside; callers own the missing case.
 * @returns {boolean}
 */
function outsideRoot(canonicalRoot, real) {
  if (real === null) return true
  const within = relative(canonicalRoot, real)
  return within === '' || within === '..' || within.startsWith('../') || isAbsolute(within)
}

/**
 * Read one arm's trials.jsonl from the canonical arm directory: every line is
 * JSON and must pass validateTrial. The record file must resolve inside the
 * arm directory — a symlinked or relative escape refuses the whole arm.
 * @param {string} armName - registration arm letter ('S' or 'C').
 * @param {string} runnerName - the registration's runnerName for that arm.
 * @param {string} canonicalArm - the arm directory under the canonical experiment root.
 * @returns {Promise<import('../schema/trial.js').Trial[]>}
 */
async function readArmTrials(armName, runnerName, canonicalArm) {
  const trialsPath = join(canonicalArm, 'trials.jsonl')
  let info
  try {
    info = await stat(canonicalArm)
  } catch {
    throw new UsageError(`replay arm ${armName} (${runnerName}): missing arm directory ${canonicalArm}`)
  }
  if (!info.isDirectory()) {
    throw new UsageError(`replay arm ${armName} (${runnerName}): ${canonicalArm} is not a directory`)
  }
  const real = await realLocation(trialsPath)
  if (real === null) {
    throw new UsageError(`replay arm ${armName} (${runnerName}): missing trials.jsonl at ${trialsPath}`)
  }
  if (outsideRoot(canonicalArm, real)) {
    throw new UsageError(`replay arm ${armName} (${runnerName}): trials.jsonl resolves outside the arm directory`)
  }
  const text = await readFile(real, 'utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) {
    throw new UsageError(`replay arm ${armName} (${runnerName}): trials.jsonl holds no trials (${trialsPath})`)
  }
  return lines.map((line, index) => {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new UsageError(`replay arm ${armName} (${runnerName}): trials.jsonl line ${index + 1} is not JSON`)
    }
    validateTrial(parsed)
    return parsed
  })
}

/**
 * Read the recorded run under `experimentDir` for the registration's S and C
 * arms: locate each arm by its registration runnerName, validate every trial
 * line, and decode each trial's own route from its session log. Every trial
 * is included regardless of status, resolution or failure mode; chain trials
 * are a population defect and fail the read outright.
 *
 * All file access is confined to declared roots anchored canonically: the
 * experiment directory is resolved once and the arm directory, trials.jsonl,
 * per-trial session directory, session artifact, and task.json must all
 * really (symlinks followed, then verified) live below their declared root —
 * the arm below the experiment, the session artifact below the declaring
 * trial's `sessions/<taskId>/<trialIndex>/`, and task.json below the task
 * root. Absolute or `..`-escaping session paths are refused the same way.
 *
 * Trials with unusable session inputs (no session log, missing file, corrupt
 * log, mixed routes, no request/header, or a session path outside the
 * declared trial directory) are never dropped and never given a fabricated
 * route: they are returned in `refused` as named class-C records — the same
 * identities `hostReplayRun` aggregates — while `trials` holds only the
 * hostable descriptors. `discovered` names every trial id found, so a caller
 * can refuse the whole run after all trials instead of returning a partial
 * one.
 *
 * @param {{ experimentDir: string, registration: { arms: Record<string, { runnerName: string }> }, taskRoot: string }} input
 * @returns {Promise<{ trials: { id: string, taskId: string, trialIndex: number, arm: 'S' | 'C', path: string, trialOwnRoute: { provider: unknown, model: unknown, reasoningEffort?: unknown }, trial: object }[], tasks: Record<string, object>, refused: { id: string, taskId: string, trialIndex: number, arm: 'S' | 'C', path: string | null, reason: string }[], discovered: string[] }>}
 */
export async function readReplayRun({ experimentDir, registration, taskRoot }) {
  const canonicalExperiment = await realLocation(experimentDir)
  if (canonicalExperiment === null) {
    throw new UsageError(`missing experiment directory ${experimentDir}`)
  }
  const armDirs = REPLAY_ARMS.map((armName) => {
    const spec = registration?.arms?.[armName]
    if (typeof spec?.runnerName !== 'string' || spec.runnerName.length === 0) {
      throw new UsageError(`registration does not name a runnerName for replay arm ${armName}`)
    }
    if (spec.runnerName.includes('/') || spec.runnerName.includes('\\') || spec.runnerName === '.' || spec.runnerName === '..') {
      throw new UsageError(`registration runnerName for replay arm ${armName} must be a single path segment`)
    }
    return { armName, runnerName: spec.runnerName, canonicalArm: join(canonicalExperiment, spec.runnerName) }
  })

  const trials = []
  const refused = []
  const discovered = []
  const seenIds = new Set()
  for (const { armName, runnerName, canonicalArm } of armDirs) {
    const records = await readArmTrials(armName, runnerName, canonicalArm)
    for (const trial of records) {
      const id = `${armName}/${trial.taskId}/${trial.trialIndex}`
      discovered.push(id)
      if (seenIds.has(id)) throw new TypeError(`duplicate trial id: ${id}`)
      seenIds.add(id)
      if (trial.phases !== undefined) {
        throw new UsageError(`chain trials are not in the replay population: ${id}`)
      }
      const refusal = (reason, path) => refused.push({
        id, taskId: trial.taskId, trialIndex: trial.trialIndex, arm: armName, path, reason,
      })
      if (trial.sessionFile === null) {
        refusal('no-session-log', null)
        continue
      }
      // The runner records sessionFile relative to the arm directory, always
      // inside sessions/<taskId>/<trialIndex>/ (run.js relative(armDir, …));
      // a record pointing anywhere else names another trial or outside data.
      if (trial.taskId.includes('/') || trial.taskId.includes('\\') || trial.taskId === '.' || trial.taskId === '..') {
        refusal('task-id-not-a-segment', null)
        continue
      }
      if (isAbsolute(trial.sessionFile)) {
        refusal('absolute-session-path', resolve(canonicalArm, trial.sessionFile))
        continue
      }
      const canonicalTrialRoot = join(canonicalArm, 'sessions', trial.taskId, String(trial.trialIndex))
      const declaredPath = resolve(canonicalArm, trial.sessionFile)
      const realArtifact = await realLocation(declaredPath)
      if (realArtifact === null || outsideRoot(canonicalTrialRoot, realArtifact)) {
        refusal('session-path-outside-trial', declaredPath)
        continue
      }
      let decoded
      try {
        decoded = decodePhysicalJsonl(await readFile(realArtifact), declaredPath)
      } catch (error) {
        if (error instanceof TrialInputIncompleteError) {
          refusal('undecodable-log', declaredPath)
          continue
        }
        throw error
      }
      const headers = decoded.events.filter(event => event.type === 'request/header')
      if (headers.length === 0) {
        refusal('no-route-header', declaredPath)
        continue
      }
      const routes = headers.map(header => ownRouteOf(header.data.header))
      const distinct = new Set(routes.map(route => JSON.stringify(route)))
      if (distinct.size > 1) {
        refusal('mixed-route', declaredPath)
        continue
      }
      trials.push({ id, taskId: trial.taskId, trialIndex: trial.trialIndex, arm: armName, path: declaredPath, trialOwnRoute: routes[0], trial })
    }
  }

  const tasks = {}
  const canonicalTaskRoot = await realLocation(taskRoot)
  for (const taskId of new Set(trials.map(trial => trial.taskId))) {
    const declaredTaskPath = join(taskRoot, taskId, 'task.json')
    const realTaskPath = canonicalTaskRoot === null
      ? null
      : await realLocation(join(canonicalTaskRoot, taskId, 'task.json'))
    if (canonicalTaskRoot === null || realTaskPath === null || outsideRoot(canonicalTaskRoot, realTaskPath)) {
      throw new TypeError(`task ${taskId}: task.json must resolve inside the task root (${declaredTaskPath})`)
    }
    let task
    try {
      task = JSON.parse(await readFile(realTaskPath, 'utf8'))
    } catch {
      throw new TypeError(`task ${taskId}: no readable task.json under ${taskRoot}`)
    }
    if (typeof task?.stratum !== 'string') throw new TypeError(`task ${taskId} has no preregistered stratum`)
    tasks[taskId] = task
  }

  return { trials, tasks, refused, discovered }
}
