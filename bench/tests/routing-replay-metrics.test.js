/**
 * Replay-metrics tests on hand-computed fixtures: AUROC (perfect, inverse,
 * ties, single-class), ECE against a worked example, the excluded row classes
 * that never route, the tie-break as an explicit input, each gate leg failing
 * on its own, the pCheap/confidence divergence, and the two denominators.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KEEP_CURRENT_OPTION_ID, REPLAY_ROW_SEMANTICS_VERSION, auroc, computeReplayMetrics as computeMetrics, ece, parseLabelledScores, validateReplayRow } from '../analysis/replay-metrics.js'
import { fixtureMethod, fixtureRow } from './replay-fixture-method.js'
import { parseReplayMethod } from '../routing/replay-method.js'

/** The registration's layaGate bounds (prereg-2026-10.registration.json). */
const gateBounds = { aurocMin: 0.7, falseDowngradeMax: 0.1, coverageMin: 0.15 }

/** The R overlay's fixed entry conditions. */
const entry = { entryScoreCeiling: 2, candidateIds: ['flash'] }

const tieBreak = ['falseDowngrade', 'downgradeThreshold', 'downgradeMargin']

/** Keep the arithmetic fixtures independent of method-hash serialization. */
function computeReplayMetrics(rows, { eceBins, tieBreak, ...options }) {
  const method = fixtureMethod({ eceBins, tieBreak })
  const { methodSha256 } = parseReplayMethod(method, { require: ['version', 'eceBins', 'tieBreak'] })
  return computeMetrics(rows.map(row => ({ ...row, methodSha256 })), { ...options, method })
}

/** Build one answered candidate row. */
function row(overrides) {
  return fixtureRow({
    task: 'task', stratum: 'routine', coldPointId: 'c1',
    eligible: true, answered: true, truncated: false, headTokens: 100,
    winner: 'flash', confidence: 0.9, margin: 0.5, pCheap: 0.9, difficultyScore: 1,
    cheapSufficient: true, ...overrides,
  })
}

/** The unanswered shape every excluded non-answer shares. */
function unansweredRow(overrides) {
  return fixtureRow({
    task: 'task', stratum: 'hard', coldPointId: 'c1',
    eligible: false, answered: false, truncated: null, headTokens: null,
    winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null,
    cheapSufficient: true, ...overrides,
  })
}

test('auroc: perfect, inverse, ties, and the single-class null', () => {
  assert.equal(auroc([{ score: 0.9, positive: true }, { score: 0.1, positive: false }]), 1)
  assert.equal(auroc([{ score: 0.1, positive: true }, { score: 0.9, positive: false }]), 0)
  assert.equal(auroc([{ score: 0.5, positive: true }, { score: 0.5, positive: false }]), 0.5)
  assert.equal(auroc([{ score: 0.9, positive: true }, { score: 0.5, positive: true }]), null)
  assert.equal(auroc([{ score: 0.1, positive: false }, { score: 0.2, positive: false }]), null)
  // Ties counted as 0.5 inside a larger sample: one tied pair, three clean wins.
  const samples = [
    { score: 0.8, positive: true },
    { score: 0.8, positive: false },
    { score: 0.9, positive: true },
    { score: 0.1, positive: false },
  ]
  assert.ok(Math.abs(auroc(samples) - 0.875) < 1e-12)
})

test('ece: hand-computed over two bins, with the score-1 row in the last bin', () => {
  const worked = ece([
    { score: 0.9, positive: true },
    { score: 0.8, positive: true },
    { score: 0.7, positive: true },
    { score: 0.1, positive: false },
  ], 2)
  // Bin [0, 0.5): one negative at 0.1 -> gap 0.1, weight 1/4. Bin [0.5, 1]: three
  // positives at mean 0.8 -> gap 0.2, weight 3/4. ECE = 0.175.
  assert.ok(Math.abs(worked.ece - 0.175) < 1e-9)
  assert.equal(worked.bins[0].count, 1)
  assert.equal(worked.bins[1].count, 3)
  const closed = ece([{ score: 1, positive: true }], 4)
  assert.equal(closed.bins[3].count, 1, 'a score of 1 lands in the last bin, not outside the grid')
  assert.ok(Math.abs(closed.ece - 0) < 1e-12)
  assert.throws(() => ece([], 0), /positive integer/)
  assert.throws(() => ece([{ score: 0.5, positive: true }], 1.5), /positive integer/)
})

