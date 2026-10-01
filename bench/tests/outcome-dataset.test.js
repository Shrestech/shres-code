/**
 * Tests for the frozen generation-pilot outcome exporter.
 *
 * @module bench/tests/outcome-dataset
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_COMPLETION_PATH,
  assertAnalysisBackendIdentity,
  assertPinnedBytes,
  buildOutcomeDataset,
  pairOutcomeRows,
  sha256,
} from '../routing/outcome-dataset.mjs'

const SERVICES = ['zai-glm-5.3', 'ollama-deepseek-v4-flash-cloud']

function row(service, taskId = 'task-a', trialIndex = 0, resolved = true) {
  return {
    service: { id: service },
    taskId,
    trialIndex,
    quality: { eligible: true, resolved, exclusionReason: null },
    metrics: { inputTokens: 10, outputTokens: 2, durationMs: 3, tokensIncludingDescendants: 12 },
    identity: { backendIdentity: { status: 'unknown', configuredModel: service, responseModelIds: [] } },
  }
}

test('exports the finalized pilot as whole-task rows with unknown backend identities', async () => {
  const dataset = await buildOutcomeDataset()
  assert.equal(dataset.schema, 'shres-code/outcome-supervised-routing-dataset@1')
  assert.equal(dataset.rows.length, 36)
  assert.equal(dataset.pairs.length, 18)
  assert.deepEqual(dataset.taskIds, [
    'chain-debug-resume',
    'constraint-survival-build',
    'cross-module-refactor',
    'injection-ignore',
    'noise-needle',
    'single-function-fix',
  ])
  assert.deepEqual(dataset.services.map(service => service.id), SERVICES)
  assert.deepEqual(dataset.services.map(service => service.backendIdentity.status), ['unknown', 'unknown'])
  assert.equal(dataset.features.status, 'pending')
  assert.equal(dataset.rows.filter(row => row.service.id === SERVICES[0] && row.quality.resolved).length, 18)
  assert.equal(dataset.rows.filter(row => row.service.id === SERVICES[1] && row.quality.resolved).length, 17)
  const chain = dataset.rows.find(row => row.taskId === 'chain-debug-resume')
  assert.equal(chain.task.phaseCount, 2)
  assert.equal('instruction' in chain.task, false)
  assert.equal('preferredService' in dataset, false)
  assert.equal('goldModel' in dataset, false)
  assert.ok(dataset.rows.every(row => row.quality.granularity === 'task-trial'))
})

test('rejects bytes that differ from a pinned artifact', () => {
  const original = Buffer.from('pinned')
  assert.doesNotThrow(() => assertPinnedBytes(original, { bytes: original.byteLength, sha256: sha256(original) }, 'tier patch'))
  const changed = Buffer.from('tamper')
  assert.throws(
    () => assertPinnedBytes(changed, { bytes: original.byteLength, sha256: sha256(original) }, 'tier patch'),
    /hash differs from its pinned artifact/,
  )
})

test('rejects a finalized completion record whose retained artifact pin is changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shres-outcome-dataset-'))
  try {
    const completion = JSON.parse(await readFile(DEFAULT_COMPLETION_PATH, 'utf8'))
    const trialsPath = 'bench/runs/generation-model-pilot-2026-09-23-v3-zai/off/trials.jsonl'
    completion.files[trialsPath].sha256 = '0'.repeat(64)
    const completionPath = join(root, 'completion.json')
    await writeFile(completionPath, `${JSON.stringify(completion)}\n`)
    await assert.rejects(
      buildOutcomeDataset({ completionPath }),
      /hash differs from its pinned artifact/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects missing and duplicate task-repeat pairs', () => {
  const left = row(SERVICES[0])
  const right = row(SERVICES[1], 'task-a', 0, false)
  assert.throws(
    () => pairOutcomeRows([left], SERVICES, ['task-a'], 1),
    /ollama-deepseek-v4-flash-cloud outcome rows do not match.*missing=task-a#0/,
  )
  assert.throws(
    () => pairOutcomeRows([left, { ...left }, right], SERVICES, ['task-a'], 1),
    /duplicate outcome row zai-glm-5\.3 task-a#0/,
  )
})

test('rejects analysis that upgrades unknown backend evidence to a matched model', () => {
  const registered = {
    id: SERVICES[0],
    configuredIdentifier: 'zai/glm-5.3',
    resolution: 'configured-service',
  }
  const raw = {
    status: 'unknown',
    configuredModel: 'glm-5.3',
    responseModelIds: [],
  }
  const misrepresented = {
    id: SERVICES[0],
    configuredIdentifier: 'zai/glm-5.3',
    resolution: 'configured-service',
    backendIdentity: { status: 'matched', configuredModel: 'glm-5.3', responseModelIds: ['glm-5.3'] },
  }
  assert.throws(
    () => assertAnalysisBackendIdentity(misrepresented, registered, raw),
    /analysis backend identity misrepresents raw response evidence/,
  )
})
