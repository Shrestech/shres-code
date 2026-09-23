/**
 * Register, launch, and analyze the bounded two-model generation pilot.
 *
 * The pilot uses the existing verifier-backed bench runner with the same
 * `off` arm and task set for each provider. It records the current dirty-tree
 * fingerprint before a real launch, keeps provider failures in the trial
 * files, and runs a two-trial readiness canary before the larger pilot.
 *
 * Actions:
 *
 * ```
 * node bench/routing/model-pilot.mjs plan
 * node bench/routing/model-pilot.mjs canary --execute
 * node bench/routing/model-pilot.mjs launch --execute
 * node bench/routing/model-pilot.mjs analyze
 * ```
 *
 * `plan` is read-only. `launch` requires `--execute` before it can start the
 * real runner. `analyze` reads completed runner output and never calls a model.
 * Credentials are passed by environment variable name; values are resolved by
 * the runner from the exported environment or its credential store.
 *
 * @module bench/routing/model-pilot
 */

import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'
import { validateTrial } from '../schema/trial.js'

const execFileAsync = promisify(execFile)

/** Repository root containing this bench directory. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Bench root containing the runner and task catalog. */
export const BENCH_ROOT = join(REPO_ROOT, 'bench')

/** Stable pilot identifier used by the registration and run directories. */
export const PILOT_ID = 'generation-model-pilot-2026-09-23-v3'

/** Six tasks cover short, long, chain, adversarial, and pressure strata. */
export const TASK_IDS = Object.freeze([
  'single-function-fix',
  'cross-module-refactor',
  'chain-debug-resume',
  'injection-ignore',
  'constraint-survival-build',
  'noise-needle',
])

/** The short task used by the one-trial-per-model readiness canary. */
export const CANARY_TASK_IDS = Object.freeze(['single-function-fix'])

/** One short trial per model is enough to verify route availability before launch. */
export const CANARY_REPEATS = 1

/** Keep the canary bounded while still allowing the short task to finish. */
export const CANARY_MAX_TOTAL_TOKENS = 32_000

/** Number of identical task repeats per provider. */
export const REPEATS = 3

/** Shared model request temperature. */
export const TEMPERATURE = 0

/** Per-trial root-plus-descendant token ceiling. */
export const MAX_TOTAL_TOKENS = 120_000

/** Sequential execution keeps both providers under the same harness posture. */
export const CONCURRENCY = 1

/** The selected set has six tasks and one two-phase chain task. */
export const SPAWNS_PER_REPEAT = TASK_IDS.length + 1

/**
 * Generation provider/model pairs available through the existing tier overlays.
 * Outcomes describe the configured services during the run. Response metadata
 * can reveal a differing backend name but cannot establish pinned weights.
 */
export const MODELS = Object.freeze([
  Object.freeze({
    id: 'zai-glm-5.3',
    provider: 'zai',
    model: 'glm-5.3',
    configuredIdentifier: 'zai/glm-5.3',
    resolution: 'configured-service',
    apiKeyEnv: 'ZAI_API_KEY',
    tierPatch: 'bench/tiers/zai-glm-5.3.patch.yml',
    canaryExperiment: `${PILOT_ID}-canary-zai`,
    experiment: `${PILOT_ID}-zai`,
  }),
  Object.freeze({
    id: 'ollama-deepseek-v4-flash-cloud',
    provider: 'ollama-cloud',
    model: 'deepseek-v4-flash:cloud',
    configuredIdentifier: 'ollama-cloud/deepseek-v4-flash:cloud',
    resolution: 'configured-service',
    apiKeyEnv: 'OLLAMA_API_KEY',
    tierPatch: 'bench/tiers/ollama-deepseek.patch.yml',
    canaryExperiment: `${PILOT_ID}-canary-ollama`,
    experiment: `${PILOT_ID}-ollama`,
  }),
])

/** Files whose contents define the provider configuration. */
export const CONFIG_FILES = Object.freeze(MODELS.map(model => model.tierPatch))

/** Output registration file; it is excluded from the dirty-tree fingerprint. */
export const REGISTRATION_PATH = join(BENCH_ROOT, 'routing', `${PILOT_ID}.registration.json`)

/** Failure modes that do not provide an observed task-quality label. */
const NON_LABEL_FAILURE_MODES = new Set(['PROVIDER_ERROR', 'HARNESS_ERROR'])

/**
 * Compute a SHA-256 digest of one byte sequence.
 * @param {Uint8Array|string} value - bytes or text to hash.
 * @returns {string} lowercase hexadecimal SHA-256.
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Run a Git command without exposing its environment or credential values.
 * @param {string[]} args - Git arguments.
 * @returns {Promise<Buffer>} command stdout.
 */
async function gitBuffer(args, env = {}) {
  const result = await execFileAsync('git', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
  })
  return result.stdout
}

/**
 * Create a local content-addressed commit for the current working tree using
 * a temporary index. This leaves the user's branch and index untouched while
 * allowing a run record to reconstruct the exact dirty source later.
 * @param {string} head - current HEAD commit.
 * @returns {Promise<{commit: string, ref: string}>} local commit and ref containing the source tree.
 */