test('parseLabelledScores: rows parse, and malformed input names its line', () => {
  const text = [
    JSON.stringify(row({ task: 'a', coldPointId: 'c1' })),
    '',
    JSON.stringify(row({ task: 'a', coldPointId: 'c2', answered: false, truncated: null, headTokens: null, winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null })),
  ].join('\n')
  const rows = parseLabelledScores(text)
  assert.equal(rows.length, 2)
  assert.throws(() => parseLabelledScores('{not json}\n'), /line 1/)
  assert.throws(() => parseLabelledScores(`${JSON.stringify({ task: 'a' })}\n`), /line 1/)
  const bad = JSON.stringify(row({ confidence: null }))
  assert.throws(() => parseLabelledScores(`\n\n${bad}\n`), /line 3/)
  const duplicate = `${JSON.stringify(row({ task: 'a', coldPointId: 'c1' }))}\n${JSON.stringify(row({ task: 'a', coldPointId: 'c1' }))}\n`
  assert.throws(() => parseLabelledScores(duplicate), /duplicate cold-point row/)
  assert.throws(() => parseLabelledScores('\n\n'), /no rows/)
})

test('repeated trials keep separate rows and true duplicates still refuse', () => {
  const repeats = [row({ trialIndex: 0 }), row({ trialIndex: 1 })]
  assert.equal(parseLabelledScores(repeats.map(value => JSON.stringify(value)).join('\n')).length, 2)
  const options = { eceBins: 2, gate: gateBounds, entry, tieBreak }
  const metrics = computeReplayMetrics(repeats, options)
  assert.equal(metrics.counts.rows, 2)
  assert.equal(metrics.counts.eligible, 2)
  assert.equal(metrics.counts.answered, 2)
  const duplicate = [repeats[0], { ...repeats[0] }]
  assert.throws(() => parseLabelledScores(duplicate.map(value => JSON.stringify(value)).join('\n')), /duplicate cold-point row/)
  assert.throws(() => computeReplayMetrics(duplicate, options), /duplicate cold-point row/)
})

test('replay rows require an explicit non-negative safe trial index', () => {
  const missing = row({})
  delete missing.trialIndex
  assert.throws(() => validateReplayRow(missing, 'missing'), /trialIndex/)
  for (const trialIndex of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '0']) {
    assert.throws(() => validateReplayRow(row({ trialIndex }), 'invalid'), /trialIndex/)
  }
  assert.equal(validateReplayRow(row({ trialIndex: 0 }), 'zero').trialIndex, 0)
})

test('excluded classes never route at any operating point', () => {
  const rows = [
    row({ task: 'routable', confidence: 0.9, margin: 0.5 }),
    // Ineligible: no ask was made, so there is nothing to route.
    row({ task: 'ineligible', eligible: false, answered: false, truncated: null, headTokens: null, winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null }),
    // Unanswered: the fitting returned unfit, so the row carries no quantities.
    row({ task: 'unanswered', eligible: true, answered: false, truncated: null, headTokens: null, winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null }),
    // Difficulty at the fixed ceiling: never routes, whatever the answer says.
    row({ task: 'at-ceiling', difficultyScore: 2, confidence: 0.99, margin: 0.9 }),
    // Keep-current winner: the router ends the consult before the gate.
    row({ task: 'keep-current', winner: KEEP_CURRENT_OPTION_ID, confidence: 0.99, margin: 0.9, pCheap: 0 }),
  ]
  const result = computeReplayMetrics(rows, { eceBins: 10, tieBreak, gate: gateBounds, entry })
  assert.equal(result.counts.rows, 5)
  assert.equal(result.counts.eligible, 4)
  assert.equal(result.counts.answered, 3)
  // The densest grid point routes only the one row that passes every fixed condition.
  const densest = result.curve.reduce((best, point) => (point.routes > best.routes ? point : best), result.curve[0])
  assert.equal(densest.routes, 1)
  assert.equal(result.operatingPoint.routes, 1)
})

