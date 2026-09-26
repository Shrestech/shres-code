/**
 * Gate math tests on fixture trials: a known non-inferiority pass and fail,
 * the Holm family, the ratio hypotheses, the screens, and the power reading.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clusterRobustMean, computeRoutingGate, holm, normalCdf, percentile, requiredPairs } from '../analysis/routing-gate.js'

/**
 * Deterministic fixture: 12 tasks x 2 repeats of S, R, and N. Pass patterns
 * are task-deterministic, not random, so the clustered variance is exact:
 * sPassRate/nPassRate are read as "one task in k passes" and rPassRate as
 * always (1) or never (0).
 */
function fixtureTrials({ rPass, sPass, nPass, hardFrom = 6, tokenRatio = 0.7 }) {
  const facts = []
  const stratum = task => (task < 3 ? 'routine' : task < hardFrom ? 'moderate' : 'hard')
  for (let task = 0; task < 12; task += 1) {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const s = sPass(task) ? 1 : 0
      const r = rPass(task) ? 1 : 0
      const n = nPass(task) ? 1 : 0
      facts.push(
        { taskId: `t${task}`, repeat, arm: 'S', stratum: stratum(task), success: s, strongTokens: 100_000, coldStrongWrites: 5_000, judgedWarmTurns: 0, coldPointEntries: 0, coldPoints: 10, routeFailedRecoveries: 0, judgeCriticalPathMs: [], lostTurns: 0, invariantFailures: 0 },
        { taskId: `t${task}`, repeat, arm: 'R', stratum: stratum(task), success: r, strongTokens: Math.round(100_000 * tokenRatio), coldStrongWrites: Math.round(5_000 * tokenRatio), judgedWarmTurns: 0, coldPointEntries: 3, coldPoints: 20, routeFailedRecoveries: 0, judgeCriticalPathMs: [10, 20, 30], lostTurns: 0, invariantFailures: 0 },
        { taskId: `t${task}`, repeat, arm: 'N', stratum: stratum(task), success: n, strongTokens: Math.round(100_000 * tokenRatio), coldStrongWrites: Math.round(5_000 * tokenRatio), judgedWarmTurns: 0, coldPointEntries: 3, coldPoints: 20, routeFailedRecoveries: 0, judgeCriticalPathMs: [10, 20, 30], lostTurns: 0, invariantFailures: 0 },
      )
    }
  }
  return facts
}

const gateOptions = { designPdisc: 0.15, layaReplayPassed: true }

test('clear R win passes H1 overall AND in the hard stratum, and the full gate', () => {
  const verdict = computeRoutingGate(fixtureTrials({ rPass: () => 1, sPass: t => t >= 3, nPass: t => t >= 3 }), gateOptions)
  assert.equal(verdict.hypotheses.H1.pass, true)
  assert.equal(verdict.hypotheses.H1.hard.status, 'evaluated')
  assert.equal(verdict.hypotheses.H1.hard.pass, true)
  assert.equal(verdict.pass, true)
  assert.ok(verdict.hypotheses.H3.ratio < 0.8)
  assert.ok(verdict.hypotheses.H5.oneSidedUpper95 <= 1.05)
})

test('overall H1 passing cannot mask a hard-stratum failure', () => {
  // R gains on routine/moderate (t1, t2) but loses both repeats of hard t6;
  // the overall lower bound clears -0.05 while the hard bound does not.
  const verdict = computeRoutingGate(fixtureTrials({
    rPass: t => t <= 5 || t >= 7,
    sPass: t => t >= 6,
    nPass: t => t >= 6,
  }), gateOptions)
  assert.ok(verdict.hypotheses.H1.lowerBound975 > -0.05, 'overall H1 clears the margin')
  assert.equal(verdict.hypotheses.H1.hard.status, 'evaluated')
  assert.equal(verdict.hypotheses.H1.hard.pass, false, 'hard stratum fails')
  assert.equal(verdict.pass, false)
  assert.match(verdict.failureReading, /hard stratum/)
})

test('missing hard-stratum data refuses the pass instead of defaulting', () => {
  // No task sits in the hard stratum (hardFrom beyond the catalog).
  const verdict = computeRoutingGate(fixtureTrials({
    rPass: () => 1,
    sPass: t => t >= 3,
    nPass: t => t >= 3,
    hardFrom: 12,
  }), gateOptions)
  assert.equal(verdict.hypotheses.H1.hard.status, 'insufficient-data')
  assert.equal(verdict.pass, false)
})