async function sourceSnapshotCommit(head) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'shres-model-pilot-index-'))
  const indexPath = join(tempRoot, 'index')
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'shres-model-pilot',
    GIT_AUTHOR_EMAIL: 'shres-model-pilot@localhost',
    GIT_COMMITTER_NAME: 'shres-model-pilot',
    GIT_COMMITTER_EMAIL: 'shres-model-pilot@localhost',
  }
  try {
    await gitBuffer(['read-tree', head], env)
    const changed = nulPaths(await gitBuffer([
      'diff', '--name-only', '-z', 'HEAD', '--', '.',
      ':(exclude)bench/runs/**',
      `:(exclude)bench/routing/${PILOT_ID}.registration.json`,
    ], {}))
    const untracked = nulPaths(await gitBuffer(['ls-files', '--others', '--exclude-standard', '-z'], {}))
      .filter(file => !isGeneratedPilotFile(file))
    const paths = [...new Set([...changed, ...untracked])]
    if (paths.length > 0) await gitBuffer(['add', '-A', '--', ...paths], env)
    const tree = (await gitBuffer(['write-tree'], env)).toString('utf8').trim()
    const ref = `refs/shres/model-pilot/${PILOT_ID}/${tree}`
    const existing = await gitBuffer(['show-ref', '--verify', '--hash', ref], {}).catch(() => Buffer.from(''))
    if (existing.toString('utf8').trim() !== '') return { commit: existing.toString('utf8').trim(), ref }
    const commit = (await gitBuffer(['commit-tree', tree, '-p', head, '-m', `${PILOT_ID} source snapshot`], env)).toString('utf8').trim()
    await gitBuffer(['update-ref', ref, commit, '0000000000000000000000000000000000000000'], {})
    return { commit, ref }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

/**
 * Convert NUL-separated Git output to paths.
 * @param {Buffer} value - NUL-separated stdout.
 * @returns {string[]} decoded paths.
 */
function nulPaths(value) {
  return value.toString('utf8').split('\0').filter(Boolean)
}

/**
 * Files generated by a pilot are excluded from the source fingerprint. Their
 * content records the fingerprint and therefore cannot be part of its input.
 * @param {string} file - repository-relative path.
 * @returns {boolean} whether the path is generated pilot output.
 */
function isGeneratedPilotFile(file) {
  const normalized = file.replaceAll(sep, '/')
  return normalized.startsWith('bench/runs/')
    || normalized === `bench/routing/${PILOT_ID}.registration.json`
}

/**
 * Fingerprint the current HEAD plus tracked and untracked working-tree data.
 * The Git diff includes staged and unstaged changes; untracked, non-ignored
 * files are hashed individually. Generated run output is excluded so a
 * registration remains self-consistent after the runner writes trials.
 * @param {{captureSource?: boolean}} [options] - retain a local source ref when true.
 * @returns {Promise<{head: string, workingTreeSha256: string, sourceCommit: string|null, sourceRef: string|null, untracked: string[]}>}
 */
export async function workingTreeFingerprint(options = {}) {
  const head = (await gitBuffer(['rev-parse', 'HEAD'])).toString('utf8').trim()
  const patch = await gitBuffer([
    'diff', '--binary', 'HEAD', '--', '.',
    ':(exclude)bench/runs/**',
    `:(exclude)bench/routing/${PILOT_ID}.registration.json`,
  ])
  const untrackedPaths = nulPaths(await gitBuffer(['ls-files', '--others', '--exclude-standard', '-z']))
    .filter(file => !isGeneratedPilotFile(file))
    .sort()
  const untracked = []
  for (const file of untrackedPaths) {
    const bytes = await readFile(join(REPO_ROOT, file))
    untracked.push({ path: file.replaceAll(sep, '/'), sha256: sha256(bytes), bytes: bytes.byteLength })
  }
  const sourceSnapshot = options.captureSource === true ? await sourceSnapshotCommit(head) : null
  const digestInput = JSON.stringify({ head, patchSha256: sha256(patch), untracked })
  return {
    head,
    workingTreeSha256: sha256(digestInput),
    sourceCommit: sourceSnapshot?.commit ?? null,
    sourceRef: sourceSnapshot?.ref ?? null,
    untracked: untracked.map(file => file.path),
  }
}

/**
 * Recursively list regular files beneath a task directory.
 * @param {string} root - task directory.
 * @returns {Promise<string[]>} sorted absolute file paths.
 */
async function listRegularFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listRegularFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * Hash one task directory, including its prompt, verifier, setup, and fixture.
 * @param {string} taskId - task directory name.
 * @returns {Promise<{taskId: string, sha256: string, files: string[]}>}
 */
export async function taskFingerprint(taskId) {
  const taskRoot = join(BENCH_ROOT, 'tasks', taskId)
  const files = await listRegularFiles(taskRoot)
  const entries = []
  for (const file of files) {
    const bytes = await readFile(file)
    entries.push({ path: relative(REPO_ROOT, file).split(sep).join('/'), sha256: sha256(bytes), bytes: bytes.byteLength })
  }
  return { taskId, sha256: sha256(JSON.stringify(entries)), files: entries.map(entry => entry.path) }
}

/**
 * Hash all task and tier inputs used by the pilot.
 * @returns {Promise<{tasks: Array<{taskId: string, sha256: string, files: string[]}>, configs: Array<{path: string, sha256: string, bytes: number}>}>}
 */
export async function inputFingerprints() {
  const tasks = []
  for (const taskId of TASK_IDS) tasks.push(await taskFingerprint(taskId))
  const configs = []
  for (const path of CONFIG_FILES) {
    const bytes = await readFile(join(REPO_ROOT, path))
    configs.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength })
  }
  return { tasks, configs }
}

/**
 * Build the immutable registration facts and readiness/main runner argv arrays.
 * @param {{workingTree?: Awaited<ReturnType<typeof workingTreeFingerprint>>, inputs?: Awaited<ReturnType<typeof inputFingerprints>>}} [facts]
 *   Optional precomputed facts for tests or callers that already fingerprinted.
 * @param {{captureSource?: boolean}} [options] - capture and retain a local source ref for a real launch.
 * @returns {Promise<{registration: Record<string, unknown>, canaryCommands: Array<{modelId: string, argv: string[]}>, commands: Array<{modelId: string, argv: string[]}>}>}
 */
