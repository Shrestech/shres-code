/**
 * Pure checks for the bounded generation-model pilot registration and result
 * pairing rules.
 *
 * @module bench/tests/model-pilot
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CANARY_MAX_TOTAL_TOKENS,
  CANARY_TASK_IDS,
  MODELS,
  TASK_IDS,
  analyzeCanary,
  assertManifestMatches,
  assertPilotRunComplete,
  assertRegistrationMatches,
  assertTrialRoutesClean,
  buildPilotPlan,
  classifyBackendIdentity,
  collectObservedIdentities,
  isLabelEligible,
  isPilotLabelEligible,
  pairPilotTrials,
  pilotLabelExclusionReason,
  readTrials,
  summarizePilotTrials,
} from '../routing/model-pilot.mjs'
import { emptyMetrics } from '../runner/metrics.js'

/**
 * Fabricate a schema-valid trial for analyzer tests.
 * @param {Record<string, unknown>} [overrides] - fields to replace.
 * @returns {Record<string, unknown>} trial record.
 */
function trial(overrides = {}) {
  const resolved = overrides.resolved ?? true
  return {
    taskId: 'task-a',
    trialIndex: 0,
    arm: 'off',
    status: 'success',
    resolved,
    failureMode: resolved ? null : 'VERIFY_FAILED',
    verifier: { command: 'node verify.mjs', exitCode: resolved ? 0 : 1 },
    metrics: emptyMetrics(),
    sessionFile: null,
    startedAt: '2026-09-23T00:00:00.000Z',
    endedAt: '2026-09-23T00:01:00.000Z',
    ...overrides,
  }
}

const facts = {
  workingTree: {
    head: 'head',
    workingTreeSha256: 'tree',
    sourceCommit: 'source',
    sourceRef: 'refs/shres/model-pilot/test',
    untracked: [],
  },
  inputs: {
    tasks: TASK_IDS.map(taskId => ({ taskId, sha256: `${taskId}-sha`, files: [] })),
    configs: MODELS.map(model => ({ path: model.tierPatch, sha256: `${model.id}-sha`, bytes: 1 })),
  },
}

