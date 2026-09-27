/** Real CLI artifact decoding and pure trigger-window cases; requires pnpm run build. @module */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, mkdir, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '../../vendor/cordis/lib/index.js'
import { SessionId, SessionStore } from '../../packages/core/session/lib/index.js'
import { JsonlSessionPersistence } from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { CallId, createToolResultMessage } from '../../packages/llm/llm/lib/index.js'
import { labelColdPoints } from '../routing/label-cold-points.js'
import { MethodUnpinnedError, parseReplayMethod } from '../routing/replay-method.js'
import { projectKey, encodeSegment } from '../runner/session-layout.js'
import { fixtureMethod } from './replay-fixture-method.js'

const fixture = new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url)
const method = fixtureMethod()
async function decodeFixture() {
  const bytes = await readFile(fixture)
  const header = JSON.parse(bytes.toString('utf8').split(String.fromCharCode(10))[0])
  const root = await mkdtemp(join(tmpdir(), 'bench-label-read-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore, {})
    await ctx.plugin(JsonlSessionPersistence, { root, packChunks: false, compression: 'none' })
    const dir = join(root, projectKey(header.cwd), encodeSegment(header.id))
    await mkdir(dir, { recursive: true })
    await cp(fixture, join(dir, 'session.jsonl'))
    return await ctx.sessionPersistence.inspect(SessionId(header.id))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
function boundaries(events) {
  return events.filter(e => e.type === 'step/start' && e.data.step === 1)
    .map(e => ({ turn: e.data.turn, step: e.data.step, stepStartSeq: e.seq }))
}
function labels(events, coldPoints, pin = method) {
  return labelColdPoints({ events, coldPoints, method: pin, arm: 'C', taskPassed: true }).rows.map(row => row.label.cheapSufficient)
}
function points(...seqs) { return seqs.map((stepStartSeq, index) => ({ turn: index + 1, step: 1, stepStartSeq })) }
function oneTrigger(name) {
  const pin = fixtureMethod()
  for (const [key, row] of Object.entries(pin.triggerTable)) row.enabled = key === name
  return pin
}
/** Unit events for run-state edge cases, separate from the real CLI artifact. */
function calls(outcomes, distinct = false) {
  return outcomes.flatMap((ok, index) => {
    const callId = CallId('unit-call-' + index)
    const seq = 2 + index * 2
    return [
      { seq, type: 'tool/call', time: seq, data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: distinct ? String(index) : 'missing' }) } },
      { seq: seq + 1, type: 'tool/result', time: seq + 1, data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: ok ? 'ok' : 'ENOENT missing file' }], isError: !ok }) } },
    ]
  })
}

test('the unchanged CLI artifact is hash-pinned and readable by the product backend', async () => {
  const provenance = JSON.parse(await readFile(new URL('../routing/fixtures/replay-c-label-windows.provenance.json', import.meta.url), 'utf8'))
  assert.equal(createHash('sha256').update(await readFile(fixture)).digest('hex'), provenance.sha256)
  assert.equal(provenance.source, 'real-cli/off-arm/loopback-stub')
  assert.deepEqual(provenance.summary, { turns: 3, tools: [0, 2, 0], errors: [0, 2, 0] })
  const { meta, events } = await decodeFixture()
  assert.equal(meta.id, 'bench-replay-c-label-windows')
  assert.equal(meta.delegationDepth, 0)
  assert.equal(boundaries(events).length, 3)
  const results = events.filter(e => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.ok(results.every(e => e.data.message.content[0].isError === true))
  assert.ok(!events.some(e => e.type.startsWith('escalation/') || e.type.startsWith('model-routing/')))
})

test('real CLI windows label the clean, failing and no-new-evidence turns true false true', async () => {
  const { events } = await decodeFixture()
  const coldPoints = boundaries(events)
  const result = labelColdPoints({ events, coldPoints, taskPassed: true, arm: 'C', method })
  assert.deepEqual(result.rows.map(row => row.label.cheapSufficient), [true, false, true])
  assert.equal(result.coldPoints, 3)
  const hash = parseReplayMethod(method, { require: [] }).methodSha256
  for (const row of result.rows) {
    assert.equal(row.arm, 'C')
    assert.equal(row.methodSha256, hash)
    assert.equal(row.answered, false)
    assert.equal(row.eligible, false)
    assert.equal(row.winner, null)
    assert.equal(row.pCheap, null)
  }
  const failed = labelColdPoints({ events, coldPoints, taskPassed: false, arm: 'C', method })
  assert.deepEqual(failed.rows.map(row => row.label.cheapSufficient), [false, false, false])
  const deferred = labelColdPoints({ events, coldPoints, taskPassed: true, arm: 'C', method: fixtureMethod({ finalWindow: 'unlabelled' }) })
  assert.deepEqual(deferred.rows[2].label, { status: 'unlabelled', reason: 'final-window-unlabelled' })
  const strong = labelColdPoints({ events, coldPoints, taskPassed: true, arm: 'S', method })
  assert.equal(strong.rows.length, 3)
  assert.ok(strong.rows.every(row => row.label.status === 'unlabelled' && row.label.reason === 'no-label-source-for-arm'))
})

test('missing method inputs refuse rather than label with defaults', () => {
  assert.throws(() => labelColdPoints({ events: [], coldPoints: [], taskPassed: true, arm: 'C' }), error => {
    assert.ok(error instanceof MethodUnpinnedError)
    assert.ok(error.missing.includes('version'))
    assert.ok(error.missing.includes('triggerTable'))
    return true
  })
})

test('a transient burst still fires after a later success clears it', () => {
  assert.deepEqual(labels(calls([false, false, true]), points(1)), [false])
})

test('standing earlier evidence does not fire a no-tool window', () => {
  assert.deepEqual(labels(calls([false, false]), points(1, 6)), [false, true])
})

test('run state carries across a cold point and new evidence fires inside the next window', () => {
  assert.deepEqual(labels(calls([false, false]), points(1, 4)), [true, false])
})

test('evidence at a window end belongs to the following window', () => {
  assert.deepEqual(labels(calls([false, false]), points(1, 5)), [true, false])
})

test('attempt count carries distinct failures across windows with whole-log anchoring', () => {
  assert.deepEqual(labels(calls([false, false], true), points(1, 4), oneTrigger('attemptCount')), [true, false])
})

test('a repeat chain only fires a later window when that chain extends there', () => {
  assert.deepEqual(labels(calls([true, true]), points(1, 6), oneTrigger('repeatRunLength')), [false, true])
  assert.deepEqual(labels(calls([true, true, true]), points(1, 6), oneTrigger('repeatRunLength')), [false, false])
})

test('a skipped verifier yields unlabelled task-outcome-unknown rows, not resolved:false', async () => {
  const { events } = await decodeFixture()
  const coldPoints = boundaries(events)
  const result = labelColdPoints({ events, coldPoints, taskPassed: 'unknown', arm: 'C', method })
  assert.equal(result.rows.length, 3)
  for (const row of result.rows) {
    assert.deepEqual(row.label, { status: 'unlabelled', reason: 'task-outcome-unknown' })
  }
  assert.throws(
    () => labelColdPoints({ events, coldPoints, taskPassed: undefined, arm: 'C', method }),
    /taskPassed must be a boolean or 'unknown'/
  )
})
