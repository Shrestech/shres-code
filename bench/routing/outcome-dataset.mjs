/**
 * Build the frozen generation pilot's task-level outcome dataset.
 *
 * This exporter verifies the completion record, registration inputs, amended
 * analysis, run manifests, trial rows, and session identity evidence before it
 * emits data. It deliberately does not call the live analyzer: the analyzer
 * fingerprints the current worktree, while this dataset is bound to the
 * completed pilot artifacts. No prompt text or per-phase labels are emitted.
 *
 * @module bench/routing/outcome-dataset
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BENCH_ROOT,
  PILOT_ID,
  REPO_ROOT,
  assertTrialRoutesClean,
  classifyBackendIdentity,
  collectObservedIdentities,
  isPilotLabelEligible,
  pilotLabelExclusionReason,
  readTrials,
} from './model-pilot.mjs'

/** The immutable dataset format emitted by this exporter. */
export const OUTCOME_DATASET_SCHEMA = 'shres-code/outcome-supervised-routing-dataset@1'

/** Default completion record from the finished v3 pilot. */
export const DEFAULT_COMPLETION_PATH = join(BENCH_ROOT, 'runs', `${PILOT_ID}-completion.json`)

/** Default frozen registration used by the completed pilot. */
export const DEFAULT_REGISTRATION_PATH = join(BENCH_ROOT, 'routing', `${PILOT_ID}.registration.json`)

/** Default amended analysis artifact. */
export const DEFAULT_ANALYSIS_PATH = join(BENCH_ROOT, 'runs', `${PILOT_ID}-analysis.json`)

/** Default root containing the raw pilot runs. */
export const DEFAULT_RUNS_ROOT = join(BENCH_ROOT, 'runs')

/** Default task catalog whose hashes are pinned by the registration. */
export const DEFAULT_TASKS_ROOT = join(BENCH_ROOT, 'tasks')

/** Default ignored output path. */
export const DEFAULT_OUTPUT_PATH = join(BENCH_ROOT, 'runs', `${PILOT_ID}-outcome-dataset.json`)

/** Compute a lowercase SHA-256 digest. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Convert an absolute repository path to the stable slash-separated form. */
function repoRelative(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/')
}

/** Resolve a recorded relative path without permitting traversal. */
function resolveRecordedPath(repoRoot, recordedPath) {
  if (typeof recordedPath !== 'string' || recordedPath.length === 0 || isAbsolute(recordedPath)) {
    throw new Error(`recorded path is not a safe relative path: ${String(recordedPath)}`)
  }
  const absolute = resolve(repoRoot, recordedPath)
  const prefix = `${resolve(repoRoot)}${sep}`
  if (!absolute.startsWith(prefix)) throw new Error(`recorded path escapes repository: ${recordedPath}`)
  return absolute
}

/** Read and parse a JSON file with a stable diagnostic. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Read one JSONL trial file through the existing schema validator. */
async function readValidatedTrials(path) {
  return await readTrials(path)
}