export async function buildPilotPlan(facts = {}, options = {}) {
  const workingTree = facts.workingTree ?? await workingTreeFingerprint({ captureSource: options.captureSource === true })
  const inputs = facts.inputs ?? await inputFingerprints()
  const taskSetSha256 = sha256(JSON.stringify(inputs.tasks.map(task => ({ taskId: task.taskId, sha256: task.sha256 }))))
  const sharedArgs = [
    '--arms', 'off',
    '--repeats', String(REPEATS),
    '--tasks', TASK_IDS.join(','),
    '--temperature', String(TEMPERATURE),
    '--concurrency', String(CONCURRENCY),
    '--max-total-tokens', String(MAX_TOTAL_TOKENS),
  ]
  const canarySharedArgs = [
    '--arms', 'off',
    '--repeats', String(CANARY_REPEATS),
    '--tasks', CANARY_TASK_IDS.join(','),
    '--temperature', String(TEMPERATURE),
    '--concurrency', String(CONCURRENCY),
    '--max-total-tokens', String(CANARY_MAX_TOTAL_TOKENS),
  ]
  const canaryCommands = MODELS.map(model => ({
    modelId: model.id,
    argv: [
      'bench/runner/run.js',
      '--experiment', model.canaryExperiment,
      ...canarySharedArgs,
      '--model', model.model,
      '--api-key-env', model.apiKeyEnv,
      '--tier-patch', model.tierPatch,
    ],
  }))
  const commands = MODELS.map(model => ({
    modelId: model.id,
    argv: [
      'bench/runner/run.js',
      '--experiment', model.experiment,
      ...sharedArgs,
      '--model', model.model,
      '--api-key-env', model.apiKeyEnv,
      '--tier-patch', model.tierPatch,
    ],
  }))
  const registration = {
    schema: 'shres-code/generation-model-pilot@1',
    pilot: PILOT_ID,
    status: 'pre-registered',
    purpose: 'Collect verifier-backed task outcomes and reported usage for two configured generation services.',
    decision: 'Descriptive routing supervision only; this pilot cannot promote a model or replace JEV.',
    registeredAt: new Date().toISOString(),
    harness: {
      gitHead: workingTree.head,
      workingTreeSha256: workingTree.workingTreeSha256,
      sourceSnapshotCommit: workingTree.sourceCommit,
      sourceSnapshotRef: workingTree.sourceRef,
      fingerprintExcludes: [`bench/runs/**`, `bench/routing/${PILOT_ID}.registration.json`],
      runner: 'bench/runner/run.js',
    },
    canary: {
      taskIds: CANARY_TASK_IDS,
      repeats: CANARY_REPEATS,
      plannedTrialsTotal: CANARY_TASK_IDS.length * CANARY_REPEATS * MODELS.length,
      plannedSpawnsTotal: CANARY_TASK_IDS.length * CANARY_REPEATS * MODELS.length,
      maxTotalTokensPerSpawn: CANARY_MAX_TOTAL_TOKENS,
      maxTotalTokensSemantics: 'live observed root-plus-descendant usage cap per runner spawn; this canary has no chain phase',
      arm: 'off',
      concurrency: CONCURRENCY,
      noResume: true,
      gate: 'Each service must resolve the short task, exit zero without timeout or budget termination, record a completed turn, and match registered runner pins and request/response routes. A reported different backend model fails readiness. Missing backend metadata remains unknown and supports configured-service evidence only.',
    },
    shared: {
      arm: 'off',
      repeats: REPEATS,
      taskIds: TASK_IDS,
      taskSetSha256,
      temperature: TEMPERATURE,
      concurrency: CONCURRENCY,
      maxTotalTokensPerSpawn: MAX_TOTAL_TOKENS,
      maxTotalTokensSemantics: 'live observed root-plus-descendant usage cap per runner spawn; chain tasks apply the cap separately to each phase',
      plannedTrialsPerModel: TASK_IDS.length * REPEATS,
      plannedTrialsTotal: TASK_IDS.length * REPEATS * MODELS.length,
      plannedSpawnsPerModel: SPAWNS_PER_REPEAT * REPEATS,
      plannedSpawnsTotal: SPAWNS_PER_REPEAT * REPEATS * MODELS.length,
      configuredSpawnTokenCapSum: SPAWNS_PER_REPEAT * REPEATS * MODELS.length * MAX_TOTAL_TOKENS,
      costCurrency: 'reported inputTokens + outputTokens non-cache fields; cache categories are not retained in TrialMetrics and no price table is applied',
    },
    inputs,
    models: MODELS.map(model => ({ ...model })),
    labels: {
      eligible: "status === 'success' and failureMode is not PROVIDER_ERROR or HARNESS_ERROR",
      correctness: 'trial.resolved (runner field derived from verifier outcome)',
      tokenCost: 'trial.metrics.inputTokens + trial.metrics.outputTokens (non-cache usage fields; cache categories are not retained in TrialMetrics)',
      latency: 'trial.metrics.durationMs',
      providerErrors: 'retained in trials.jsonl and counted in analysis, excluded from labels',
      modelJudgments: 'never used as labels',
    },
    nextStep: 'Repeat on a larger random task holdout with a separately frozen routing-quality registration.',
  }
  return { registration, canaryCommands, commands }
}

/**
 * Decide whether a Trial can supply an observed task-quality label.
 * Provider and harness errors remain in the source trial file but cannot be
 * interpreted as model correctness. A verifier failure and an agent timeout
 * are valid unresolved task outcomes, including a local token budget termination.
 * @param {Record<string, unknown>} trial - parsed Trial record.
 * @returns {boolean} whether the trial contributes a correctness label.
 */
export function isLabelEligible(trial) {
  return trial.status === 'success'
    && !NON_LABEL_FAILURE_MODES.has(typeof trial.failureMode === 'string' ? trial.failureMode : '')
    && typeof trial.resolved === 'boolean'
}

/**
 * Read a recorded live-budget stop without treating a legacy null failure mode
 * as proof that no stop occurred.
 * @param {Record<string, unknown>} trial - parsed trial record.
 * @returns {boolean} whether a recorded execution or phase exceeded budget.
 */
function hasRecordedBudgetStop(trial) {
  if (trial.failureMode === 'BUDGET_EXCEEDED') return true
  const execution = trial.execution
  if (typeof execution === 'object' && execution !== null && !Array.isArray(execution)
    && /** @type {Record<string, unknown>} */ (execution).budgetExceeded === true) return true
  if (!Array.isArray(trial.phases)) return false
  return trial.phases.some(phase => {
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) return false
    const record = /** @type {Record<string, unknown>} */ (phase)
    if (record.budgetExceeded === true) return true
    const phaseExecution = record.execution
    return typeof phaseExecution === 'object' && phaseExecution !== null && !Array.isArray(phaseExecution)
      && /** @type {Record<string, unknown>} */ (phaseExecution).budgetExceeded === true
  })
}

/**
 * Whether the runner recorded a termination outcome for this trial.
 * @param {Record<string, unknown>} trial - parsed trial record.
 * @returns {boolean} whether termination evidence is present.
 */
function hasRecordedTermination(trial) {
  if (trial.failureMode === 'BUDGET_EXCEEDED' || trial.failureMode === 'AGENT_TIMEOUT') return true
  const execution = trial.execution
  if (typeof execution === 'object' && execution !== null && !Array.isArray(execution)
    && (typeof /** @type {Record<string, unknown>} */ (execution).budgetExceeded === 'boolean'
      || typeof /** @type {Record<string, unknown>} */ (execution).timedOut === 'boolean')) return true
  if (!Array.isArray(trial.phases)) return false
  return trial.phases.length > 0 && trial.phases.every(phase => {
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) return false
    const record = /** @type {Record<string, unknown>} */ (phase)
    if (typeof record.budgetExceeded === 'boolean' && typeof record.timedOut === 'boolean') return true
    const phaseExecution = record.execution
    return typeof phaseExecution === 'object' && phaseExecution !== null && !Array.isArray(phaseExecution)
      && typeof /** @type {Record<string, unknown>} */ (phaseExecution).budgetExceeded === 'boolean'
      && typeof /** @type {Record<string, unknown>} */ (phaseExecution).timedOut === 'boolean'
  })
}

/**
 * Read one JSONL trial file.
 * @param {string} path - trial file path.
 * @returns {Promise<Record<string, unknown>[]>} parsed trials.
 */