test('the operating point maximizes coverage within the false-downgrade bound, tie-broken as specified', () => {
  const rows = [
    row({ task: 'a', confidence: 0.9, margin: 0.5, pCheap: 0.9 }),
    row({ task: 'b', confidence: 0.9, margin: 0.3, pCheap: 0.8 }),
    row({ task: 'c', confidence: 0.7, margin: 0.5, pCheap: 0.7, stratum: 'hard' }),
    row({ task: 'd', confidence: 0.7, margin: 0.3, pCheap: 0.1, cheapSufficient: false, stratum: 'hard' }),
    unansweredRow({ task: 'e' }),
  ]
  const result = computeReplayMetrics(rows, { eceBins: 2, tieBreak, gate: gateBounds, entry })
  // Maximum feasible coverage is 2/5 at (0.9, 0.3) and (0.7, 0.5), both FD 0; the
  // preregistered order lowers FD, then raises the threshold, then the margin.
  assert.deepEqual(
    { t: result.operatingPoint.downgradeThreshold, m: result.operatingPoint.downgradeMargin },
    { t: 0.9, m: 0.3 },
  )
  assert.equal(result.operatingPoint.routes, 2)
  const reordered = computeReplayMetrics(rows, { eceBins: 2, tieBreak: ['falseDowngrade', 'downgradeMargin', 'downgradeThreshold'], gate: gateBounds, entry })
  assert.deepEqual(
    { t: reordered.operatingPoint.downgradeThreshold, m: reordered.operatingPoint.downgradeMargin },
    { t: 0.7, m: 0.5 },
    'the tie-break is an input: a different preregistered order picks the other point',
  )
  // The all-candidate point is infeasible: one of four routes is a false downgrade.
  const all = result.curve.find(point => point.routes === 4)
  assert.equal(all.feasible, false)
  assert.ok(Math.abs(all.falseDowngrade - 0.25) < 1e-12)
})

test('each gate leg fails on its own', () => {
  const rows = [
    row({ task: 'a', confidence: 0.9, margin: 0.5, pCheap: 0.9 }),
    row({ task: 'b', confidence: 0.9, margin: 0.3, pCheap: 0.8 }),
    row({ task: 'c', confidence: 0.7, margin: 0.2, pCheap: 0.7 }),
    unansweredRow({ task: 'd' }),
  ]
  // AUROC leg: the labels carry no separation (all positive, so AUROC is null).
  const noAuroc = computeReplayMetrics(rows, { eceBins: 4, tieBreak, gate: gateBounds, entry })
  assert.equal(noAuroc.gate.legs.auroc, false)
  assert.equal(noAuroc.gate.legs.feasiblePoint, true)
  assert.equal(noAuroc.gate.legs.coverage, true)
  assert.equal(noAuroc.gate.passed, false)
  assert.match(noAuroc.gate.reading, /auroc/)
  // Feasible-point leg: the false downgrade holds the highest confidence and the
  // widest margin, so it rides in every routed set and no point is feasible.
  const mixed = [
    ...rows.slice(0, 2),
    row({ task: 'c', confidence: 0.7, margin: 0.2, pCheap: 0.7 }),
    row({ task: 'd', confidence: 0.95, margin: 0.6, pCheap: 0.1, cheapSufficient: false }),
    unansweredRow({ task: 'e' }),
  ]
  const noPoint = computeReplayMetrics(mixed, { eceBins: 4, tieBreak, gate: { ...gateBounds, aurocMin: 0.5 }, entry })
  assert.equal(noPoint.gate.legs.auroc, true)
  assert.equal(noPoint.gate.legs.feasiblePoint, false)
  assert.equal(noPoint.operatingPoint, null)
  assert.match(noPoint.gate.reading, /feasiblePoint/)
  // Coverage leg: a feasible point exists but covers too few cold points.
  const narrow = [
    row({ task: 'only' }),
    row({ task: 'excluded-neg', winner: KEEP_CURRENT_OPTION_ID, pCheap: 0.1, cheapSufficient: false }),
    ...Array.from({ length: 9 }, (_, at) => unansweredRow({ task: `pad${at}`, coldPointId: `c${at}` })),
  ]
  const noCoverage = computeReplayMetrics(narrow, { eceBins: 4, tieBreak, gate: { ...gateBounds, aurocMin: 0.5 }, entry })
  assert.equal(noCoverage.gate.legs.auroc, true)
  assert.equal(noCoverage.gate.legs.feasiblePoint, true)
  assert.equal(noCoverage.gate.legs.coverage, false)
  assert.ok(noCoverage.operatingPoint.coverage < 0.15)
  assert.match(noCoverage.gate.reading, /coverage/)
})

test('pCheap and confidence can rank differently; the operating point sits on the gate quantities', () => {
  const rows = [
    // The confident answer is the false downgrade; the label follows pCheap, not confidence.
    row({ task: 'confident-wrong', confidence: 0.95, margin: 0.1, pCheap: 0.1, cheapSufficient: false }),
    row({ task: 'modest-right', confidence: 0.8, margin: 0.4, pCheap: 0.9 }),
  ]
  const result = computeReplayMetrics(rows, { eceBins: 2, tieBreak, gate: { ...gateBounds, coverageMin: 0.4 }, entry })
  assert.equal(result.discrimination.auroc, 1, 'pCheap separates the label perfectly')
  assert.equal(result.operatingPoint.downgradeThreshold, 0.8, 'the search runs on confidence, not pCheap')
  assert.equal(result.operatingPoint.routes, 1)
})