/** Require a record, naming the path that was expected to contain it. */
function requireRecord(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

/** Require a non-empty string field. */
function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Compare two arrays as exact sets of unique strings. */
function assertSameStringSet(actual, expected, name) {
  if (!Array.isArray(actual) || !actual.every(value => typeof value === 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  const actualSorted = [...actual].sort()
  const expectedSorted = [...expected].sort()
  if (new Set(actualSorted).size !== actualSorted.length || JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${name} differs from the pinned set`)
  }
}

/** Verify one recorded file hash and byte count. */
export function assertPinnedBytes(bytes, record, name = 'file') {
  requireRecord(record, `${name} record`)
  if (record.bytes !== bytes.byteLength) throw new Error(`${name} byte count differs from its pinned artifact`)
  if (record.sha256 !== sha256(bytes)) throw new Error(`${name} hash differs from its pinned artifact`)
}

/** Read a completion-listed file after checking its content address. */
async function readCompletionFile(repoRoot, completion, recordedPath) {
  const files = requireRecord(completion.files, 'completion.files')
  const record = files[recordedPath]
  if (record === undefined) throw new Error(`completion record has no file entry for ${recordedPath}`)
  const path = resolveRecordedPath(repoRoot, recordedPath)
  const bytes = await readFile(path)
  assertPinnedBytes(bytes, record, recordedPath)
  return bytes
}

/** Verify every file retained by the completion record before using any one. */
async function verifyCompletionFiles(repoRoot, completion) {
  const files = requireRecord(completion.files, 'completion.files')
  for (const recordedPath of Object.keys(files).sort()) await readCompletionFile(repoRoot, completion, recordedPath)
}

/** Verify all files in one registered task directory and return safe metadata. */
async function verifyTaskInput(repoRoot, tasksRoot, expected) {
  requireRecord(expected, `task ${String(expected?.taskId)}`)
  const taskId = requireString(expected.taskId, 'registered task id')
  const taskRoot = resolve(tasksRoot, taskId)
  const expectedFiles = expected.files
  if (!Array.isArray(expectedFiles) || !expectedFiles.every(file => typeof file === 'string')) {
    throw new Error(`${taskId} registration has no file list`)
  }
  const actualFiles = []
  async function walk(root) {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) actualFiles.push(repoRelative(repoRoot, path))
    }
  }
  await walk(taskRoot)
  assertSameStringSet(actualFiles, expectedFiles, `${taskId} task files`)
  const entries = []
  // Keep the recursive directory order used by model-pilot.taskFingerprint;
  // the order is part of that content address, even though membership was
  // checked independently above.
  for (const path of actualFiles) {
    const bytes = await readFile(resolveRecordedPath(repoRoot, path))
    entries.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength })
  }
  if (expected.sha256 !== sha256(JSON.stringify(entries))) throw new Error(`${taskId} task hash differs from its registration`)
  const definition = await readJson(join(taskRoot, 'task.json'))
  requireRecord(definition, `${taskId} task.json`)
  if (definition.taskId !== taskId) throw new Error(`${taskId} task.json id differs from its directory`)
  if (typeof definition.stratum !== 'string' || typeof definition.description !== 'string') {
    throw new Error(`${taskId} task.json has incomplete metadata`)
  }
  const phaseCount = Array.isArray(definition.phases) ? definition.phases.length : 1
  return { taskId, sha256: expected.sha256, stratum: definition.stratum, description: definition.description, phaseCount }
}

/** Verify registered tier patch bytes and return their stable records. */
async function verifyConfigInputs(repoRoot, registration) {
  const inputs = requireRecord(registration.inputs, 'registration.inputs')
  const configs = inputs.configs
  if (!Array.isArray(configs)) throw new Error('registration.inputs.configs must be an array')
  const result = new Map()
  for (const config of configs) {
    requireRecord(config, 'registration config')
    const path = requireString(config.path, 'registration config path')
    const bytes = await readFile(resolveRecordedPath(repoRoot, path))
    assertPinnedBytes(bytes, config, path)
    result.set(path, { path, sha256: config.sha256, bytes: config.bytes })
  }
  return result
}

/** Return all session paths referenced by one whole-task trial. */
function sessionFilesForTrial(trial) {
  const files = []
  if (Array.isArray(trial.phases)) {
    for (const phase of trial.phases) {
      if (typeof phase === 'object' && phase !== null && typeof phase.sessionFile === 'string') files.push(phase.sessionFile)
    }
  }
  if (typeof trial.sessionFile === 'string') files.push(trial.sessionFile)
  return [...new Set(files)]
}

/** Return the metrics retained as observations without inventing a price. */
function outcomeMetrics(trial) {
  const metrics = requireRecord(trial.metrics, 'trial.metrics')
  return {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    durationMs: metrics.durationMs,
    tokensIncludingDescendants: metrics.tokensIncludingDescendants,
  }
}

/** Build one task-level row from a raw trial and its session evidence. */
async function buildOutcomeRow(trial, model, armRoot, taskMetadata) {
  const identities = await collectObservedIdentities([trial], armRoot)
  assertTrialRoutesClean(trial, identities, model)
  const backendIdentity = classifyBackendIdentity(model, identities.responseModelIds)
  const exclusionReason = pilotLabelExclusionReason(trial, identities, model)
  const eligible = isPilotLabelEligible(trial, identities, model)
  const resolved = typeof trial.resolved === 'boolean' ? trial.resolved : null
  return {
    taskId: trial.taskId,
    trialIndex: trial.trialIndex,
    task: {
      stratum: taskMetadata.stratum,
      description: taskMetadata.description,
      phaseCount: taskMetadata.phaseCount,
      sha256: taskMetadata.sha256,
    },
    service: {
      id: model.id,
      configuredIdentifier: model.configuredIdentifier,
      provider: model.provider,
      requestedModel: model.model,
      resolution: model.resolution,
    },
    quality: {
      granularity: 'task-trial',
      eligible,
      resolved: eligible ? resolved : null,
      failureMode: trial.failureMode ?? null,
      exclusionReason,
    },
    metrics: outcomeMetrics(trial),
    identity: {
      requestRoutes: identities.requestRoutes,
      responseRoutes: identities.responseRoutes,
      backendIdentity,
      responseModelIds: identities.responseModelIds,
      responseIds: identities.responseIds,
    },
    evidence: {
      status: trial.status,
      sessionFiles: sessionFilesForTrial(trial),
    },
  }
}

/** Build paired rows without choosing a preferred service. */
export function pairOutcomeRows(rows, serviceIds, taskIds, repeats) {
  if (!Array.isArray(serviceIds) || serviceIds.length !== 2 || new Set(serviceIds).size !== serviceIds.length) {
    throw new Error('paired dataset requires exactly two distinct service ids')
  }
  const expectedKeys = []
  for (const taskId of taskIds) for (let trialIndex = 0; trialIndex < repeats; trialIndex += 1) {
    expectedKeys.push(`${taskId}\u0000${trialIndex}`)
  }
  const byService = new Map(serviceIds.map(id => [id, new Map()]))
  for (const row of rows) {
    if (!byService.has(row.service.id)) throw new Error(`row names an unregistered service ${String(row.service.id)}`)
    const key = `${row.taskId}\u0000${row.trialIndex}`
    const map = byService.get(row.service.id)
    if (map.has(key)) throw new Error(`duplicate outcome row ${row.service.id} ${key.replace('\u0000', '#')}`)
    map.set(key, row)
  }
  for (const [serviceId, map] of byService) {
    const actual = [...map.keys()].sort()
    const expected = [...expectedKeys].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const missing = expected.filter(key => !map.has(key)).map(key => key.replace('\u0000', '#'))
      const extra = actual.filter(key => !expectedKeys.includes(key)).map(key => key.replace('\u0000', '#'))
      throw new Error(`${serviceId} outcome rows do not match the frozen task-repeat set; missing=${missing.join(',')} extra=${extra.join(',')}`)
    }
  }
  const pairs = []
  const excluded = []
  const left = byService.get(serviceIds[0])
  const right = byService.get(serviceIds[1])
  for (const key of expectedKeys.sort()) {
    const leftRow = left.get(key)
    const rightRow = right.get(key)
    if (leftRow.quality.eligible !== true || rightRow.quality.eligible !== true) {
      excluded.push({ taskId: leftRow.taskId, trialIndex: leftRow.trialIndex, reasons: [leftRow.quality.exclusionReason, rightRow.quality.exclusionReason] })
      continue
    }
    pairs.push({
      taskId: leftRow.taskId,
      trialIndex: leftRow.trialIndex,
      serviceIds: [...serviceIds],
      outcomes: {
        [serviceIds[0]]: { resolved: leftRow.quality.resolved, metrics: leftRow.metrics, backendIdentity: leftRow.identity.backendIdentity },
        [serviceIds[1]]: { resolved: rightRow.quality.resolved, metrics: rightRow.metrics, backendIdentity: rightRow.identity.backendIdentity },
      },
    })
  }
  return { pairs, excluded }
}

/** Reject an analysis identity that misrepresents raw provider evidence. */
export function assertAnalysisBackendIdentity(analysisModel, observedModel, rawBackendIdentity) {
  requireRecord(analysisModel, 'analysis model')
  requireRecord(observedModel, 'registered model')
  if (analysisModel.id !== observedModel.id) throw new Error(`analysis model id differs for ${observedModel.id}`)
  if (analysisModel.resolution !== observedModel.resolution) throw new Error(`${observedModel.id} analysis resolution differs from registration`)
  const analysisIdentity = requireRecord(analysisModel.backendIdentity, `${observedModel.id} analysis backend identity`)
  if (analysisIdentity.status !== rawBackendIdentity.status
    || analysisIdentity.configuredModel !== rawBackendIdentity.configuredModel
    || JSON.stringify(analysisIdentity.responseModelIds) !== JSON.stringify(rawBackendIdentity.responseModelIds)) {
    throw new Error(`${observedModel.id} analysis backend identity misrepresents raw response evidence`)
  }
  if (analysisModel.configuredIdentifier !== observedModel.configuredIdentifier) {
    throw new Error(`${observedModel.id} analysis configured identifier differs from registration`)
  }
}

/** Verify the frozen completion and registration relationship. */
function verifyCompletionMetadata(completion, registration, registrationBytes) {
  if (completion.schema_version !== 1) throw new Error('unsupported completion schema')
  if (completion.registration_sha256 !== sha256(registrationBytes)) throw new Error('completion registration hash differs from registration bytes')
  const harness = requireRecord(registration.harness, 'registration.harness')
  if (completion.registered_source_snapshot !== harness.sourceSnapshotCommit) throw new Error('completion source snapshot differs from registration')
  if (completion.registered_worktree_fingerprint !== harness.workingTreeSha256) throw new Error('completion worktree fingerprint differs from registration')
  if (completion.source_fingerprint_verified_by_analyzer !== true) throw new Error('completion lacks verified source fingerprint evidence')
  if (completion.analysis_exit_code !== 0 || completion.launcher_exit_code !== 0) throw new Error('completion does not record successful final analysis and launch')
  if (completion.release_eligible !== false || completion.routing_replacement_eligible !== false) {
    throw new Error('completion incorrectly promotes the descriptive pilot')
  }
}

/** Validate the registration fields needed to form a two-service paired dataset. */
function verifyRegistration(registration) {
  if (registration.status !== 'pre-registered') throw new Error('registration is not pre-registered')
  const pilot = requireString(registration.pilot, 'registration.pilot')
  if (pilot !== PILOT_ID) throw new Error(`registration is not ${PILOT_ID}`)
  const models = registration.models
  if (!Array.isArray(models) || models.length !== 2) throw new Error('registration must contain exactly two services')
  const ids = models.map(model => requireString(model.id, 'registration model id'))
  if (new Set(ids).size !== ids.length) throw new Error('registration model ids must be unique')
  for (const model of models) {
    requireString(model.provider, `${model.id} provider`)
    requireString(model.model, `${model.id} model`)
    requireString(model.configuredIdentifier, `${model.id} configuredIdentifier`)
    if (model.configuredIdentifier !== `${model.provider}/${model.model}`) throw new Error(`${model.id} configuredIdentifier differs from provider/model`)
    if (model.resolution !== 'configured-service') throw new Error(`${model.id} is not a configured-service record`)
    requireString(model.tierPatch, `${model.id} tierPatch`)
    requireString(model.experiment, `${model.id} experiment`)
  }
  const shared = requireRecord(registration.shared, 'registration.shared')
  if (shared.arm !== 'off') throw new Error('outcome dataset requires the direct off arm')
  if (!Number.isSafeInteger(shared.repeats) || shared.repeats < 1) throw new Error('registration repeats must be positive')
  if (!Array.isArray(shared.taskIds) || shared.taskIds.length === 0 || new Set(shared.taskIds).size !== shared.taskIds.length) {
    throw new Error('registration taskIds must be unique and non-empty')
  }
  return { models, shared }
}

/** Compare the final analysis summary with recomputed raw rows. */
function assertAnalysisSummary(analysisModel, rows) {
  const summary = requireRecord(analysisModel.summary, `${analysisModel.id} analysis summary`)
  const labelRows = rows.filter(row => row.quality.eligible)
  const resolved = labelRows.filter(row => row.quality.resolved === true).length
  const tokens = labelRows.map(row => row.metrics.inputTokens + row.metrics.outputTokens)
  const durations = labelRows.map(row => row.metrics.durationMs)
  const mean = values => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  const expected = {
    rows: rows.length,
    labelRows: labelRows.length,
    resolved,
    unresolved: labelRows.length - resolved,
    accuracy: labelRows.length === 0 ? null : resolved / labelRows.length,
    tokenRows: tokens.length,
    meanNonCacheTokens: mean(tokens),
    latencyRows: durations.length,
    meanDurationMs: mean(durations),
  }
  for (const key of Object.keys(expected)) {
    const actual = summary[key]
    const wanted = expected[key]
    if (typeof wanted === 'number' && typeof actual === 'number' && Math.abs(actual - wanted) < 1e-9) continue
    if (actual !== wanted) throw new Error(`${analysisModel.id} analysis summary ${key} differs from raw trials`)
  }
}

/** Build the complete outcome-only dataset from frozen artifacts. */
export async function buildOutcomeDataset(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT)
  const completionPath = resolve(options.completionPath ?? DEFAULT_COMPLETION_PATH)
  const registrationPath = resolve(options.registrationPath ?? DEFAULT_REGISTRATION_PATH)
  const analysisPath = resolve(options.analysisPath ?? DEFAULT_ANALYSIS_PATH)
  const runsRoot = resolve(options.runsRoot ?? DEFAULT_RUNS_ROOT)
  const tasksRoot = resolve(options.tasksRoot ?? DEFAULT_TASKS_ROOT)
  const completionBytes = await readFile(completionPath)
  const completion = requireRecord(JSON.parse(completionBytes), 'completion')
  const registrationBytes = await readFile(registrationPath)
  const registration = requireRecord(JSON.parse(registrationBytes), 'registration')
  const { models, shared } = verifyRegistration(registration)
  verifyCompletionMetadata(completion, registration, registrationBytes)
  await verifyCompletionFiles(repoRoot, completion)
  const analysisRecordedPath = repoRelative(repoRoot, analysisPath)
  const analysisBytes = await readCompletionFile(repoRoot, completion, analysisRecordedPath)
  const analysis = requireRecord(JSON.parse(analysisBytes), 'analysis')
  if (analysis.schema !== 'shres-code/generation-model-pilot-analysis@1' || analysis.pilot !== registration.pilot || analysis.status !== 'descriptive') {
    throw new Error('analysis is not the finalized descriptive generation pilot analysis')
  }
  const configRecords = await verifyConfigInputs(repoRoot, registration)
  const taskInputs = requireRecord(registration.inputs, 'registration.inputs').tasks
  if (!Array.isArray(taskInputs)) throw new Error('registration.inputs.tasks must be an array')
  const taskInputById = new Map()
  for (const input of taskInputs) {
    const taskId = requireString(input.taskId, 'registered task id')
    if (taskInputById.has(taskId)) throw new Error(`duplicate registered task ${taskId}`)
    taskInputById.set(taskId, input)
  }
  assertSameStringSet([...taskInputById.keys()], shared.taskIds, 'registered task membership')
  const taskMetadata = new Map()
  for (const taskId of [...shared.taskIds].sort()) {
    const input = taskInputById.get(taskId)
    if (input === undefined) throw new Error(`missing registered task input ${taskId}`)
    taskMetadata.set(taskId, await verifyTaskInput(repoRoot, tasksRoot, input))
  }

  const allRows = []
  const serviceRecords = []
  const analysisModels = analysis.models
  if (!Array.isArray(analysisModels)) throw new Error('analysis.models must be an array')
  const analysisById = new Map(analysisModels.map(model => [model.id, model]))
  for (const model of models) {
    const analysisModel = analysisById.get(model.id)
    if (analysisModel === undefined) throw new Error(`analysis has no model ${model.id}`)
    const tierConfig = configRecords.get(model.tierPatch)
    if (tierConfig === undefined) throw new Error(`${model.id} tier patch is not pinned in registration inputs`)
    const armRoot = join(runsRoot, model.experiment, 'off')
    const manifestRecordedPath = repoRelative(repoRoot, join(armRoot, 'run.json'))
    const trialsRecordedPath = repoRelative(repoRoot, join(armRoot, 'trials.jsonl'))
    const manifestBytes = await readCompletionFile(repoRoot, completion, manifestRecordedPath)
    const trialsBytes = await readCompletionFile(repoRoot, completion, trialsRecordedPath)
    const manifest = requireRecord(JSON.parse(manifestBytes), `${model.id} run manifest`)
    if (manifest.experiment !== model.experiment || manifest.arm !== 'off' || manifest.model !== model.model
      || manifest.temperature !== shared.temperature || manifest.repeats !== shared.repeats
      || manifest.maxTotalTokens !== shared.maxTotalTokensPerSpawn || manifest.apiKeyEnv !== model.apiKeyEnv) {
      throw new Error(`${model.id} run manifest differs from the registered service`)
    }
    assertSameStringSet(manifest.taskIds, shared.taskIds, `${model.id} manifest task membership`)
    const expectedPatch = { path: model.tierPatch.replace(/^bench\//, ''), sha256: tierConfig.sha256 }
    if (JSON.stringify(manifest.tierPatches) !== JSON.stringify([expectedPatch])) throw new Error(`${model.id} run manifest tier patch differs from registration`)
    if (typeof manifest.endedAt !== 'string' || manifest.endedAt.length === 0) throw new Error(`${model.id} run is not complete`)
    const trials = await readValidatedTrials(join(armRoot, 'trials.jsonl'))
    const expectedTrialCount = shared.taskIds.length * shared.repeats
    if (trials.length !== expectedTrialCount) throw new Error(`${model.id} has ${trials.length} rows; expected ${expectedTrialCount}`)
    const rows = []
    const seen = new Set()
    for (const trial of trials) {
      const key = `${trial.taskId}\u0000${trial.trialIndex}`
      if (seen.has(key)) throw new Error(`duplicate outcome row ${model.id} ${key.replace('\u0000', '#')}`)
      seen.add(key)
      const metadata = taskMetadata.get(trial.taskId)
      if (metadata === undefined) throw new Error(`${model.id} trial names an unregistered task ${trial.taskId}`)
      rows.push(await buildOutcomeRow(trial, model, armRoot, metadata))
    }
    const expectedKeys = []
    for (const taskId of shared.taskIds) for (let trialIndex = 0; trialIndex < shared.repeats; trialIndex += 1) expectedKeys.push(`${taskId}\u0000${trialIndex}`)
    assertSameStringSet([...seen], expectedKeys, `${model.id} trial coverage`)
    const rawBackendIdentity = classifyBackendIdentity(model, [...new Set(rows.flatMap(row => row.identity.backendIdentity.responseModelIds))].sort())
    assertAnalysisBackendIdentity(analysisModel, model, rawBackendIdentity)
    assertAnalysisSummary(analysisModel, rows)
    const observedRequestRoutes = [...new Map(rows.flatMap(row => row.identity.requestRoutes).map(route => [`${route.provider}\u0000${route.model}`, route])).values()]
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
    const observedResponseRoutes = [...new Map(rows.flatMap(row => row.identity.responseRoutes).map(route => [`${route.provider}\u0000${route.model}`, route])).values()]
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
    if (JSON.stringify(analysisModel.observedRequestRoutes) !== JSON.stringify(observedRequestRoutes)
      || JSON.stringify(analysisModel.observedResponseRoutes) !== JSON.stringify(observedResponseRoutes)) {
      throw new Error(`${model.id} analysis route evidence differs from raw sessions`)
    }
    allRows.push(...rows)
    serviceRecords.push({
      id: model.id,
      configuredIdentifier: model.configuredIdentifier,
      provider: model.provider,
      requestedModel: model.model,
      resolution: model.resolution,
      tierPatch: { path: model.tierPatch, sha256: tierConfig.sha256, bytes: tierConfig.bytes },
      backendIdentity: rawBackendIdentity,
      run: {
        experiment: model.experiment,
        manifestPath: manifestRecordedPath,
        manifestSha256: sha256(manifestBytes),
        trialsPath: trialsRecordedPath,
        trialsSha256: sha256(trialsBytes),
      },
    })
  }

  const serviceIds = models.map(model => model.id)
  const paired = pairOutcomeRows(allRows, serviceIds, [...shared.taskIds].sort(), shared.repeats)
  const analysisPaired = requireRecord(analysis.paired, 'analysis.paired')
  if (analysisPaired.labelPairs !== paired.pairs.length
    || analysisPaired.leftWins !== paired.pairs.filter(pair => pair.outcomes[serviceIds[0]].resolved && !pair.outcomes[serviceIds[1]].resolved).length
    || analysisPaired.rightWins !== paired.pairs.filter(pair => !pair.outcomes[serviceIds[0]].resolved && pair.outcomes[serviceIds[1]].resolved).length
    || analysisPaired.ties !== paired.pairs.filter(pair => pair.outcomes[serviceIds[0]].resolved === pair.outcomes[serviceIds[1]].resolved).length) {
    throw new Error('analysis paired outcomes differ from raw task-level rows')
  }
  const tokenPairs = paired.pairs.filter(pair => pair.outcomes[serviceIds[0]].metrics.inputTokens !== null
    && pair.outcomes[serviceIds[0]].metrics.inputTokens !== undefined
    && pair.outcomes[serviceIds[1]].metrics.inputTokens !== null
    && pair.outcomes[serviceIds[1]].metrics.inputTokens !== undefined)
  const meanTokens = serviceId => tokenPairs.length === 0 ? null : tokenPairs.reduce((sum, pair) => {
    const metrics = pair.outcomes[serviceId].metrics
    return sum + metrics.inputTokens + metrics.outputTokens
  }, 0) / tokenPairs.length
  if (analysisPaired.tokenPairs !== tokenPairs.length
    || Math.abs(analysisPaired.meanLeftNonCacheTokens - meanTokens(serviceIds[0])) >= 1e-9
    || Math.abs(analysisPaired.meanRightNonCacheTokens - meanTokens(serviceIds[1])) >= 1e-9) {
    throw new Error('analysis paired token observations differ from raw task-level rows')
  }
  return {
    schema: OUTCOME_DATASET_SCHEMA,
    status: 'descriptive',
    pilot: registration.pilot,
    labelGranularity: 'task-trial',
    labels: {
      correctness: 'quality.resolved from the fixture verifier when quality.eligible is true',
      providerErrors: 'retained as unlabelable per-service rows and excluded from paired labels',
      modelJudgments: 'never used as labels',
      cost: 'no billed cost; input/output token fields remain separate observations',
      phases: 'no per-phase labels; chain rows retain one final whole-task outcome',
    },
    features: {
      status: 'pending',
      reason: 'No pinned pre-generation feature projection is present in the pilot artifacts; prompts and phase instructions are omitted rather than reused as step labels.',
    },
    source: {
      completionPath: repoRelative(repoRoot, completionPath),
      completionSha256: sha256(completionBytes),
      registrationPath: repoRelative(repoRoot, registrationPath),
      registrationSha256: sha256(registrationBytes),
      analysisPath: analysisRecordedPath,
      analysisSha256: sha256(analysisBytes),
      registeredSourceSnapshot: registration.harness.sourceSnapshotCommit,
      registeredWorktreeFingerprint: registration.harness.workingTreeSha256,
    },
    taskIds: [...shared.taskIds].sort(),
    repeats: shared.repeats,
    tasks: [...taskMetadata.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    services: serviceRecords,
    rows: allRows.sort((left, right) => left.service.id.localeCompare(right.service.id) || left.taskId.localeCompare(right.taskId) || left.trialIndex - right.trialIndex),
    pairs: paired.pairs.sort((left, right) => left.taskId.localeCompare(right.taskId) || left.trialIndex - right.trialIndex),
    excludedPairs: paired.excluded,
  }
}

/** Parse the bounded CLI. */
function parseArgs(argv) {
  const values = { output: DEFAULT_OUTPUT_PATH, completion: DEFAULT_COMPLETION_PATH, registration: DEFAULT_REGISTRATION_PATH, analysis: DEFAULT_ANALYSIS_PATH }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    if (!['--output', '--completion', '--registration', '--analysis'].includes(flag) || next === undefined || next.startsWith('--')) {
      throw new Error(`usage: node bench/routing/outcome-dataset.mjs [--output PATH] [--completion PATH] [--registration PATH] [--analysis PATH]`)
    }
    values[{ '--output': 'output', '--completion': 'completion', '--registration': 'registration', '--analysis': 'analysis' }[flag]] = next
    index += 1
  }
  return values
}

/** Build and write the ignored dataset artifact. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const dataset = await buildOutcomeDataset({ completionPath: options.completion, registrationPath: options.registration, analysisPath: options.analysis })
  await writeFile(options.output, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ output: options.output, rows: dataset.rows.length, pairs: dataset.pairs.length }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
