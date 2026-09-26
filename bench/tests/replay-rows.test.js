/**
 * Replay-labeller tests on fixture logs: the §4 label windows, the last cold
 * point through log end, a failed task labelling every row false, schema
 * conformance, and the malformed-log refusal. Pure and keyless.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateReplayRow } from '../analysis/replay-metrics.js'
import { extractColdPoints, extractEscalationSeqs, labelReplayRows, parseLog } from '../routing/replay-rows.js'

/** A decision entry; a cold point when coldPoint is set. */
function decision(seq, turn, step, coldPoint = null) {
  return { seq, event: 'model-routing/decision', data: { turn, step, coldPoint } }
}

const FIXTURE_LOG = [
  { seq: 1, event: 'step/start' },
  decision(4, 1, 0, { kind: 'session-start', ttlMs: 60000 }),
  { seq: 5, event: 'worker-escalation' },
  decision(9, 3, 0, { kind: 'idle', ttlMs: 60000 }),
  { seq: 12, event: 'assistant/message' },
  decision(15, 5, 0, { kind: 'idle', ttlMs: 60000 }),
  { seq: 18, event: 'worker-escalation' },
]

test('cold points and escalations extract in order', () => {
  const entries = parseLog(FIXTURE_LOG.map(entry => JSON.stringify(entry)).join('\n'))
  assert.deepEqual(extractColdPoints(entries).map(c => c.coldPointId), ['turn:1/step:0', 'turn:3/step:0', 'turn:5/step:0'])
  assert.deepEqual(extractEscalationSeqs(entries), [5, 18])
})

test('the label windows follow the §4 rule, and rows match the pinned schema', () => {
  const entries = parseLog(FIXTURE_LOG.map(entry => JSON.stringify(entry)).join('\n'))
  const { rows, coldPoints, escalations } = labelReplayRows({ task: 't', stratum: 'hard', entries, taskPassed: true })
  assert.equal(coldPoints, 3)
  assert.equal(escalations, 2)
  // Window (4, 9] contains the escalation at 5: row 1 is not cheap-sufficient.
  // Window (9, 15] is escalation-free: row 2 is. The last window runs through
  // the end of the log, so the escalation at 18 disqualifies row 3.
  assert.deepEqual(rows.map(r => r.cheapSufficient), [false, true, false])
  for (const row of rows) validateReplayRow(row, 'fixture')
  assert.deepEqual(rows.map(r => [r.task, r.stratum, r.coldPointId]), [['t', 'hard', 'turn:1/step:0'], ['t', 'hard', 'turn:3/step:0'], ['t', 'hard', 'turn:5/step:0']])
  // Consult fields stay unset: zero eligible rows, so a premature metric run
  // reads a missing denominator instead of a fabricated one.
  assert.ok(rows.every(r => r.eligible === false && r.answered === false && r.pCheap === null))
})

test('a failed task labels every row false regardless of escalations', () => {
  const entries = parseLog(FIXTURE_LOG.map(entry => JSON.stringify(entry)).join('\n'))
  const { rows } = labelReplayRows({ task: 't', stratum: 'routine', entries, taskPassed: false })
  assert.ok(rows.every(r => r.cheapSufficient === false))
})

test('a custom escalation family is honored, and malformed logs name their line', () => {
  const entries = [{ seq: 2, event: 'model-routing/decision', data: { turn: 0, step: 0, coldPoint: { kind: 'idle' } } }, { seq: 3, event: 'custom/trigger' }]
  const { rows } = labelReplayRows({ task: 't', stratum: 'routine', entries, taskPassed: true, escalationEventNames: ['custom/trigger'] })
  assert.equal(rows[0].cheapSufficient, false)
  assert.throws(() => parseLog('{broken}\n'), /line 1/)
})