test('the two denominators are reported separately', () => {
  const rows = [
    row({ task: 'a', confidence: 0.9, margin: 0.5 }),
    row({ task: 'b', confidence: 0.9, margin: 0.3 }),
    row({ task: 'c', confidence: 0.7, margin: 0.2, stratum: 'hard' }),
    row({ task: 'd', confidence: 0.7, margin: 0.2, pCheap: 0.1, cheapSufficient: false, stratum: 'hard' }),
    unansweredRow({ task: 'e' }),
  ]
  const result = computeReplayMetrics(rows, { eceBins: 2, tieBreak, gate: gateBounds, entry })
  assert.equal(result.counts.rows, 5)
  assert.equal(result.counts.eligible, 4)
  assert.ok(Math.abs(result.operatingPoint.coverage - 0.4) < 1e-12, 'coverage divides by every cold-point row')
  assert.ok(Math.abs(result.operatingPoint.entryRate - 0.5) < 1e-12, 'entry rate divides by the eligible rows')
})

test('truncation, unanswered rate, and head tokens report over answered rows', () => {
  const rows = [
    row({ task: 'a', truncated: true, headTokens: 100 }),
    row({ task: 'b', headTokens: 200 }),
    unansweredRow({ task: 'c' }),
    unansweredRow({ task: 'd', eligible: true, cheapSufficient: false }),
  ]
  const result = computeReplayMetrics(rows, { eceBins: 2, tieBreak, gate: gateBounds, entry })
  assert.equal(result.counts.truncated, 1)
  assert.ok(Math.abs(result.tokens.truncationRate - 0.5) < 1e-12)
  assert.ok(Math.abs(result.tokens.unansweredRate - 0.5) < 1e-12)
  assert.ok(Math.abs(result.tokens.headTokensMean - 150) < 1e-12)
  assert.equal(result.tokens.headTokensP95, 200)
})

test('method inputs are recorded verbatim; nothing is defaulted', () => {
  const result = computeReplayMetrics([row({}), row({ task: 'b', pCheap: 0.2, cheapSufficient: false })], {
    eceBins: 7, tieBreak: ['downgradeMargin'], gate: gateBounds, entry,
  })
  const explicit = fixtureMethod({ eceBins: 7, tieBreak: ['downgradeMargin'] })
  assert.deepEqual(result.method, { ...explicit, methodSha256: parseReplayMethod(explicit, { require: [] }).methodSha256 })
  assert.deepEqual(result.fixed, entry)
  const full = { eceBins: 10, tieBreak, gate: gateBounds, entry }
  const rows = [row({})]
  assert.throws(() => computeReplayMetrics(rows, { tieBreak, gate: gateBounds, entry }), /eceBins/)
  assert.throws(() => computeReplayMetrics(rows, { eceBins: 10, gate: gateBounds, entry }), /tieBreak/)
  assert.throws(() => computeReplayMetrics(rows, { eceBins: 10, tieBreak, entry }), /gate/)
  assert.throws(() => computeReplayMetrics(rows, { eceBins: 10, tieBreak, gate: gateBounds }), /entry/)
  assert.throws(() => computeReplayMetrics(rows, { ...full, tieBreak: ['bogus'] }), /method\.tieBreak.*unknown-key/)
  assert.throws(() => computeReplayMetrics(rows, { ...full, tieBreak: ['falseDowngrade', 'falseDowngrade'] }), /method\.tieBreak.*duplicate/)
})

test('malformed rows refuse loudly', () => {
  const full = { eceBins: 10, tieBreak, gate: gateBounds, entry }
  assert.throws(() => computeReplayMetrics([], full), /at least one row/)
  assert.throws(() => computeReplayMetrics([row({}), row({})], full), /duplicate cold-point row/)
  assert.throws(() => computeReplayMetrics([row({ pCheap: 1.5 })], full), /pCheap/)
  assert.throws(() => computeReplayMetrics([row({ answered: false })], full), /unanswered row/)
  assert.throws(() => computeReplayMetrics([row({ headTokens: 1.5 })], full), /headTokens/)
  assert.throws(() => computeReplayMetrics([row({ difficultyScore: null })], full), /difficultyScore/)
})