export async function readTrials(path) {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(line => line.trim() !== '').map((line, index) => {
    try {
      const value = JSON.parse(line)
      validateTrial(value)
      return /** @type {Record<string, unknown>} */ (value)
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid trial JSONL (${error instanceof Error ? error.message : String(error)})`)
    }
  })
}

/**
 * Return every session log referenced by a trial, including all chain phases.
 * @param {Record<string, unknown>} trial - parsed trial record.
 * @returns {string[]} relative session paths without duplicates.
 */
function trialSessionFiles(trial) {
  const paths = []
  if (Array.isArray(trial.phases)) {
    for (const phase of trial.phases) {
      if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) continue
      const sessionFile = /** @type {Record<string, unknown>} */ (phase).sessionFile
      if (typeof sessionFile === 'string') paths.push(sessionFile)
    }
  }
  if (typeof trial.sessionFile === 'string') paths.push(trial.sessionFile)
  return [...new Set(paths)]
}

/**
 * Read request and response identity fields from persisted session events.
 * Request headers are the harness-observed route. Assistant provenance is the
 * response route, and a provider response id is included only when an adapter
 * logs one; an alias alone is never promoted to a backend revision claim.
 * @param {Record<string, unknown>[]} trials - parsed trial records.
 * @param {string} armRoot - arm output directory containing session paths.
 * @returns {Promise<{requestRoutes: Array<{provider: string, model: string}>, responseRoutes: Array<{provider: string, model: string}>, responseModelIds: string[], responseIds: string[], assistantMessageIds: string[], turnEnds: Array<{sessionFile: string, turn: number, kind: string}>}>}
 */
export async function collectObservedIdentities(trials, armRoot) {
  const requestRoutes = new Map()
  const responseRoutes = new Map()
  const responseModelIds = new Set()
  const responseIds = new Set()
  const assistantMessageIds = new Set()
  const turnEnds = []
  for (const trial of trials) {
    const sessionFiles = trialSessionFiles(trial)
    if (sessionFiles.length === 0) {
      if (trial.status === 'error') continue
      throw new Error(`${String(trial.taskId)}#${String(trial.trialIndex)} has no session log for a successful trial`)
    }
    for (const sessionFile of sessionFiles) {
      const path = join(armRoot, sessionFile)
      if (!existsSync(path)) {
        throw new Error(`${String(trial.taskId)}#${String(trial.trialIndex)} references missing session log ${sessionFile}`)
      }
      const lines = (await readFile(path, 'utf8')).split('\n')
      for (const line of lines) {
        if (line.trim() === '') continue
        let event
        try {
          event = JSON.parse(line)
        } catch (error) {
          throw new Error(`${path}: invalid session JSON (${error instanceof Error ? error.message : String(error)})`)
        }
        if (typeof event !== 'object' || event === null || Array.isArray(event)) continue
        const data = /** @type {Record<string, unknown>} */ (event).data
        if (event.type === 'turn/end' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
          const { turn, reason } = /** @type {Record<string, unknown>} */ (data)
          if (typeof turn === 'number' && typeof reason === 'object' && reason !== null && !Array.isArray(reason)
            && typeof reason.kind === 'string') turnEnds.push({ sessionFile, turn, kind: reason.kind })
        }
        if (event.type === 'request/header' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
          const header = /** @type {Record<string, unknown>} */ (data).header
          const config = typeof header === 'object' && header !== null && !Array.isArray(header)
            ? /** @type {Record<string, unknown>} */ (header).config
            : null
          const provider = typeof config === 'object' && config !== null && !Array.isArray(config)
            ? /** @type {Record<string, unknown>} */ (config).provider
            : null
          const model = typeof config === 'object' && config !== null && !Array.isArray(config)
            ? /** @type {Record<string, unknown>} */ (config).model
            : null
          if (typeof provider === 'string' && typeof model === 'string') requestRoutes.set(`${provider}\u0000${model}`, { provider, model })
        }
        if (event.type === 'assistant/message' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
          const dataRecord = /** @type {Record<string, unknown>} */ (data)
          const responseId = dataRecord.responseId
          if (typeof responseId === 'string' && responseId.length > 0) responseIds.add(responseId)
          const message = dataRecord.message
          if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
            const messageRecord = /** @type {Record<string, unknown>} */ (message)
            const messageId = messageRecord.id
            if (typeof messageId === 'string' && messageId.length > 0) assistantMessageIds.add(messageId)
            const source = messageRecord.source
            const provider = typeof source === 'object' && source !== null && !Array.isArray(source)
              ? /** @type {Record<string, unknown>} */ (source).provider
              : null
            const model = typeof source === 'object' && source !== null && !Array.isArray(source)
              ? /** @type {Record<string, unknown>} */ (source).model
              : null
            if (typeof provider === 'string' && typeof model === 'string') responseRoutes.set(`${provider}\u0000${model}`, { provider, model })
            const replayState = typeof source === 'object' && source !== null && !Array.isArray(source)
              ? /** @type {Record<string, unknown>} */ (source).replayState
              : null
            const response = typeof replayState === 'object' && replayState !== null && !Array.isArray(replayState)
              ? /** @type {Record<string, unknown>} */ (replayState).response
              : null
            if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
              const responseRecord = /** @type {Record<string, unknown>} */ (response)
              if (typeof responseRecord.responseModel === 'string' && responseRecord.responseModel.length > 0) responseModelIds.add(responseRecord.responseModel)
              if (typeof responseRecord.responseId === 'string' && responseRecord.responseId.length > 0) responseIds.add(responseRecord.responseId)
            }
          }
        }
      }
    }
  }
  const sortRoutes = routes => [...routes.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  return { requestRoutes: sortRoutes(requestRoutes), responseRoutes: sortRoutes(responseRoutes), responseModelIds: [...responseModelIds].sort(), responseIds: [...responseIds].sort(), assistantMessageIds: [...assistantMessageIds].sort(), turnEnds }
}

/**
 * Check that every observed route in one trial names the registered model.
 * @param {Array<{provider: string, model: string}>} routes - observed routes.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {boolean} whether routes exist and all match.
 */
function routesMatchModel(routes, model) {
  return routes.length > 0 && routes.every(route => route.provider === model.provider && route.model === model.model)
}

/**
 * Check that every observed route, when present, names the registered model.
 * @param {Array<{provider: string, model: string}>} routes - observed routes.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {boolean} whether all observed routes match.
 */
function routesAreClean(routes, model) {
  return routes.every(route => route.provider === model.provider && route.model === model.model)
}

/**
 * A verifier outcome is labelable when its request route is present and clean;
 * a resolved outcome also requires a clean response route. An unresolved
 * attempt may end before an assistant response is emitted.
 * @param {Record<string, unknown>} trial - parsed trial record.
 * @param {Record<string, unknown>} identities - per-trial observed identities.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {boolean} whether the trial can supply a model label.
 */
export function isPilotLabelEligible(trial, identities, model) {
  return pilotLabelExclusionReason(trial, identities, model) === null
}

/**
 * Explain why a trial cannot contribute a configured-model quality label.
 * A missing provider-reported backend model is unknown evidence and remains
 * eligible as configured-service data; an observed different model is drift.
 * @param {Record<string, unknown>} trial - parsed trial record.
 * @param {Record<string, unknown>} identities - per-trial observed identities.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {string|null} exclusion reason, or null for an eligible trial.
 */
