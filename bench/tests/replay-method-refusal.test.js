/** Method identity and label-dependent metric refusal. @module */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalize } from '../canonical-json.js'
import { computeReplayMetrics, parseLabelledScores, KEEP_CURRENT_OPTION_ID } from '../analysis/replay-metrics.js'
import { MethodProvenanceError } from '../routing/replay-method.js'
import { fixtureMethod, fixtureRow } from './replay-fixture-method.js'

const gate = { aurocMin: 0.7, falseDowngradeMax: 0.05, coverageMin: 0.15, eceMax: 0.1 }
const entry = { entryScoreCeiling: 2, candidateIds: ['flash'] }
const method = fixtureMethod({ finalWindow: 'unlabelled' })
const unknown = { status: 'unlabelled', reason: 'final-window-unlabelled' }
const noAnswer = { answered: false, eligible: false, winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null, truncated: null, headTokens: null }
function row(overrides = {}, pin = method) {
  return fixtureRow({ task: 'task', stratum: 'short', coldPointId: 'turn:1/step:1', eligible: true, answered: true, truncated: false, headTokens: 100,
    winner: 'flash', confidence: 0.9, margin: 0.3, pCheap: 0.9, difficultyScore: 1, ...overrides }, pin)
}
function metrics(rows, pin = method) { return computeReplayMetrics(rows, { method: pin, gate, entry }) }

test('canonical JSON preserves arrays and sorts nested object keys', () => {
  assert.equal(canonicalize({ z: [{ b: 2, a: 1 }], a: true }), '{"a":true,"z":[{"a":1,"b":2}]}')
})

test('unlabelled routed rows preserve both denominators and refuse the whole search', () => {
  const result = metrics([row(), row({ task: 'b', label: unknown }), row({ task: 'c', ...noAnswer })])
  assert.equal(result.counts.rows, 3)
  assert.equal(result.counts.eligible, 2)
  assert.equal(result.curve[0].coverage, 2 / 3)
  assert.equal(result.curve[0].entryRate, 1)
  assert.equal(result.curve[0].falseDowngradeStatus, 'refused-unlabelled')
  assert.equal(result.curve[0].falseDowngrade, null)
  assert.equal(result.curve[0].falseDowngrades, null)
  assert.equal(result.curve[0].feasible, null)
  assert.equal(result.counts.routed, null)
  assert.equal(result.counts.falseDowngrades, null)
  assert.deepEqual(result.operatingPoint, { status: 'refused', reason: 'unlabelled-rows' })
  assert.equal(result.discrimination.status, 'refused')
  assert.equal(result.calibration.status, 'refused')
  assert.equal(result.gate.status, 'method-unpinned')
  assert.equal(result.gate.passed, null)
  assert.equal(result.calibration.reason, 'unlabelled-rows')
  assert.deepEqual(result.unlabelled, { total: 1, byArm: { S: 0, C: 1 }, byReason: { 'final-window-unlabelled': 1 } })
})

test('an unanswered unlabelled row does not enter answered or routed denominators', () => {
  const result = metrics([row(), row({ task: 'b', confidence: 0.2, pCheap: 0.1, cheapSufficient: false }), row({ task: 'c', ...noAnswer, label: unknown })])
  assert.equal(result.discrimination.auroc, 1)
  assert.equal(result.discrimination.status, 'evaluated')
  assert.equal(result.calibration.status, 'evaluated')
  assert.equal(result.gate.status, 'evaluated')
  assert.equal(result.gate.passed, true)
  assert.equal(result.operatingPoint.coverage, 1 / 3)
  assert.equal(result.operatingPoint.entryRate, 1 / 2)
  assert.equal(result.unlabelled.total, 1)
})

test('an answered unlabelled keep-current row refuses AUROC and ECE but not the routed-point arithmetic', () => {
  const result = metrics([row(), row({ task: 'b', winner: KEEP_CURRENT_OPTION_ID, label: unknown })])
  assert.equal(result.curve[0].falseDowngradeStatus, 'evaluated')
  assert.equal(result.operatingPoint.status, 'evaluated')
  assert.equal(result.counts.routed, 1)
  assert.equal(result.discrimination.status, 'refused')
  assert.equal(result.calibration.status, 'refused')
  assert.equal(result.gate.passed, null)
})

test('method hash, table identity and label reason must match before metrics run', () => {
  assert.throws(() => metrics([row({ methodSha256: '0'.repeat(64) })]), MethodProvenanceError)
  assert.throws(() => metrics([row({ label: { ...row().label, triggerTableId: 'other-table' } })]), MethodProvenanceError)
  assert.throws(() => metrics([row({ label: { status: 'unlabelled', reason: 'no-label-source-for-arm' } })]), MethodProvenanceError)
  const toEnd = fixtureMethod()
  assert.throws(() => metrics([row({ label: unknown }, toEnd)], toEnd), MethodProvenanceError)
})

test('row identity includes arm and the obsolete boolean cannot substitute for label', () => {
  const c = row()
  const s = row({ arm: 'S', label: { status: 'unlabelled', reason: 'no-label-source-for-arm' } })
  assert.equal(parseLabelledScores([c, s].map(JSON.stringify).join(String.fromCharCode(10))).length, 2)
  assert.throws(() => metrics([c, c]), /duplicate cold-point/)
  assert.throws(() => parseLabelledScores(JSON.stringify({ ...c, cheapSufficient: true })), /represented by label/)
})

test('one ECE bin remains an accepted explicit method', () => {
  const one = fixtureMethod({ eceBins: 1 })
  const result = metrics([row({}, one), row({ task: 'b', pCheap: 0.1, cheapSufficient: false }, one)], one)
  assert.equal(result.calibration.bins.length, 1)
  assert.equal(result.calibration.ece, 0)
})