describe('generation model pilot', () => {
  it('registers a two-trial canary before the fixed main plan', async () => {
    const plan = await buildPilotPlan(facts)
    assert.equal(plan.registration.canary.plannedTrialsTotal, 2)
    assert.equal(plan.registration.canary.maxTotalTokensPerSpawn, CANARY_MAX_TOTAL_TOKENS)
    assert.deepEqual(plan.canaryCommands.map(command => command.argv.slice(0, 5)), [
      ['bench/runner/run.js', '--experiment', `${plan.registration.pilot}-canary-zai`, '--arms', 'off'],
      ['bench/runner/run.js', '--experiment', `${plan.registration.pilot}-canary-ollama`, '--arms', 'off'],
    ])
    assert.equal(plan.commands.length, MODELS.length)
    assert.equal(plan.registration.shared.plannedTrialsTotal, 36)
    assert.match(plan.registration.labels.eligible, /PROVIDER_ERROR or HARNESS_ERROR/)
  })

  it('keeps budget terminations as unresolved quality labels', () => {
    assert.equal(isLabelEligible({ status: 'success', resolved: false, failureMode: 'BUDGET_EXCEEDED' }), true)
    assert.equal(isLabelEligible({ status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR' }), false)
    const summary = summarizePilotTrials([
      { taskId: 'short', trialIndex: 0, status: 'success', resolved: false, failureMode: 'BUDGET_EXCEEDED' },
      { taskId: 'short', trialIndex: 1, status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR' },
    ])
    assert.equal(summary.labelRows, 1)
    assert.equal(summary.unresolved, 1)
    assert.equal(summary.budgetExceeded, 1)
    assert.equal(summary.providerErrors.length, 1)
  })

  it('reads observed request routes and response ids from session logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-model-pilot-'))
    try {
      await mkdir(join(root, 'sessions'), { recursive: true })
      await writeFile(join(root, 'sessions', 'one.jsonl'), [
        JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'zai', model: 'glm-5.2' } } } }),
        JSON.stringify({ type: 'assistant/message', data: { responseId: 'r-1', message: { id: 'm-1', source: { provider: 'zai', model: 'glm-5.2', replayState: { response: { responseModel: 'glm-5.3', responseId: 'r-2' } } } } } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
        JSON.stringify({ type: 'user/message', data: { responseId: 'user-response', message: { id: 'user-1', source: { provider: 'user', model: 'human' } } } }),
        JSON.stringify({ type: 'tool/result', data: { responseId: 'tool-response', message: { id: 'tool-1', source: { provider: 'tool', model: 'result' } } } }),
      ].join('\n') + '\n')
      const identities = await collectObservedIdentities([
        { sessionFile: 'sessions/one.jsonl', phases: [{ sessionFile: 'sessions/one.jsonl' }] },
      ], root)
      assert.deepEqual(identities.requestRoutes, [{ provider: 'zai', model: 'glm-5.2' }])
      assert.deepEqual(identities.responseRoutes, [{ provider: 'zai', model: 'glm-5.2' }])
      assert.deepEqual(identities.responseModelIds, ['glm-5.3'])
      assert.deepEqual(identities.responseIds, ['r-1', 'r-2'])
      assert.deepEqual(identities.assistantMessageIds, ['m-1'])
      assert.deepEqual(identities.turnEnds, [{ sessionFile: 'sessions/one.jsonl', turn: 1, kind: 'completed' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires the registered model patch and complete task-repeat coverage', () => {
    const registration = {
      shared: { taskIds: ['task-a'], repeats: 2, temperature: 0, maxTotalTokensPerSpawn: 120000 },
      inputs: { configs: [{ path: 'bench/tiers/zai.patch.yml', sha256: 'zai-sha' }, { path: 'bench/tiers/ollama.patch.yml', sha256: 'ollama-sha' }] },
    }
    const model = { id: 'zai', tierPatch: 'bench/tiers/zai.patch.yml', model: 'glm-5.2', apiKeyEnv: 'ZAI_API_KEY' }
    const manifest = { arm: 'off', model: 'glm-5.2', temperature: 0, repeats: 2, taskIds: ['task-a'], maxTotalTokens: 120000, apiKeyEnv: 'ZAI_API_KEY', tierPatches: [{ path: 'tiers/zai.patch.yml', sha256: 'zai-sha' }], endedAt: 'done' }
    assert.doesNotThrow(() => assertManifestMatches(manifest, registration, model))
    assert.throws(() => assertManifestMatches({ ...manifest, tierPatches: [{ path: 'tiers/ollama.patch.yml', sha256: 'ollama-sha' }] }, registration, model), /tierPatches/)
    assert.throws(() => assertManifestMatches(manifest, { ...registration, inputs: { configs: [] } }, model), /missing config/)
    const rows = [trial(), trial({ trialIndex: 1 })]
    assert.doesNotThrow(() => assertPilotRunComplete(manifest, rows, registration, model))
    assert.throws(() => assertPilotRunComplete({ ...manifest, endedAt: '' }, rows, registration, model), /endedAt/)
    assert.throws(() => assertPilotRunComplete(manifest, rows.slice(0, 1), registration, model), /missing/)
  })

  it('matches runner-sorted task ids while rejecting duplicate or changed membership', () => {
    const registration = {
      shared: { taskIds: TASK_IDS, repeats: 3, temperature: 0, maxTotalTokensPerSpawn: 120000 },
      inputs: { configs: [{ path: MODELS[0].tierPatch, sha256: 'zai-sha' }] },
    }
    const model = { ...MODELS[0] }
    const manifest = {
      arm: 'off',
      model: model.model,
      temperature: 0,
      repeats: 3,
      taskIds: [...TASK_IDS].sort(),
      maxTotalTokens: 120000,
      apiKeyEnv: model.apiKeyEnv,
      tierPatches: [{ path: model.tierPatch.replace(/^bench\//, ''), sha256: 'zai-sha' }],
      endedAt: 'done',
    }
    assert.doesNotThrow(() => assertManifestMatches(manifest, registration, model))

    const duplicate = [...manifest.taskIds]
    duplicate[duplicate.length - 1] = duplicate[0]
    assert.throws(() => assertManifestMatches({ ...manifest, taskIds: duplicate }, registration, model), /taskIds/)
    assert.throws(() => assertManifestMatches({ ...manifest, taskIds: manifest.taskIds.slice(1) }, registration, model), /taskIds/)
    assert.throws(() => assertManifestMatches({ ...manifest, taskIds: [...manifest.taskIds.slice(1), 'unregistered-task'] }, registration, model), /taskIds/)
  })

  it('rejects semantic registration edits while allowing timestamp and source snapshot changes', async () => {
    const plan = await buildPilotPlan(facts)
    const clone = value => JSON.parse(JSON.stringify(value))
    assert.doesNotThrow(() => assertRegistrationMatches(plan.registration, plan.registration))

    const changedModel = clone(plan.registration)
    changedModel.models[0].model = 'tampered-model'
    assert.throws(() => assertRegistrationMatches(changedModel, plan.registration), /models|registration|mismatch/i)

    const changedCap = clone(plan.registration)
    changedCap.canary.maxTotalTokensPerSpawn += 1
    assert.throws(() => assertRegistrationMatches(changedCap, plan.registration), /canary|registration|mismatch/i)

    const changedProvenance = clone(plan.registration)
    changedProvenance.registeredAt = '2099-01-01T00:00:00.000Z'
    changedProvenance.harness.sourceSnapshotCommit = 'different-source-commit'
    changedProvenance.harness.sourceSnapshotRef = 'refs/shres/model-pilot/different-source'
    assert.doesNotThrow(() => assertRegistrationMatches(changedProvenance, plan.registration))
  })

  it('rejects bare trial rows at the JSONL boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-model-pilot-trials-'))
    try {
      const path = join(root, 'trials.jsonl')
      await writeFile(path, `${JSON.stringify({ taskId: 'task-a', trialIndex: 0 })}\n`)
      await assert.rejects(readTrials(path), /trial\.arm must be a non-empty string/)
      await writeFile(path, `${JSON.stringify(trial())}\n`)
      assert.equal((await readTrials(path)).length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires clean per-trial routes and reports backend identity drift', () => {
    const model = { id: 'zai', provider: 'zai', model: 'glm-5.2' }
    const clean = { requestRoutes: [{ provider: 'zai', model: 'glm-5.2' }], responseRoutes: [{ provider: 'zai', model: 'glm-5.2' }] }
    const cleanTrial = trial()
    const cleanWithUnknownBackend = { ...clean, responseModelIds: [] }
    assert.equal(isPilotLabelEligible(cleanTrial, cleanWithUnknownBackend, model), true)
    assert.doesNotThrow(() => assertTrialRoutesClean(cleanTrial, cleanWithUnknownBackend, model))
    const mixed = { ...clean, responseRoutes: [...clean.responseRoutes, { provider: 'ollama-cloud', model: 'deepseek-v4-flash:cloud' }] }
    assert.equal(isPilotLabelEligible(cleanTrial, mixed, model), false)
    assert.throws(() => assertTrialRoutesClean(cleanTrial, mixed, model), /observed route/)
    const drifted = { ...cleanWithUnknownBackend, responseModelIds: ['glm-5.3'] }
    assert.equal(isPilotLabelEligible(cleanTrial, drifted, model), false)
    assert.match(/** @type {string} */ (pilotLabelExclusionReason(cleanTrial, drifted, model)), /backend model drift/)
    const unresolved = trial({ resolved: false, failureMode: 'AGENT_TIMEOUT' })
    const requestOnly = { requestRoutes: clean.requestRoutes, responseRoutes: [], responseModelIds: [] }
    assert.equal(isPilotLabelEligible(unresolved, requestOnly, model), true)
    assert.equal(summarizePilotTrials([unresolved], candidate => isPilotLabelEligible(candidate, requestOnly, model)).labelRows, 1)
    assert.doesNotThrow(() => assertTrialRoutesClean(unresolved, requestOnly, model))
    assert.throws(() => assertTrialRoutesClean(cleanTrial, requestOnly, model), /no observed response route/)
    assert.throws(() => assertTrialRoutesClean(unresolved, { ...requestOnly, responseRoutes: mixed.responseRoutes }, model), /observed route/)
    assert.equal(classifyBackendIdentity(model, ['glm-5.3']).status, 'drift')
    assert.equal(classifyBackendIdentity({ id: 'ollama', model: 'deepseek-v4-flash:cloud' }, []).status, 'unknown')
  })

  it('requires session evidence for successful trials but permits provider errors before a log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-model-pilot-sessions-'))
    try {
      await assert.rejects(
        collectObservedIdentities([trial({ sessionFile: 'missing.jsonl' })], root),
        /references missing session log/,
      )
      await assert.rejects(
        collectObservedIdentities([trial({ sessionFile: null })], root),
        /has no session log for a successful trial/,
      )
      await assert.doesNotReject(
        collectObservedIdentities([trial({ status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR', sessionFile: null })], root),
      )
      assert.throws(
        () => assertTrialRoutesClean(trial(), { requestRoutes: [], responseRoutes: [] }, { id: 'zai', provider: 'zai', model: 'glm-5.2' }),
        /no observed request route/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails a fixed-model canary on reported backend drift but allows an unknown floating tag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-model-pilot-canary-'))
    try {
      const plan = await buildPilotPlan(facts)
      const registration = plan.registration
      const writeCanary = async (model, experiment, response, options = {}) => {
        const armRoot = join(root, experiment, 'off')
        await mkdir(join(armRoot, 'sessions'), { recursive: true })
        const config = registration.inputs.configs.find(candidate => candidate.path === model.tierPatch)
        assert.ok(config)
        const canary = registration.canary
        await writeFile(join(armRoot, 'run.json'), JSON.stringify({
          version: 1,
          experiment,
          arm: 'off',
          armConfig: {},
          model: model.model,
          baseUrl: null,
          temperature: registration.shared.temperature,
          repeats: canary.repeats,
          taskIds: canary.taskIds,
          gitCommit: 'test',
          apiKeyEnv: model.apiKeyEnv,
          tierPatches: [{ path: model.tierPatch.replace(/^bench\//, ''), sha256: config.sha256 }],
          maxTotalTokens: canary.maxTotalTokensPerSpawn,
          startedAt: '2026-09-23T00:00:00.000Z',
          endedAt: 'done',
        }))
        const execution = Object.hasOwn(options, 'execution')
          ? options.execution
          : { exitCode: 0, timedOut: false, budgetExceeded: false }
        const row = trial({
          taskId: CANARY_TASK_IDS[0],
          sessionFile: 'sessions/one.jsonl',
          ...(execution === undefined ? {} : { execution }),
        })
        await writeFile(join(armRoot, 'trials.jsonl'), `${JSON.stringify(row)}\n`)
        const events = [
          JSON.stringify({ type: 'request/header', data: { header: { config: { provider: model.provider, model: model.model } } } }),
          JSON.stringify({ type: 'assistant/message', data: { message: { id: 'm-1', source: { provider: model.provider, model: model.model, replayState: { response } } } } }),
        ]
        if (options.turnEndKind !== undefined) {
          events.push(JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: options.turnEndKind } } }))
        }
        await writeFile(join(armRoot, 'sessions', 'one.jsonl'), `${events.join('\n')}\n`)
      }
      const fixedModel = { ...MODELS[0], resolution: 'provider-model-id', canaryExperiment: 'fixed' }
      const driftedResponseModel = fixedModel.model === 'glm-5.3' ? 'glm-5.2' : 'glm-5.3'
      await writeCanary(fixedModel, 'fixed', { responseModel: driftedResponseModel }, { turnEndKind: 'completed' })
      const fixed = await analyzeCanary(fixedModel, root, registration)
      assert.equal(fixed.backendIdentity.status, 'drift')
      assert.equal(fixed.taskSucceeded, true)
      assert.equal(fixed.summary.labelRows, 0)
      assert.equal(fixed.executionReady, true)
      assert.equal(fixed.turnEndObserved, true)
      assert.equal(fixed.status, 'failed')

      const validFixedModel = { ...MODELS[0], resolution: 'provider-model-id', canaryExperiment: 'valid-fixed' }
      await writeCanary(validFixedModel, 'valid-fixed', { responseModel: validFixedModel.model }, { turnEndKind: 'completed' })
      const validFixed = await analyzeCanary(validFixedModel, root, registration)
      assert.equal(validFixed.backendIdentity.status, 'matched')
      assert.equal(validFixed.executionReady, true)
      assert.equal(validFixed.turnEndObserved, true)
      assert.equal(validFixed.status, 'passed')

      const floatingModel = { ...MODELS[1], canaryExperiment: 'floating' }
      await writeCanary(floatingModel, 'floating', {}, { turnEndKind: 'completed' })
      const floating = await analyzeCanary(floatingModel, root, registration)
      assert.equal(floating.backendIdentity.status, 'unknown')
      assert.equal(floating.executionReady, true)
      assert.equal(floating.turnEndObserved, true)
      assert.equal(floating.status, 'passed')

      const configuredUnknownModel = { ...MODELS[1], resolution: 'configured-service', canaryExperiment: 'configured-unknown' }
      await writeCanary(configuredUnknownModel, 'configured-unknown', {}, { turnEndKind: 'completed' })
      const configuredUnknown = await analyzeCanary(configuredUnknownModel, root, registration)
      assert.equal(configuredUnknown.backendIdentity.status, 'unknown')
      assert.equal(configuredUnknown.status, 'passed')

      const configuredDriftModel = { ...MODELS[1], resolution: 'configured-service', canaryExperiment: 'configured-drift' }
      const configuredDriftResponseModel = configuredDriftModel.model === 'deepseek-v4-flash:cloud' ? 'different-backend' : 'deepseek-v4-flash:cloud'
      await writeCanary(configuredDriftModel, 'configured-drift', { responseModel: configuredDriftResponseModel }, { turnEndKind: 'completed' })
      const configuredDrift = await analyzeCanary(configuredDriftModel, root, registration)
      assert.equal(configuredDrift.backendIdentity.status, 'drift')
      assert.equal(configuredDrift.status, 'failed')

      const invalidExecution = [
        ['missing-execution', undefined],
        ['nonzero-exit', { exitCode: 1, timedOut: false, budgetExceeded: false }],
        ['timed-out', { exitCode: 0, timedOut: true, budgetExceeded: false }],
        ['budget-exceeded', { exitCode: 0, timedOut: false, budgetExceeded: true }],
      ]
      for (const [experiment, execution] of invalidExecution) {
        const model = { ...MODELS[0], resolution: 'provider-model-id', canaryExperiment: experiment }
        await writeCanary(model, experiment, { responseModel: model.model }, { execution, turnEndKind: 'completed' })
        const result = await analyzeCanary(model, root, registration)
        assert.equal(result.executionReady, false, experiment)
        assert.equal(result.turnEndObserved, true, experiment)
        assert.equal(result.status, 'failed', experiment)
      }

      const missingEndModel = { ...MODELS[0], resolution: 'provider-model-id', canaryExperiment: 'missing-end' }
      await writeCanary(missingEndModel, 'missing-end', { responseModel: missingEndModel.model })
      const missingEnd = await analyzeCanary(missingEndModel, root, registration)
      assert.equal(missingEnd.executionReady, true)
      assert.equal(missingEnd.turnEndObserved, false)
      assert.equal(missingEnd.status, 'failed')

      const abortedEndModel = { ...MODELS[0], resolution: 'provider-model-id', canaryExperiment: 'aborted-end' }
      await writeCanary(abortedEndModel, 'aborted-end', { responseModel: abortedEndModel.model }, { turnEndKind: 'aborted' })
      const abortedEnd = await analyzeCanary(abortedEndModel, root, registration)
      assert.equal(abortedEnd.executionReady, true)
      assert.equal(abortedEnd.turnEndObserved, false)
      assert.equal(abortedEnd.status, 'failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts recorded budget stops and leaves missing termination evidence unknown', () => {
    const summary = summarizePilotTrials([
      trial({ trialIndex: 0, execution: { exitCode: 0, timedOut: false, budgetExceeded: true } }),
      trial({ trialIndex: 1 }),
    ])
    assert.equal(summary.resolved, 2)
    assert.equal(summary.budgetExceeded, 1)
    assert.equal(summary.terminationRecorded, 1)
    assert.equal(summary.terminationUnknown, 1)

    const partialChain = trial({ phases: [
      { phaseIndex: 0, sessionFile: null, resumedFrom: null, timedOut: false, budgetExceeded: false },
      { phaseIndex: 1, sessionFile: null, resumedFrom: null },
    ] })
    const chainSummary = summarizePilotTrials([partialChain])
    assert.equal(chainSummary.terminationRecorded, 0)
    assert.equal(chainSummary.terminationUnknown, 1)
  })

  it('pairs only matching task and repeat rows that both providers can label', () => {
    const left = [
      { taskId: CANARY_TASK_IDS[0], trialIndex: 0, status: 'success', resolved: true, failureMode: null, metrics: {} },
      { taskId: 'provider-failed', trialIndex: 0, status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR', metrics: {} },
    ]
    const right = [
      { taskId: CANARY_TASK_IDS[0], trialIndex: 0, status: 'success', resolved: false, failureMode: 'VERIFY_FAILED', metrics: {} },
      { taskId: 'provider-failed', trialIndex: 0, status: 'success', resolved: true, failureMode: null, metrics: {} },
    ]
    assert.deepEqual(pairPilotTrials(left, right).map(pair => ({ taskId: pair.taskId, left: pair.left, right: pair.right })), [
      { taskId: CANARY_TASK_IDS[0], left: true, right: false },
    ])
  })
})