export function pilotLabelExclusionReason(trial, identities, model) {
  if (!isLabelEligible(trial)) {
    if (trial.status !== 'success') return `status ${String(trial.status)}`
    return `failure mode ${String(trial.failureMode ?? 'unresolved')}`
  }
  const requestRoutes = /** @type {Array<{provider: string, model: string}>} */ (identities.requestRoutes ?? [])
  const responseRoutes = /** @type {Array<{provider: string, model: string}>} */ (identities.responseRoutes ?? [])
  if (!routesMatchModel(requestRoutes, model)) return 'request route evidence is missing or differs from the registered model'
  if (trial.resolved === true && !routesMatchModel(responseRoutes, model)) {
    return 'response route evidence is missing or differs from the registered model'
  }
  if (!routesAreClean(responseRoutes, model)) return 'response route evidence differs from the registered model'
  const responseModelIds = Array.isArray(identities.responseModelIds)
    ? /** @type {string[]} */ (identities.responseModelIds)
    : []
  const backendIdentity = classifyBackendIdentity(model, responseModelIds)
  if (backendIdentity.status === 'drift') {
    return `provider-reported backend model drift: ${responseModelIds.join(', ')}`
  }
  return null
}

/**
 * Refuse a run containing a route from another model or provider.
 * @param {Record<string, unknown>} trial - parsed trial record.
 * @param {Record<string, unknown>} identities - per-trial observed identities.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {void}
 */
export function assertTrialRoutesClean(trial, identities, model) {
  const requestRoutes = /** @type {Array<{provider: string, model: string}>} */ (identities.requestRoutes)
  const responseRoutes = /** @type {Array<{provider: string, model: string}>} */ (identities.responseRoutes)
  if (trial.status === 'success' && requestRoutes.length === 0) {
    throw new Error(`${model.id} trial ${String(trial.taskId)}#${String(trial.trialIndex)} has no observed request route`)
  }
  if (trial.status === 'success' && trial.resolved === true && responseRoutes.length === 0) {
    throw new Error(`${model.id} trial ${String(trial.taskId)}#${String(trial.trialIndex)} has no observed response route`)
  }
  const routes = [
    ...requestRoutes,
    ...responseRoutes,
  ]
  for (const route of routes) {
    if (route.provider !== model.provider || route.model !== model.model) {
      throw new Error(`${model.id} trial ${String(trial.taskId)}#${String(trial.trialIndex)} observed route ${route.provider}/${route.model}`)
    }
  }
}

/**
 * Classify the provider-reported backend model separately from the configured
 * request alias. Empty evidence stays unknown; a differing response model is
 * drift and cannot support a weight-pin claim.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @param {string[]} responseModelIds - provider-reported response models.
 * @returns {{status: 'unknown'|'matched'|'drift', configuredModel: string, responseModelIds: string[]}}
 */
export function classifyBackendIdentity(model, responseModelIds) {
  const status = responseModelIds.length === 0
    ? 'unknown'
    : responseModelIds.every(responseModel => responseModel === model.model) ? 'matched' : 'drift'
  return { status, configuredModel: /** @type {string} */ (model.model), responseModelIds }
}

/**
 * Summarize one model's trial rows while preserving provider-error identities.
 * @param {Record<string, unknown>[]} trials - parsed trial records.
 * @param {(trial: Record<string, unknown>) => boolean} [labelEligibility] - additional label predicate.
 * @returns {Record<string, unknown>} descriptive summary.
 */
export function summarizePilotTrials(trials, labelEligibility = isLabelEligible) {
  const labelRows = trials.filter(labelEligibility)
  const resolved = labelRows.filter(trial => trial.resolved === true).length
  const tokenValues = labelRows
    .map(trial => {
      const metrics = /** @type {Record<string, unknown>} */ (trial.metrics ?? {})
      return typeof metrics.inputTokens === 'number' && typeof metrics.outputTokens === 'number'
        ? metrics.inputTokens + metrics.outputTokens
        : null
    })
    .filter(value => value !== null)
  const latencyValues = labelRows
    .map(trial => {
      const metrics = /** @type {Record<string, unknown>} */ (trial.metrics ?? {})
      return typeof metrics.durationMs === 'number' ? metrics.durationMs : null
    })
    .filter(value => value !== null)
  const providerErrors = trials
    .filter(trial => trial.status === 'error' || trial.failureMode === 'PROVIDER_ERROR')
    .map(trial => ({
      taskId: trial.taskId,
      trialIndex: trial.trialIndex,
      status: trial.status,
      failureMode: trial.failureMode ?? null,
    }))
  const budgetExceeded = trials.filter(hasRecordedBudgetStop).length
  const terminationRecorded = trials.filter(hasRecordedTermination).length
  const terminationUnknown = trials.length - terminationRecorded
  const mean = values => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    rows: trials.length,
    labelRows: labelRows.length,
    resolved,
    unresolved: labelRows.length - resolved,
    accuracy: labelRows.length === 0 ? null : resolved / labelRows.length,
    providerErrors,
    budgetExceeded,
    terminationRecorded,
    terminationUnknown,
    tokenRows: tokenValues.length,
    meanNonCacheTokens: mean(tokenValues),
    latencyRows: latencyValues.length,
    meanDurationMs: mean(latencyValues),
  }
}

/**
 * Pair two model trial sets by task and repeat, retaining only rows that both
 * models can label. Duplicate keys are rejected so a resumed or hand-edited
 * run cannot silently change the pairing denominator.
 * @param {Record<string, unknown>[]} left - first model trials.
 * @param {Record<string, unknown>[]} right - second model trials.
 * @returns {Array<{taskId: string, trialIndex: number, left: boolean, right: boolean, leftNonCacheTokens: number|null, rightNonCacheTokens: number|null}>}
 */
export function pairPilotTrials(left, right) {
  const index = rows => {
    const map = new Map()
    for (const trial of rows) {
      const key = `${String(trial.taskId)}\u0000${String(trial.trialIndex)}`
      if (map.has(key)) throw new Error(`duplicate trial key ${key.replace('\u0000', '#')}`)
      map.set(key, trial)
    }
    return map
  }
  const leftByKey = index(left)
  const rightByKey = index(right)
  const pairs = []
  for (const trial of leftByKey.values()) {
    if (!isLabelEligible(trial)) continue
    const key = `${String(trial.taskId)}\u0000${String(trial.trialIndex)}`
    const other = rightByKey.get(key)
    if (other === undefined || !isLabelEligible(other)) continue
    const leftMetrics = /** @type {Record<string, unknown>} */ (trial.metrics ?? {})
    const rightMetrics = /** @type {Record<string, unknown>} */ (other.metrics ?? {})
    const tokenTotal = metrics => typeof metrics.inputTokens === 'number' && typeof metrics.outputTokens === 'number'
      ? metrics.inputTokens + metrics.outputTokens
      : null
    pairs.push({
      taskId: /** @type {string} */ (trial.taskId),
      trialIndex: /** @type {number} */ (trial.trialIndex),
      left: trial.resolved === true,
      right: other.resolved === true,
      leftNonCacheTokens: tokenTotal(leftMetrics),
      rightNonCacheTokens: tokenTotal(rightMetrics),
    })
  }
  return pairs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.trialIndex - b.trialIndex)
}

