/**
 * Fitted-judge stage: one ask per eligible row, live-equal inputs, honest
 * unanswered outcomes, prepare-only zero asks. Hosted, keyless.
 * @module
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { MODEL_ROUTER_JUDGMENT_CONSUMER } from '../../packages/llm/model-router/lib/index.js'
import { hostReplayRun, hostReplayTrial } from '../routing/replay-frontend-host.js'
import { REPLAY_SCRIPTED_FITTING_JUDGE_PATH } from '../routing/replay-frontend-overlay.js'
import { validateReplayRow } from '../analysis/replay-metrics.js'
import { fixtureMethod } from './replay-fixture-method.js'
import { projectKey, encodeSegment } from '../runner/session-layout.js'

const fixture = new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url)
const method = fixtureMethod()
const repo = join(fileURLToPath(new URL('../..', import.meta.url)))
const ownRoute = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const tasks = { 'task-a': { stratum: 'routine' } }

function trialOf(id, path) {
  return {
    id, taskId: 'task-a', trialIndex: 0, arm: 'C', path,
    trialOwnRoute: ownRoute,
    trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
  }
}

async function plant(bytes, label) {
  const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
  const root = await mkdtemp(join(tmpdir(), 'bench-judge-' + label + '-'))
  const dir = join(root, projectKey(header.cwd), encodeSegment(header.id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  await writeFile(path, bytes)
  return { root, path, header }
}

function fittingOverlay() {
  return [
    '- insert:',
    '    - id: bench-replay-scripted-fitting-judge',
    '      name: ' + JSON.stringify(REPLAY_SCRIPTED_FITTING_JUDGE_PATH),
    '      config:',
    '        defaultScript:',
    '          kind: answered',
    '',
  ].join('\n')
}

test('prepare-only hostReplayRun records zero asks and leaves prepared rows unanswered', async () => {
  const bytes = await readFile(fixture)
  const planted = await plant(bytes, 'prepare')
  try {
    const result = await hostReplayRun({
      repoRoot: repo, method, tasks,
      trials: [trialOf('good', planted.path)],
    })
    assert.equal((result.summaries[0].summary.asks ?? []).length, 0)
    assert.ok(result.summaries[0].routerConfig)
    for (const row of result.rows) {
      validateReplayRow(row, 'prepare-only')
      assert.equal(row.answered, false)
    }
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('judge records one ask per eligible row with live-equal consult inputs', async () => {
  const bytes = await readFile(fixture)
  const planted = await plant(bytes, 'map')
  try {
    const hosted = await hostReplayTrial({
      repoRoot: repo,
      trial: trialOf('j', planted.path).trial,
      path: planted.path,
      arm: 'C',
      method,
      trialOwnRoute: ownRoute,
      judge: true,
      extraOverlay: fittingOverlay(),
    })
    const eligible = hosted.rows.filter(row => row.eligible === true)
    assert.equal((hosted.asks ?? []).length, eligible.length)
    for (const ask of hosted.asks ?? []) {
      const consult = hosted.consults.find(entry => entry.turn === ask.turn && entry.step === ask.step)
      assert.equal(consult.result.kind, 'ask')
    }
    const answered = hosted.rows.find(row => row.answered === true)
    if (answered !== undefined) {
      assert.equal(answered.truncated, false)
      assert.equal(answered.headTokens, 40)
      assert.equal(answered.winner, 'flash')
      assert.equal(answered.pCheap, 0.7)
    }
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})
