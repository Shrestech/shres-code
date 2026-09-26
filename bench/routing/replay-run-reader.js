/**
 * Offline PR16 run reader: turn one recorded routing run directory into the
 * explicit trial descriptors `hostReplayRun` consumes. Arms come from the
 * registration, every trial is included regardless of status, and unusable
 * trial inputs aggregate into one class-C refusal that names each trial.
 * @module
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { UsageError } from '../runner/run.js'
import { validateTrial } from '../schema/trial.js'
import { decodePhysicalJsonl, proposalFromHeader, TrialInputIncompleteError } from './replay-frontend.js'

/** The registration arms the replay population covers. */
const REPLAY_ARMS = ['S', 'C']

/**
 * Restrict one request-header proposal to the route fields that identify the
 * trial's own route: provider and model always, reasoningEffort when the
 * proposal kept it (it is absent exactly when the adapter supplied it).
 * @param {ReturnType<typeof proposalFromHeader>} proposal
 * @returns {{ provider: unknown, model: unknown, reasoningEffort?: unknown }}
 */
function ownRouteOf(proposal) {
  const route = { provider: proposal.provider, model: proposal.model }
  if (proposal.reasoningEffort !== undefined) route.reasoningEffort = proposal.reasoningEffort
  return route
}

/**
 * Read one arm's trials.jsonl: every line is JSON and must pass validateTrial.
 * @param {string} armName - registration arm letter ('S' or 'C').
 * @param {string} runnerName - the registration's runnerName for that arm.
 * @param {string} armDir - the arm's directory under the experiment.
 * @returns {Promise<import('../schema/trial.js').Trial[]>}
 */
async function readArmTrials(armName, runnerName, armDir) {
  const trialsPath = join(armDir, 'trials.jsonl')
  let info
  try {
    info = await stat(armDir)
  } catch {
    throw new UsageError(`replay arm ${armName} (${runnerName}): missing arm directory ${armDir}`)
  }
  if (!info.isDirectory()) {
    throw new UsageError(`replay arm ${armName} (${runnerName}): ${armDir} is not a directory`)
  }
  let text
  try {
    text = await readFile(trialsPath, 'utf8')
  } catch {
    throw new UsageError(`replay arm ${armName} (${runnerName}): missing trials.jsonl at ${trialsPath}`)
  }
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
 * Trials with unusable session inputs (no session log, missing file, corrupt
 * log, mixed routes, no request/header, or a session path outside the
 * declared trial directory) are never dropped and never given a fabricated
 * route: they are returned in `refused` as named class-C records — the same
 * identities `hostReplayRun` aggregates — while `trials` holds only the
 * hostable descriptors. `discovered` names every trial found, so a caller
 * can refuse the whole run after all trials instead of returning a partial
 * one.
 *
 * @param {{ experimentDir: string, registration: { arms: Record<string, { runnerName: string }> }, taskRoot: string }} input
 * @returns {Promise<{ trials: { id: string, taskId: string, trialIndex: number, arm: 'S' | 'C', path: string, trialOwnRoute: { provider: unknown, model: unknown, reasoningEffort?: unknown }, trial: object }[], tasks: Record<string, object>, refused: { id: string, taskId: string, trialIndex: number, arm: 'S' | 'C', path?: string, trialId?: string, reason: string }[], discovered: { id: string, taskId: string, trialIndex: number, arm: 'S' | 'C' }[] }>}
 */
export async function readReplayRun({ experimentDir, registration, taskRoot }) {
  const armDirs = REPLAY_ARMS.map((armName) => {
    const spec = registration?.arms?.[armName]
    if (typeof spec?.runnerName !== 'string' || spec.runnerName.length === 0) {
      throw new UsageError(`registration does not name a runnerName for replay arm ${armName}`)
    }
    if (spec.runnerName.includes('/') || spec.runnerName.includes('\\') || spec.runnerName === '.' || spec.runnerName === '..') {
      throw new UsageError(`registration runnerName for replay arm ${armName} must be a single path segment`)
    }
    return { armName, runnerName: spec.runnerName, dir: join(experimentDir, spec.runnerName) }
  })

  const trials = []
  const refused = []
  const discovered = []
  for (const { armName, runnerName, dir } of armDirs) {
    const records = await readArmTrials(armName, runnerName, dir)
    for (const trial of records) {
      const id = `${armName}/${trial.taskId}/${trial.trialIndex}`
      discovered.push({ id, taskId: trial.taskId, trialIndex: trial.trialIndex, arm: armName })
      if (trial.phases !== undefined) {
        throw new UsageError(`chain trials are not in the replay population: ${id}`)
      }
      const refusal = (reason, extra = {}) => refused.push({
        id, taskId: trial.taskId, trialIndex: trial.trialIndex, arm: armName, ...extra, reason,
      })
      if (trial.sessionFile === null) {
        refusal('no session log', { trialId: id })
        continue
      }
      // The runner records sessionFile relative to the arm directory, always
      // inside sessions/<taskId>/<trialIndex>/ (run.js relative(armDir, …));
      // a record pointing anywhere else names another trial or outside data.
      if (trial.taskId.includes('/') || trial.taskId.includes('\\') || trial.taskId === '.' || trial.taskId === '..') {
        refusal('trial task id is not a single path segment', { trialId: id })
        continue
      }
      if (isAbsolute(trial.sessionFile)) {
        refusal('session log path is absolute', { trialId: id })
        continue
      }
      const trialRoot = resolve(dir, 'sessions', trial.taskId, String(trial.trialIndex))
      const path = resolve(dir, trial.sessionFile)
      const within = relative(trialRoot, path)
      if (within === '' || within === '..' || within.startsWith('../') || isAbsolute(within)) {
        refusal('session log path is outside the declared trial directory', { path, trialId: id })
        continue
      }
      let decoded
      try {
        decoded = decodePhysicalJsonl(await readFile(path), path)
      } catch (error) {
        if (error instanceof TrialInputIncompleteError) {
          refusal(error.message, { path, trialId: id })
          continue
        }
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          refusal('session log is missing', { path, trialId: id })
          continue
        }
        throw error
      }
      const headers = decoded.events.filter(event => event.type === 'request/header')
      if (headers.length === 0) {
        refusal('trial log has no request/header', { path, trialId: id })
        continue
      }
      const routes = headers.map(header => ownRouteOf(proposalFromHeader(header.data.header)))
      const distinct = new Set(routes.map(route => JSON.stringify(route)))
      if (distinct.size > 1) {
        refusal('mixed-route trial', { path, trialId: id })
        continue
      }
      trials.push({ id, taskId: trial.taskId, trialIndex: trial.trialIndex, arm: armName, path, trialOwnRoute: routes[0], trial })
    }
  }

  const tasks = {}
  for (const taskId of new Set(trials.map(trial => trial.taskId))) {
    const taskPath = join(taskRoot, taskId, 'task.json')
    let task
    try {
      task = JSON.parse(await readFile(taskPath, 'utf8'))
    } catch {
      throw new TypeError(`task ${taskId}: no readable task.json under ${taskRoot}`)
    }
    if (typeof task?.stratum !== 'string') throw new TypeError(`task ${taskId} has no preregistered stratum`)
    tasks[taskId] = task
  }

  return { trials, tasks, refused, discovered }
}