/**
 * Analyze one canary arm without treating a configured alias as provider proof.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @param {string} runsRoot - bench runs directory.
 * @param {Record<string, unknown>} registration - frozen pilot registration.
 * @returns {Promise<Record<string, unknown>>} readiness evidence.
 */
export async function analyzeCanary(model, runsRoot, registration) {
  const experiment = /** @type {string} */ (model.canaryExperiment)
  const armRoot = join(runsRoot, experiment, 'off')
  const manifestPath = join(armRoot, 'run.json')
  const trialsPath = join(armRoot, 'trials.jsonl')
  if (!existsSync(manifestPath) || !existsSync(trialsPath)) return { status: 'not-run', experiment }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assertManifestMatches(manifest, { ...registration, shared: { ...registration.shared, ...registration.canary } }, model)
  const trials = await readTrials(trialsPath)
  const identities = await collectObservedIdentities(trials, armRoot)
  const routeObserved = routesMatchModel(identities.requestRoutes, model)
  const responseRouteObserved = routesMatchModel(identities.responseRoutes, model)
  const backendIdentity = classifyBackendIdentity(model, identities.responseModelIds)
  const backendIdentityReady = model.resolution === 'floating-provider-tag' || model.resolution === 'configured-service'
    ? backendIdentity.status !== 'drift'
    : backendIdentity.status === 'matched'
  const taskSucceeded = trials.length === 1
    && trials[0].taskId === CANARY_TASK_IDS[0]
    && trials[0].resolved === true
    && isLabelEligible(trials[0])
  const complete = typeof manifest.endedAt === 'string' && manifest.endedAt.length > 0
  const execution = trials.length === 1 ? trials[0].execution : undefined
  const executionReady = execution?.exitCode === 0 && execution?.timedOut === false && execution?.budgetExceeded === false
  const turnEndObserved = identities.turnEnds.at(-1)?.kind === 'completed'
  return {
    status: complete && taskSucceeded && executionReady && turnEndObserved && routeObserved && responseRouteObserved && backendIdentityReady ? 'passed' : 'failed',
    experiment,
    summary: summarizePilotTrials(trials, trial => isPilotLabelEligible(trial, identities, model)),
    observedRequestRoutes: identities.requestRoutes,
    observedResponseRoutes: identities.responseRoutes,
    backendIdentity,
    backendIdentityReady,
    observedResponseModelIds: identities.responseModelIds,
    observedResponseIds: identities.responseIds,
    assistantMessageIds: identities.assistantMessageIds,
    routeObserved,
    responseRouteObserved,
    complete,
    taskSucceeded,
    executionReady,
    turnEndObserved,
    observedTurnEnds: identities.turnEnds,
  }
}

/**
 * Compare task pins by unique membership while rejecting malformed lists.
 * Runner manifests use catalog order, while registrations may use the
 * caller's requested order; order does not change the measured task set.
 * @param {unknown} actual - task ids recorded by the runner.
 * @param {unknown} expected - task ids in the registration.
 * @returns {boolean} whether both lists contain the same unique string ids.
 */
function sameTaskIdSet(actual, expected) {
  const canonical = value => {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) return null
    const unique = [...new Set(value)]
    return unique.length === value.length ? unique.sort() : null
  }
  const actualIds = canonical(actual)
  const expectedIds = canonical(expected)
  return actualIds !== null
    && expectedIds !== null
    && actualIds.length === expectedIds.length
    && actualIds.every((taskId, index) => taskId === expectedIds[index])
}

/**
 * Reject a result directory whose runner pins differ from registration.
 * @param {Record<string, unknown>} manifest - parsed run manifest.
 * @param {Record<string, unknown>} registration - pilot registration.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {void}
 */