test('an R harm fails H1 and reads as the harm outcome', () => {
  const verdict = computeRoutingGate(fixtureTrials({ rPass: () => 0, sPass: t => t >= 3, nPass: t => t >= 3 }), gateOptions)
  assert.equal(verdict.hypotheses.H1.pass, false)
  assert.equal(verdict.pass, false)
  assert.match(verdict.failureReading, /H1 failed/)
})

test('a warm judged turn refuses a pass even with H1 intact', () => {
  const facts = fixtureTrials({ rPass: () => 1, sPass: t => t >= 3, nPass: t => t >= 3 })
  for (const fact of facts) if (fact.arm === 'R') fact.judgedWarmTurns = 2
  const verdict = computeRoutingGate(facts, gateOptions)
  assert.equal(verdict.screens.noWarmTurnJudged, false)
  assert.equal(verdict.pass, false)
})

test('null robustness facts refuse a pass instead of defaulting', () => {
  const facts = fixtureTrials({ rPass: () => 1, sPass: t => t >= 3, nPass: t => t >= 3 })
  for (const fact of facts) fact.lostTurns = null
  const verdict = computeRoutingGate(facts, gateOptions)
  assert.equal(verdict.screens.noLostTurns, null)
  assert.equal(verdict.pass, false)
})

test('an unrun replay gate refuses a pass', () => {
  const verdict = computeRoutingGate(fixtureTrials({ rPass: () => 1, sPass: t => t >= 3, nPass: t => t >= 3 }), { ...gateOptions, layaReplayPassed: null })
  assert.equal(verdict.pass, false)
})

test('observed p_disc above the design value is underpowered by construction', () => {
  const verdict = computeRoutingGate(fixtureTrials({ rPass: () => 1, sPass: t => t >= 3, nPass: t => t >= 3 }), gateOptions)
  assert.equal(verdict.power.underpoweredByConstruction, false)
  assert.ok(verdict.power.requiredPairsAtObserved > 0)
  const hot = computeRoutingGate(fixtureTrials({ rPass: () => 1, sPass: t => t >= 3, nPass: t => t >= 3 }), { ...gateOptions, designPdisc: 0.05 })
  assert.equal(hot.power.underpoweredByConstruction, true)
  assert.equal(hot.pass, false)
})

test('clusterRobustMean equals the plain mean with a positive se', () => {
  const est = clusterRobustMean([
    { taskId: 'a', value: 1 }, { taskId: 'a', value: 1 },
    { taskId: 'b', value: 0 }, { taskId: 'b', value: 0 },
  ])
  assert.equal(est.mean, 0.5)
  assert.ok(est.se > 0)
  assert.throws(() => clusterRobustMean([{ taskId: 'a', value: 1 }, { taskId: 'a', value: 1 }]), /at least 2 tasks/)
})

test('holm rejects a tiny p and stops the family at the first non-rejection', () => {
  const { rejected, pAdjusted } = holm({ A: 0.001, B: 0.5, C: 0.02, D: 0.03 }, 0.05)
  // Step-down: A clears 0.05/4, C misses 0.05/3, so the family stops at C
  // even though D's raw p is smaller than C's.
  assert.deepEqual(rejected, ['A'])
  assert.ok(pAdjusted.A <= 0.05)
  assert.ok(pAdjusted.B > 0.05)
  assert.ok(pAdjusted.A <= pAdjusted.C && pAdjusted.C <= pAdjusted.D)
})

test('normalCdf matches known values within the approximation error', () => {
  // Abramowitz-Stegun 7.1.26 bounds |erf error| by 1.5e-7; the gate's
  // p-values need no more than that.
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6)
  assert.ok(Math.abs(normalCdf(1.959963984540054) - 0.975) < 1e-6)
  assert.ok(Math.abs(normalCdf(-1.6448536269514722) - 0.05) < 1e-6)
})

test('percentile is nearest-rank', () => {
  assert.equal(percentile([1, 2, 3, 4], 95), 4)
  assert.equal(percentile([10, 20, 30], 50), 20)
  assert.throws(() => percentile([], 95), /empty/)
})

test('requiredPairs matches the preregistration table', () => {
  assert.equal(requiredPairs(0.06, 0.05), 189)
  assert.equal(requiredPairs(0.10, 0.05), 314)
  assert.equal(requiredPairs(0.15, 0.05), 471)
})