export function assertManifestMatches(manifest, registration, model) {
  const shared = /** @type {Record<string, unknown>} */ (registration.shared)
  const config = /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>} */ (registration.inputs).configs)
    .find(candidate => candidate.path === model.tierPatch)
  if (config === undefined) throw new Error(`${model.id} registration is missing config for ${model.tierPatch}`)
  const expectedPatches = [{ path: model.tierPatch.replace(/^bench\//, ''), sha256: config.sha256 }]
  const actualPatches = Array.isArray(manifest.tierPatches)
    ? manifest.tierPatches.map(patch => ({ path: patch.path, sha256: patch.sha256 }))
    : []
  const mismatches = []
  if (manifest.arm !== 'off') mismatches.push('arm')
  if (manifest.model !== model.model) mismatches.push('model')
  if (manifest.temperature !== shared.temperature) mismatches.push('temperature')
  if (manifest.repeats !== shared.repeats) mismatches.push('repeats')
  if (!sameTaskIdSet(manifest.taskIds, shared.taskIds)) mismatches.push('taskIds')
  if (manifest.maxTotalTokens !== shared.maxTotalTokensPerSpawn) mismatches.push('maxTotalTokens')
  if (manifest.apiKeyEnv !== model.apiKeyEnv) mismatches.push('apiKeyEnv')
  if (JSON.stringify(actualPatches) !== JSON.stringify(expectedPatches)) mismatches.push('tierPatches')
  if (mismatches.length > 0) throw new Error(`${model.id} manifest differs from registration: ${mismatches.join(', ')}`)
}

/**
 * Reject a run that stopped early or has missing, duplicate, or unexpected
 * task/repeat rows.
 * @param {Record<string, unknown>} manifest - parsed run manifest.
 * @param {Record<string, unknown>[]} trials - parsed trial rows.
 * @param {Record<string, unknown>} registration - pilot registration.
 * @param {Record<string, unknown>} model - registered model descriptor.
 * @returns {void}
 */
export function assertPilotRunComplete(manifest, trials, registration, model) {
  const shared = /** @type {Record<string, unknown>} */ (registration.shared)
  if (typeof manifest.endedAt !== 'string' || manifest.endedAt.length === 0) {
    throw new Error(`${model.id} run is incomplete: manifest.endedAt is empty`)
  }
  const taskIds = /** @type {string[]} */ (shared.taskIds)
  const repeats = /** @type {number} */ (shared.repeats)
  const expected = new Set()
  for (const taskId of taskIds) {
    for (let trialIndex = 0; trialIndex < repeats; trialIndex += 1) expected.add(`${taskId}\u0000${trialIndex}`)
  }
  const seen = new Set()
  for (const trial of trials) {
    const key = `${String(trial.taskId)}\u0000${String(trial.trialIndex)}`
    if (!expected.has(key)) throw new Error(`${model.id} run has unexpected trial ${key.replace('\u0000', '#')}`)
    if (seen.has(key)) throw new Error(`${model.id} run has duplicate trial ${key.replace('\u0000', '#')}`)
    seen.add(key)
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter(key => !seen.has(key)).map(key => key.replace('\u0000', '#'))
    throw new Error(`${model.id} run is incomplete: missing ${missing.join(', ')}`)
  }
}

/**
 * Build a descriptive result from the two experiment directories.
 * @param {Record<string, unknown>} registration - registration object.
 * @param {string} runsRoot - bench runs directory.
 * @returns {Promise<Record<string, unknown>>} analysis JSON value.
 */
export async function analyzePilot(registration, runsRoot = join(BENCH_ROOT, 'runs')) {
  const currentSource = await workingTreeFingerprint()
  const registeredHarness = /** @type {Record<string, unknown>} */ (registration.harness)
  if (currentSource.workingTreeSha256 !== registeredHarness.workingTreeSha256) {
    throw new Error('working tree changed after the registered run; refuse quality analysis')
  }
  const models = /** @type {Record<string, unknown>[]} */ (registration.models)
  const analyses = []
  const canary = []
  const trialSets = []
  for (const model of models) {
    const experiment = /** @type {string} */ (model.experiment)
    const armRoot = join(runsRoot, experiment, 'off')
    const manifest = JSON.parse(await readFile(join(armRoot, 'run.json'), 'utf8'))
    assertManifestMatches(manifest, registration, model)
    const trials = await readTrials(join(armRoot, 'trials.jsonl'))
    const identities = await collectObservedIdentities(trials, armRoot)
    assertPilotRunComplete(manifest, trials, registration, model)
    const trialIdentities = new Map()
    const qualityExclusions = []
    for (const trial of trials) {
      const perTrial = await collectObservedIdentities([trial], armRoot)
      assertTrialRoutesClean(trial, perTrial, model)
      const key = `${String(trial.taskId)}\u0000${String(trial.trialIndex)}`
      trialIdentities.set(key, perTrial)
      const exclusionReason = pilotLabelExclusionReason(trial, perTrial, model)
      if (exclusionReason !== null) {
        qualityExclusions.push({
          taskId: trial.taskId,
          trialIndex: trial.trialIndex,
          reason: exclusionReason,
          responseModelIds: perTrial.responseModelIds,
        })
      }
    }
    const labelEligibility = trial => isPilotLabelEligible(
      trial,
      trialIdentities.get(`${String(trial.taskId)}\u0000${String(trial.trialIndex)}`) ?? { requestRoutes: [], responseRoutes: [] },
      model,
    )
    const summary = summarizePilotTrials(trials, labelEligibility)
    const backendIdentity = classifyBackendIdentity(model, identities.responseModelIds)
    analyses.push({
      id: model.id,
      configuredIdentifier: model.configuredIdentifier,
      resolution: model.resolution,
      observedRequestRoutes: identities.requestRoutes,
      observedResponseRoutes: identities.responseRoutes,
      backendIdentity,
      observedResponseModelIds: identities.responseModelIds,
      observedResponseIds: identities.responseIds,
      assistantMessageIds: identities.assistantMessageIds,
      experiment,
      manifest: {
        model: manifest.model,
        provider: model.provider,
        apiKeyEnv: manifest.apiKeyEnv,
        temperature: manifest.temperature,
        repeats: manifest.repeats,
        taskIds: manifest.taskIds,
        maxTotalTokens: manifest.maxTotalTokens ?? null,
        gitCommit: manifest.gitCommit,
        tierPatches: manifest.tierPatches,
      },
      qualityExclusions,
      summary,
    })
    canary.push({ id: model.id, ...(await analyzeCanary(model, runsRoot, registration)) })
    trialSets.push(trials.filter(labelEligibility))
  }
  const pairs = pairPilotTrials(trialSets[0], trialSets[1])
  const tokenPairs = pairs.filter(pair => pair.leftNonCacheTokens !== null && pair.rightNonCacheTokens !== null)
  return {
    schema: 'shres-code/generation-model-pilot-analysis@1',
    pilot: registration.pilot,
    status: 'descriptive',
    canary,
    models: analyses,
    paired: {
      labelPairs: pairs.length,
      leftWins: pairs.filter(pair => pair.left && !pair.right).length,
      rightWins: pairs.filter(pair => !pair.left && pair.right).length,
      ties: pairs.filter(pair => pair.left === pair.right).length,
      tokenPairs: tokenPairs.length,
      meanLeftNonCacheTokens: tokenPairs.length === 0 ? null : tokenPairs.reduce((sum, pair) => sum + pair.leftNonCacheTokens, 0) / tokenPairs.length,
      meanRightNonCacheTokens: tokenPairs.length === 0 ? null : tokenPairs.reduce((sum, pair) => sum + pair.rightNonCacheTokens, 0) / tokenPairs.length,
    },
    limitation: 'This pilot is not promotion evidence; provider tags, task selection, and sample size require a larger frozen holdout before routing replacement.',
  }
}

/**
 * Parse the small pilot CLI.
 * @param {string[]} argv - arguments after the script path.
 * @returns {{action: 'plan'|'canary'|'launch'|'analyze', execute: boolean, registration: string}}
 */
export function parseArgs(argv) {
  const action = argv[0] ?? 'plan'
  if (!['plan', 'canary', 'launch', 'analyze'].includes(action)) throw new Error(`unknown action ${action}`)
  const execute = argv.includes('--execute')
  const registrationIndex = argv.indexOf('--registration')
  const registration = registrationIndex === -1
    ? REGISTRATION_PATH
    : argv[registrationIndex + 1]
  if (registrationIndex !== -1 && (registration === undefined || registration.startsWith('--'))) {
    throw new Error('--registration requires a path')
  }
  for (const arg of argv.slice(1)) {
    if (arg !== '--execute' && arg !== '--registration' && arg !== registration) {
      throw new Error(`unknown argument ${arg}`)
    }
  }
  return { action: /** @type {'plan'|'canary'|'launch'|'analyze'} */ (action), execute, registration }
}

/**
 * Print the registration and exact launch commands without starting a model.
 * @param {{registration: Record<string, unknown>, canaryCommands: Array<{modelId: string, argv: string[]}>, commands: Array<{modelId: string, argv: string[]}>}} plan - pilot plan.
 */
function printPlan(plan) {
  console.log(JSON.stringify(plan.registration, null, 2))
  for (const command of plan.canaryCommands) {
    console.log(`\n# canary ${command.modelId}`)
    console.log(`node ${command.argv.join(' ')}`)
  }
  for (const command of plan.commands) {
    console.log(`\n# ${command.modelId}`)
    console.log(`node ${command.argv.join(' ')}`)
  }
  console.log('\n# Upper bounds')
  console.log(`canary trials: ${CANARY_TASK_IDS.length * CANARY_REPEATS * MODELS.length}`)
  console.log(`canary per-spawn token cap: ${CANARY_MAX_TOTAL_TOKENS}`)
  console.log(`planned trials: ${TASK_IDS.length * REPEATS * MODELS.length}`)
  console.log(`per-spawn token cap: ${MAX_TOTAL_TOKENS}`)
  console.log(`planned runner spawns: ${SPAWNS_PER_REPEAT * REPEATS * MODELS.length}`)
  console.log(`sum of configured pilot spawn caps: ${SPAWNS_PER_REPEAT * REPEATS * MODELS.length * MAX_TOTAL_TOKENS}`)
  console.log('dollar cost: unavailable; no price table is applied')
}

/**
 * Execute one runner command with inherited stdio after registration checks.
 * @param {string[]} argv - runner argv including its script path.
 * @returns {Promise<number>} child exit code.
 */
async function executeRunner(argv) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve(0)
      else reject(new Error(`runner exited ${code === null ? `by ${signal ?? 'signal'}` : `with code ${code}`}`))
    })
  })
}

/**
 * Write a registration exactly once.
 * @param {string} path - registration path.
 * @param {Record<string, unknown>} registration - registration value.
 * @returns {Promise<void>}
 */
async function writeRegistration(path, registration) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(registration, null, 2)}\n`, { flag: 'wx' })
}

/**
 * Reject edited experimental choices independently of the source fingerprint.
 * Registration time and retained source-ref metadata do not change the plan.
 * @param {Record<string, unknown>} registration - recorded pilot registration.
 * @param {Record<string, unknown>} expected - plan built from current pinned inputs.
 * @returns {void}
 */
export function assertRegistrationMatches(registration, expected) {
  const { registeredAt: recordedAt, harness: recordedHarness, ...recordedChoices } = registration
  const { registeredAt: expectedAt, harness: expectedHarness, ...expectedChoices } = expected
  if (!isDeepStrictEqual(recordedChoices, expectedChoices)) {
    throw new Error('registration choices differ from the current pilot plan')
  }
}

/**
 * Read the one-time registration and verify that source inputs did not drift.
 * @param {string} path - registration path.
 * @returns {Promise<Record<string, unknown>>} validated registration.
 */
async function readLaunchRegistration(path) {
  const registration = JSON.parse(await readFile(path, 'utf8'))
  if (registration.pilot !== PILOT_ID || registration.status !== 'pre-registered') {
    throw new Error(`registration is not ${PILOT_ID}`)
  }
  const harness = /** @type {Record<string, unknown>} */ (registration.harness)
  if (typeof harness.sourceSnapshotCommit !== 'string' || typeof harness.sourceSnapshotRef !== 'string') {
    throw new Error('registration has no retained source snapshot')
  }
  const current = await workingTreeFingerprint()
  if (current.workingTreeSha256 !== harness.workingTreeSha256) {
    throw new Error('working tree changed after canary registration; use a new pilot id')
  }
  const inputs = await inputFingerprints()
  if (JSON.stringify(inputs) !== JSON.stringify(registration.inputs)) {
    throw new Error('task or tier inputs changed after canary registration; use a new pilot id')
  }
  const expected = await buildPilotPlan({ workingTree: current, inputs })
  assertRegistrationMatches(registration, expected.registration)
  return registration
}

/**
 * Run both canary commands and collect every failure before refusing the main
 * pilot, so an unavailable provider does not hide independent evidence.
 * @param {{registration: Record<string, unknown>, canaryCommands: Array<{modelId: string, argv: string[]}>}} plan - pilot plan.
 * @param {string} registrationPath - immutable registration file.
 * @returns {Promise<void>}
 */
async function executeCanaries(plan, registrationPath) {
  const failures = []
  for (const command of plan.canaryCommands) {
    await readLaunchRegistration(registrationPath)
    try {
      await executeRunner(command.argv)
      const model = MODELS.find(candidate => candidate.id === command.modelId)
      if (model === undefined) throw new Error(`no model descriptor for ${command.modelId}`)
      const readiness = await analyzeCanary(model, join(BENCH_ROOT, 'runs'), plan.registration)
      if (readiness.status !== 'passed') failures.push(`${command.modelId}: readiness evidence incomplete`)
    } catch (error) {
      failures.push(`${command.modelId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await readLaunchRegistration(registrationPath)
  }
  if (failures.length > 0) throw new Error(`readiness canary failed: ${failures.join('; ')}`)
}

/**
 * Require previously completed canaries before a main launch.
 * @param {Record<string, unknown>} registration - pilot registration.
 * @returns {Promise<void>}
 */
async function requireCanaries(registration) {
  const models = /** @type {Record<string, unknown>[]} */ (registration.models)
  for (const model of models) {
    const evidence = await analyzeCanary(model, join(BENCH_ROOT, 'runs'), registration)
    if (evidence.status !== 'passed') throw new Error(`readiness canary is not passed for ${model.id}`)
  }
}

/**
 * Script entry point. Real launch requires `--execute` to make accidental API
 * calls impossible from the default plan command.
 * @returns {Promise<void>}
 */
export async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.action === 'analyze') {
    const registration = JSON.parse(await readFile(resolve(REPO_ROOT, options.registration), 'utf8'))
    console.log(JSON.stringify(await analyzePilot(registration), null, 2))
    return
  }
  if ((options.action === 'canary' || options.action === 'launch') && !options.execute) {
    throw new Error(`${options.action} is plan-only unless --execute is supplied`)
  }
  if (options.action === 'canary') {
    const registrationPath = resolve(REPO_ROOT, options.registration)
    if (existsSync(registrationPath)) throw new Error(`registration already exists at ${options.registration}; use a new pilot id`)
    const plan = await buildPilotPlan({}, { captureSource: true })
    await writeRegistration(registrationPath, plan.registration)
    await executeCanaries(plan, registrationPath)
    return
  }
  const registrationPath = resolve(REPO_ROOT, options.registration)
  const plan = options.action === 'launch'
    ? await (async () => {
      const registration = await readLaunchRegistration(registrationPath)
      await requireCanaries(registration)
      const workingTree = await workingTreeFingerprint()
      const inputs = await inputFingerprints()
      return buildPilotPlan({ workingTree, inputs })
    })()
    : await buildPilotPlan()
  if (options.action === 'plan') {
    printPlan(plan)
    return
  }
  await readLaunchRegistration(registrationPath)
  for (const command of plan.commands) {
    await executeRunner(command.argv)
    await readLaunchRegistration(registrationPath)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
