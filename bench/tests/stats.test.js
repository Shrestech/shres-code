import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { validateTrial } from '../schema/trial.js'
import { validateReportData } from '../schema/report-data.js'
import { emptyMetrics } from '../runner/metrics.js'
import { summarizeArm, summarizeCell, summarizeCells } from '../stats/aggregate.js'
import { bootstrapDeltaCi, bootstrapMeanCi, mulberry32, wilsonInterval } from '../stats/intervals.js'
import { gradeComparison, mcnemarExactP, pairOutcomes, passAtK } from '../stats/paired.js'
import { buildVerdicts, JEV_ARMS, verdictChurnScreen, verdictCompactionDelta, verdictRoutingAdoption, verdictTokenDelta, verdictVerificationAdoption } from '../report/verdicts.js'
import { buildExperiment } from '../report/build.js'

/**
 * Fabricate a schema-valid Trial for stats tests; overrides merge shallowly,
 * with `metrics` merging field-wise over the runner's own empty record, so the
 * fixture satisfies the schema whenever another metric is added.
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../schema/trial.js').Trial}
 */
function makeTrial(overrides = {}) {
  const { metrics, ...rest } = overrides
  const resolved = rest.resolved ?? false
  return {
    taskId: 'task-a',
    trialIndex: 0,
    arm: 'off',
    status: 'success',
    resolved,
    failureMode: resolved ? null : 'VERIFY_FAILED',
    verifier: { command: 'node verify.mjs', exitCode: resolved ? 0 : 1 },
    metrics: {
      ...emptyMetrics(),
      inputTokens: 100, outputTokens: 50, durationMs: 1000, turns: 4,
      toolCalls: 3,
      ...metrics,
    },
    sessionFile: null,
    startedAt: '2026-08-18T00:00:00.000Z',
    endedAt: '2026-08-18T00:00:01.000Z',
    ...rest,
  }
}

/**
 * Assert |actual - expected| < eps; for the non-dyadic floats in these tests.
 * @param {number} actual
 * @param {number} expected
 * @param {number} [eps]
 */
function closeTo(actual, expected, eps = 1e-12) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`)
}

describe('wilsonInterval', () => {
  it('reports total uncertainty for 0/0', () => {
    assert.deepEqual(wilsonInterval(0, 0), [0, 1])
  })

  it('pins the lower bound to 0 when nothing resolved', () => {
    const [lo, hi] = wilsonInterval(0, 5)
    closeTo(lo, 0)
    closeTo(hi, 0.43449149475208104)
    assert.ok(hi < 1)
  })

  it('pins the upper bound to 1 when everything resolved', () => {
    const [lo, hi] = wilsonInterval(5, 5)
    closeTo(lo, 0.5655085052479191)
    closeTo(hi, 1)
    assert.ok(lo > 0)
  })

  it('is symmetric under k ↔ n-k and brackets the point estimate', () => {
    const [lo, hi] = wilsonInterval(5, 10)
    assert.ok(lo < 0.5 && hi > 0.5)
    const [rlo, rhi] = wilsonInterval(2, 10)
    closeTo(wilsonInterval(8, 10)[0], 1 - rhi)
    closeTo(wilsonInterval(8, 10)[1], 1 - rlo)
  })

  it('widens as the sample shrinks and never leaves [0, 1]', () => {
    const wide = wilsonInterval(1, 2)
    const narrow = wilsonInterval(50, 100)
    assert.ok(wide[1] - wide[0] > narrow[1] - narrow[0])
    for (const bound of [wide, narrow].flat()) assert.ok(bound >= 0 && bound <= 1)
  })
})

describe('bootstrapMeanCi', () => {
  const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('is deterministic for a fixed seed', () => {
    assert.deepEqual(bootstrapMeanCi(sample, { seed: 7 }), bootstrapMeanCi(sample, { seed: 7 }))
  })

  it('defaults are deterministic across calls', () => {
    assert.deepEqual(bootstrapMeanCi(sample), bootstrapMeanCi(sample))
  })

  it('changes with the seed on non-constant data', () => {
    assert.notDeepEqual(bootstrapMeanCi(sample, { seed: 1 }), bootstrapMeanCi(sample, { seed: 2 }))
  })

  it('brackets the sample mean within the data range', () => {
    const [lo, hi] = bootstrapMeanCi(sample, { seed: 3 })
    assert.ok(lo >= 1 && hi <= 10)
    assert.ok(lo <= 5.5 && hi >= 5.5)
    assert.ok(lo < hi)
  })

  it('collapses to the point for constant or single-element input', () => {
    assert.deepEqual(bootstrapMeanCi([7, 7, 7], { seed: 1 }), [7, 7])
    assert.deepEqual(bootstrapMeanCi([7], { seed: 1 }), [7, 7])
  })

  it('returns [NaN, NaN] for empty input', () => {
    const [lo, hi] = bootstrapMeanCi([])
    assert.ok(Number.isNaN(lo) && Number.isNaN(hi))
  })

  it('honors a custom resample count deterministically', () => {
    const ci = bootstrapMeanCi(sample, { resamples: 100, seed: 5 })
    assert.deepEqual(ci, bootstrapMeanCi(sample, { resamples: 100, seed: 5 }))
    assert.ok(ci[0] < ci[1])
  })
})

describe('bootstrapDeltaCi', () => {
  it('is deterministic for a fixed seed', () => {
    const pairs = [
      { off: false, on: true }, { off: true, on: false },
      { off: true, on: true }, { off: false, on: false },
    ]
    assert.deepEqual(bootstrapDeltaCi(pairs, { seed: 11 }), bootstrapDeltaCi(pairs, { seed: 11 }))
  })

  it('collapses to [1, 1] when every pair is a win', () => {
    const pairs = Array.from({ length: 5 }, () => ({ off: false, on: true }))
    assert.deepEqual(bootstrapDeltaCi(pairs, { seed: 1 }), [1, 1])
  })

  it('brackets the observed delta', () => {
    const pairs = [
      { off: false, on: true }, { off: false, on: true },
      { off: true, on: false }, { off: true, on: true }, { off: true, on: true },
    ]
    const [lo, hi] = bootstrapDeltaCi(pairs, { seed: 4 })
    closeTo(4 / 5 - 3 / 5, 0.2)
    assert.ok(lo <= 0.2 && hi >= 0.2)
    assert.ok(lo >= -1 && hi <= 1)
  })

  it('returns [NaN, NaN] for no pairs', () => {
    const [lo, hi] = bootstrapDeltaCi([])
    assert.ok(Number.isNaN(lo) && Number.isNaN(hi))
  })
})

describe('mulberry32', () => {
  it('produces the documented first outputs for seed 42', () => {
    const rng = mulberry32(42)
    closeTo(rng(), 0.6011037519201636)
    closeTo(rng(), 0.44829055899754167)
  })

  it('repeats the stream for equal seeds and stays in [0, 1)', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    for (let i = 0; i < 100; i++) {
      const v = a()
      assert.equal(v, b())
      assert.ok(v >= 0 && v < 1)
    }
  })
})

describe('pairOutcomes', () => {
  it('matches on taskId+trialIndex and counts from the on perspective', () => {
    const off = [
      makeTrial({ taskId: 'a', trialIndex: 0, resolved: true }),
      makeTrial({ taskId: 'a', trialIndex: 1 }),
      makeTrial({ taskId: 'b', trialIndex: 0, resolved: true }),
      makeTrial({ taskId: 'a', trialIndex: 2, status: 'error', failureMode: 'PROVIDER_ERROR' }),
    ]
    const on = [
      makeTrial({ taskId: 'a', trialIndex: 0, arm: 'on', resolved: true }), // tie
      makeTrial({ taskId: 'a', trialIndex: 1, arm: 'on', resolved: true }), // win
      makeTrial({ taskId: 'b', trialIndex: 0, arm: 'on' }), // loss
      makeTrial({ taskId: 'a', trialIndex: 2, arm: 'on', resolved: true }), // off errored: no pair
      makeTrial({ taskId: 'c', trialIndex: 0, arm: 'on', resolved: true }), // unmatched
    ]
    const result = pairOutcomes(off, on)
    assert.equal(result.wins, 1)
    assert.equal(result.losses, 1)
    assert.equal(result.ties, 1)
    assert.equal(result.pairs.length, 3)
  })

  it('skips error trials on the on side and pairs each baseline once', () => {
    const off = [makeTrial({ taskId: 'a', trialIndex: 0, resolved: true })]
    const on = [makeTrial({ taskId: 'a', trialIndex: 0, arm: 'on', status: 'error', failureMode: 'HARNESS_ERROR' })]
    assert.deepEqual(pairOutcomes(off, on), { pairs: [], wins: 0, losses: 0, ties: 0 })
  })

  it('returns zero counts for empty inputs', () => {
    assert.deepEqual(pairOutcomes([], []), { pairs: [], wins: 0, losses: 0, ties: 0 })
  })
})

describe('mcnemarExactP', () => {
  it('returns null when only ties exist', () => {
    assert.equal(mcnemarExactP(0, 0), null)
  })

  it('computes the exact binomial for 9 wins and 1 loss', () => {
    assert.equal(mcnemarExactP(9, 1), 0.021484375)
    assert.equal(mcnemarExactP(1, 9), 0.021484375)
  })

  it('caps at 1 for balanced discordance', () => {
    assert.equal(mcnemarExactP(5, 5), 1)
  })

  it('is exact for a one-sided sweep', () => {
    assert.equal(mcnemarExactP(25, 0), 2 ** -24)
    assert.ok(mcnemarExactP(25, 0) < 0.05)
    assert.equal(mcnemarExactP(0, 3), 0.25)
  })
})

describe('passAtK', () => {
  it('matches pass@1 = c/n', () => {
    assert.equal(passAtK(5, 3, 1), 0.6)
  })

  it('computes known values', () => {
    assert.equal(passAtK(5, 3, 2), 0.9)
    closeTo(passAtK(10, 2, 5), 7 / 9)
  })

  it('hits the edges: c = 0, c = n, k = n', () => {
    assert.equal(passAtK(5, 0, 3), 0)
    assert.equal(passAtK(5, 5, 1), 1)
    assert.equal(passAtK(5, 3, 5), 1)
  })

  it('rejects out-of-range counts', () => {
    assert.throws(() => passAtK(0, 0, 1), RangeError)
    assert.throws(() => passAtK(5, 3, 0), RangeError)
    assert.throws(() => passAtK(5, 3, 6), RangeError)
    assert.throws(() => passAtK(5, 6, 1), RangeError)
    assert.throws(() => passAtK(5.5, 3, 1), RangeError)
  })
})

describe('gradeComparison', () => {
  it('grades a significant affordable improvement as improvement', () => {
    assert.equal(gradeComparison({ mcnemarP: 0.01, deltaAccuracy: 0.2, tokenOverheadRatio: 1.1 }), 'improvement')
  })

  it('accepts overhead exactly at the 1.25 budget as improvement', () => {
    assert.equal(gradeComparison({ mcnemarP: 0.049, deltaAccuracy: 0.01, tokenOverheadRatio: 1.25 }), 'improvement')
  })

  it('grades a significant improvement above budget as tradeoff', () => {
    assert.equal(gradeComparison({ mcnemarP: 0.01, deltaAccuracy: 0.2, tokenOverheadRatio: 1.2501 }), 'tradeoff')
  })

  it('grades a significant negative delta as regression regardless of overhead', () => {
    assert.equal(gradeComparison({ mcnemarP: 0.01, deltaAccuracy: -0.1, tokenOverheadRatio: 1.0 }), 'regression')
    assert.equal(gradeComparison({ mcnemarP: 0.01, deltaAccuracy: -0.1, tokenOverheadRatio: 2.0 }), 'regression')
  })

  it('treats p = 0.05 exactly as not significant', () => {
    assert.equal(gradeComparison({ mcnemarP: 0.05, deltaAccuracy: 0.2, tokenOverheadRatio: 1.0 }), 'tie')
  })

  it('treats a null p (no discordant pairs) as tie', () => {
    assert.equal(gradeComparison({ mcnemarP: null, deltaAccuracy: 0, tokenOverheadRatio: 1.0 }), 'tie')
  })

  it('treats a significant p with zero delta as tie', () => {
    assert.equal(gradeComparison({ mcnemarP: 0.01, deltaAccuracy: 0, tokenOverheadRatio: 1.0 }), 'tie')
  })
})

describe('summarizeCell', () => {
  it('aggregates one task×arm group, excluding error trials from every mean', () => {
    const trials = [
      makeTrial({ taskId: 'a', trialIndex: 0, resolved: true, metrics: { inputTokens: 100, turns: 2, checkpoints: 1 } }),
      makeTrial({ taskId: 'a', trialIndex: 1, resolved: true, metrics: { inputTokens: 200, turns: 4, identicalRetries: 2 } }),
      makeTrial({ taskId: 'a', trialIndex: 2, metrics: { inputTokens: 300, turns: 6 } }),
      makeTrial({ taskId: 'a', trialIndex: 3, status: 'error', failureMode: 'PROVIDER_ERROR', metrics: { inputTokens: 9000, turns: 99 } }),
    ]
    const cell = summarizeCell('a', 'off', trials)
    assert.equal(cell.taskId, 'a')
    assert.equal(cell.arm, 'off')
    assert.equal(cell.trials, 3)
    assert.equal(cell.errors, 1)
    assert.equal(cell.resolved, 2)
    closeTo(cell.passRate, 2 / 3)
    assert.equal(cell.ci95.length, 2)
    assert.ok(cell.ci95[0] <= cell.passRate && cell.passRate <= cell.ci95[1])
    closeTo(cell.meanInputTokens, 200)
    closeTo(cell.meanTurns, 4)
    closeTo(cell.meanIdenticalRetries, 2 / 3)
    closeTo(cell.meanCheckpoints, 1 / 3)
    closeTo(cell.meanToolCalls, 3)
  })

  it('reports an empty group without throwing', () => {
    const cell = summarizeCell('a', 'on', [])
    assert.equal(cell.trials, 0)
    assert.equal(cell.errors, 0)
    assert.ok(Number.isNaN(cell.passRate))
    assert.deepEqual(cell.ci95, [0, 1])
    assert.ok(Number.isNaN(cell.meanInputTokens))
  })
})

describe('summarizeCells', () => {
  it('groups by taskId×arm and sorts by taskId then arm', () => {
    const trials = [
      makeTrial({ taskId: 'b', arm: 'on', trialIndex: 0, resolved: true }),
      makeTrial({ taskId: 'a', arm: 'on', trialIndex: 0 }),
      makeTrial({ taskId: 'b', arm: 'off', trialIndex: 0, resolved: true }),
      makeTrial({ taskId: 'a', arm: 'off', trialIndex: 0 }),
    ]
    const cells = summarizeCells(trials)
    assert.deepEqual(cells.map(c => `${c.taskId}/${c.arm}`), ['a/off', 'a/on', 'b/off', 'b/on'])
    assert.equal(cells[0].passRate, 0)
    assert.equal(cells[2].passRate, 1)
  })

  it('returns an empty list for no trials', () => {
    assert.deepEqual(summarizeCells([]), [])
  })
})

describe('summarizeArm', () => {
  it('aggregates an arm summary over success trials only', () => {
    const trials = [
      makeTrial({ trialIndex: 0, resolved: true, metrics: { inputTokens: 100, outputTokens: 40, durationMs: 500, turns: 2, identicalRetries: 1 } }),
      makeTrial({ trialIndex: 1, resolved: true, metrics: { inputTokens: 200, outputTokens: 60, durationMs: 700, turns: 4 } }),
      makeTrial({ trialIndex: 2, metrics: { inputTokens: 300, outputTokens: 100, durationMs: 900, turns: 6, identicalRetries: 3 } }),
      makeTrial({ trialIndex: 3, status: 'error', failureMode: 'AGENT_TIMEOUT', metrics: { inputTokens: 9000 } }),
    ]
    const s = summarizeArm('off', trials)
    assert.equal(s.arm, 'off')
    assert.equal(s.trials, 3)
    closeTo(s.accuracy, 2 / 3)
    closeTo(s.stderr, Math.sqrt((2 / 3) * (1 / 3) / 3))
    assert.equal(s.ci95.length, 2)
    assert.equal(s.totalInputTokens, 600)
    assert.equal(s.totalOutputTokens, 200)
    assert.equal(s.totalDurationMs, 2100)
    closeTo(s.meanTurns, 4)
    assert.equal(s.totalIdenticalRetries, 4)
  })

  it('reports an empty arm with NaN rates and zero totals', () => {
    const s = summarizeArm('on', [])
    assert.equal(s.trials, 0)
    assert.ok(Number.isNaN(s.accuracy) && Number.isNaN(s.stderr))
    assert.deepEqual(s.ci95, [0, 1])
    assert.equal(s.totalInputTokens, 0)
    assert.ok(Number.isNaN(s.meanTurns))
  })
})

describe('test fixtures', () => {
  it('fabricated trials validate against the schema', () => {
    validateTrial(makeTrial())
    validateTrial(makeTrial({ resolved: true }))
    validateTrial(makeTrial({ status: 'error', failureMode: 'PROVIDER_ERROR' }))
  })

  it('accepts single-session execution evidence and legacy rows without it', () => {
    validateTrial(makeTrial({ execution: { exitCode: 0, timedOut: false, budgetExceeded: false } }))
    validateTrial(makeTrial({ execution: { exitCode: null, timedOut: false, budgetExceeded: true } }))
  })

  it('rejects malformed single-session execution evidence', () => {
    assert.throws(
      () => validateTrial(makeTrial({ execution: { exitCode: '0', timedOut: false, budgetExceeded: false } })),
      /trial\.execution\.exitCode must be an integer\|null/,
    )
    assert.throws(
      () => validateTrial(makeTrial({ execution: { exitCode: 0, timedOut: 0, budgetExceeded: false } })),
      /trial\.execution\.timedOut must be boolean/,
    )
    assert.throws(
      () => validateTrial(makeTrial({ execution: { exitCode: 0, timedOut: false, budgetExceeded: 0 } })),
      /trial\.execution\.budgetExceeded must be boolean/,
    )
  })
})

describe('chain trial schema', () => {
  /**
   * Fabricate a valid PhaseRecord.
   * @param {number} phaseIndex - zero-based phase order.
   * @returns {import('../schema/trial.js').PhaseRecord}
   */
  function makePhase(phaseIndex) {
    return {
      phaseIndex,
      sessionFile: `sessions/task-a/0/phase-${phaseIndex}/w/s1/session.jsonl`,
      resumedFrom: null,
      exitCode: 0,
      timedOut: false,
      metrics: {
        ...emptyMetrics(),
        inputTokens: 100, outputTokens: 50, durationMs: 1000, turns: 4,
        toolCalls: 3,
      },
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:00:01.000Z',
    }
  }

  it('accepts well-formed phases and integrity records', () => {
    validateTrial(makeTrial({ phases: [makePhase(0), makePhase(1)] }))
    validateTrial(makeTrial({ phases: [makePhase(0)], integrity: { violations: ['off-arm-jspace-event:jspace/card'] } }))
  })

  it('rejects out-of-order phase indexes and malformed optional fields', () => {
    assert.throws(() => validateTrial(makeTrial({ phases: [makePhase(1)] })), /phases\[0\]\.phaseIndex must be 0/)
    assert.throws(() => validateTrial(makeTrial({ phases: [] })), /trial\.phases must be a non-empty array/)
    assert.throws(
      () => validateTrial(makeTrial({ phases: [{ ...makePhase(0), resumedFrom: 42 }] })),
      /phases\[0\]\.resumedFrom must be string\|null/,
    )
    assert.throws(
      () => validateTrial(makeTrial({ phases: [{ ...makePhase(0), metrics: { inputTokens: -1 } }] })),
      /phases\[0\]\.metrics\.inputTokens must be a non-negative number/,
    )
    assert.throws(
      () => validateTrial(makeTrial({ integrity: { violations: ['ok', 7] } })),
      /trial\.integrity\.violations must be a string array/,
    )
  })

  it('aggregates chain trials at trial level; phases stay drill-down detail', () => {
    const chain = makeTrial({
      taskId: 'chain-x',
      resolved: true,
      metrics: { inputTokens: 300, turns: 8, checkpoints: 2 },
      phases: [makePhase(0), makePhase(1)],
    })
    const cell = summarizeCell('chain-x', 'off', [chain])
    assert.equal(cell.trials, 1)
    assert.equal(cell.passRate, 1)
    closeTo(cell.meanInputTokens, 300)
    closeTo(cell.meanTurns, 8)
    closeTo(cell.meanCheckpoints, 2)
  })
})
describe('report.verdicts', () => {
  /**
   * One trial of a Jev arm carrying the metrics a rule reads.
   * @param {string} arm - arm name.
   * @param {number} trialIndex - repetition index.
   * @param {{ resolved?: boolean, metrics?: Record<string, unknown> }} [overrides] - trial overrides.
   * @returns {import('../schema/trial.js').Trial}
   */
  function jevTrial(arm, trialIndex, overrides = {}) {
    return makeTrial({
      arm,
      taskId: 'jev-task',
      trialIndex,
      resolved: overrides.resolved ?? true,
      metrics: overrides.metrics ?? {},
    })
  }

  /**
   * The arm's trials with the first `withUsage` carrying a cache share.
   * @param {string} arm - arm name.
   * @param {number} count - trial count.
   * @param {number} withUsage - how many carry usage data.
   * @returns {import('../schema/trial.js').Trial[]}
   */
  function usageTrials(arm, count, withUsage) {
    const trials = []
    for (let i = 0; i < count; i += 1) {
      trials.push(jevTrial(arm, i, { metrics: { cacheHitShare: i < withUsage ? 0.4 : null } }))
    }
    return trials
  }

  /**
   * A compacting trial: pressureFired plus the tokens a ceiling test needs.
   * @param {string} arm - arm name.
   * @param {number} trialIndex - repetition index.
   * @param {{ resolved?: boolean, tokens?: number, verified?: boolean }} [overrides]
   * @returns {import('../schema/trial.js').Trial}
   */
  function compactingTrial(arm, trialIndex, overrides = {}) {
    const metrics = { pressureFired: true, compactionCount: 1, tokensIncludingDescendants: overrides.tokens ?? 1000 }
    if (overrides.verified !== false) metrics.jevCompactionAcceptedBelowThreshold = 0
    return jevTrial(arm, trialIndex, { resolved: overrides.resolved ?? true, metrics })
  }

  /**
   * Every verdict is either evaluable with an outcome, an interval, and no
   * reason, or not-evaluable with a reason and no outcome at all.
   * @param {import('../report/verdicts.js').ReportVerdict[]} verdicts - verdict block.
   */
  function assertHonest(verdicts) {
    assert.equal(verdicts.length, 5)
    assert.deepEqual(verdicts.map(v => v.id), ['H2', 'H3', 'H4', 'H5', 'H6'])
    for (const verdict of verdicts) {
      assert.ok(Number.isSafeInteger(verdict.trials) && verdict.trials >= 0, `${verdict.id}.trials`)
      assert.ok(verdict.arms.length > 0 && verdict.rule.length > 0, `${verdict.id} names its arms and rule`)
      if (verdict.status === 'evaluable') {
        assert.ok(verdict.outcome === 'pass' || verdict.outcome === 'fail', `${verdict.id} carries an outcome`)
        assert.equal(verdict.reason, null, `${verdict.id} evaluable has no reason`)
        assert.equal(verdict.ci95.length, 2, `${verdict.id} carries its interval`)
        assert.ok(verdict.ci95.every(Number.isFinite), `${verdict.id} interval is finite`)
        assert.ok(Number.isFinite(verdict.observed) && Number.isFinite(verdict.threshold))
        assert.ok(verdict.trials >= 2, `${verdict.id} evaluates on at least two units`)
      } else {
        assert.equal(verdict.status, 'not-evaluable')
        assert.equal(verdict.outcome, null, `${verdict.id} is never a pass and never a fail-by-default`)
        assert.equal(verdict.observed, null)
        assert.equal(verdict.threshold, null)
        assert.equal(verdict.ci95, null)
        assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0, `${verdict.id} states its reason`)
      }
    }
  }

  it('applies the churn screen at exactly 80% coverage and refuses just below it', () => {
    const atEighty = [...usageTrials('route-off', 10, 8), ...usageTrials('route-on', 10, 8)]
    const evaluable = verdictChurnScreen(atEighty)
    assert.equal(evaluable.status, 'evaluable')
    // The interval reads the pairs that carry a share in both arms; the arm
    // means read the same 8 trials each and must not fold the 2 nulls in as 0.
    assert.equal(evaluable.trials, 8)
    assert.equal(evaluable.facts.matchedPairs, 10)
    assert.equal(evaluable.facts.routeOffUsageTrials, 8)
    closeTo(evaluable.facts.meanCacheHitShareRouteOff, 0.4)
    closeTo(evaluable.facts.meanCacheHitShareRouteOn, 0.4)

    const below = [...usageTrials('route-off', 10, 8), ...usageTrials('route-on', 10, 7)]
    const refused = verdictChurnScreen(below)
    assert.equal(refused.status, 'not-evaluable')
    assert.equal(refused.outcome, null)
    assert.match(refused.reason, /route-on: cacheHitShare is null on 3 of 10 trials \(70\.0% carry usage data\)/)
    // The point of the screen: the churn claim is never made on a partial sample.
    assert.equal(refused.facts.routeOnUsageTrials, 7)
    assert.equal(refused.facts.requiredShare, 0.8)
  })

  it('passes the churn screen at exactly the −5 point margin and fails below it', () => {
    const atMargin = [...usageTrials('route-off', 4, 4).map(t => ({ ...t, metrics: { ...t.metrics, cacheHitShare: 0.5 } })),
      ...usageTrials('route-on', 4, 4).map(t => ({ ...t, metrics: { ...t.metrics, cacheHitShare: 0.45 } }))]
    const passed = verdictChurnScreen(atMargin)
    assert.equal(passed.outcome, 'pass')
    closeTo(passed.observed, -0.05)

    const below = [...usageTrials('route-off', 4, 4).map(t => ({ ...t, metrics: { ...t.metrics, cacheHitShare: 0.5 } })),
      ...usageTrials('route-on', 4, 4).map(t => ({ ...t, metrics: { ...t.metrics, cacheHitShare: 0.44 } }))]
    assert.equal(verdictChurnScreen(below).outcome, 'fail')
  })

  it('applies the 2/3 adoption screen at exactly 2/3 and refuses below it', () => {
    const judged = index => jevTrial('route-on', index, { metrics: { downgradedStreaks: [] } })
    const unjudged = index => jevTrial('route-on', index, { metrics: { downgradedStreaks: null } })
    const atTwoThirds = verdictRoutingAdoption([judged(0), judged(1), unjudged(2)])
    assert.equal(atTwoThirds.status, 'evaluable')
    assert.equal(atTwoThirds.outcome, 'pass')
    assert.equal(atTwoThirds.facts.decisionTrials, 2)
    closeTo(atTwoThirds.observed, 2 / 3)

    const below = verdictRoutingAdoption([judged(0), unjudged(1), unjudged(2)])
    assert.equal(below.outcome, 'fail')
    assert.equal(below.facts.decisionTrials, 1)

    assert.equal(verdictRoutingAdoption([]).status, 'not-evaluable')
    assert.match(verdictRoutingAdoption([]).reason, /route-on has no success-status trial/)
  })

  it('applies the compaction 2/3 adoption screen over compacting trials only', () => {
    const compacted = (index, verified) => compactingTrial('compact-jev', index, { verified })
    const atTwoThirds = verdictVerificationAdoption([compacted(0, true), compacted(1, true), compacted(2, false)])
    assert.equal(atTwoThirds.outcome, 'pass')
    assert.equal(atTwoThirds.trials, 3)
    assert.equal(atTwoThirds.facts.verifiedTrials, 2)

    // A trial that never compacted is not in the screen's denominator.
    const withIdleTrials = [...[compacted(0, true), compacted(1, true), compacted(2, false)], jevTrial('compact-jev', 3, { metrics: { pressureFired: false } })]
    assert.equal(verdictVerificationAdoption(withIdleTrials).outcome, 'pass')
    assert.equal(verdictVerificationAdoption(withIdleTrials).trials, 3)

    assert.equal(verdictVerificationAdoption([compacted(0, false), compacted(1, false), compacted(2, false)]).outcome, 'fail')
    const idle = verdictVerificationAdoption([jevTrial('compact-jev', 0, { metrics: { pressureFired: false } })])
    assert.equal(idle.status, 'not-evaluable')
    assert.match(idle.reason, /no compact-jev trial compacted/)
  })

  it('refuses the token delta on an empty downgraded subset', () => {
    const adoption = verdictRoutingAdoption([jevTrial('route-on', 0, { metrics: { downgradedStreaks: [] } })])
    const trials = [jevTrial('route-off', 0, { metrics: { tokensIncludingDescendants: 1000 } }), ...trialsWithKeptStrongOnly()]
    const verdict = verdictTokenDelta(trials, adoption)
    assert.equal(verdict.status, 'not-evaluable')
    assert.equal(verdict.outcome, null)
    assert.match(verdict.reason, /no route-on trial logged a downgraded decision/)
    assert.equal(verdict.facts.downgradedTrials, 0)
  })

  it('refuses the token delta when the adoption screen it depends on failed', () => {
    const treatment = [
      jevTrial('route-on', 0, { metrics: { downgradedStreaks: [1], tokensIncludingDescendants: 700 } }),
      jevTrial('route-on', 1, { metrics: { downgradedStreaks: null } }),
      jevTrial('route-on', 2, { metrics: { downgradedStreaks: null } }),
    ]
    const adoption = verdictRoutingAdoption(treatment)
    assert.equal(adoption.outcome, 'fail')
    const verdict = verdictTokenDelta([...treatment, jevTrial('route-off', 0, { metrics: { tokensIncludingDescendants: 1000 } })], adoption)
    assert.equal(verdict.status, 'not-evaluable')
    assert.match(verdict.reason, /routing-adoption screen \(H3\) failed/)
    assert.match(verdict.reason, /did not exercise the intervention/)
  })

  it('passes the token delta at exactly 15% below the paired baseline and fails above it', () => {
    const adoption = verdictRoutingAdoption([jevTrial('route-on', 0, { metrics: { downgradedStreaks: [1] } }), jevTrial('route-on', 1, { metrics: { downgradedStreaks: [1] } })])
    const paired = (onTokens) => [
      jevTrial('route-off', 0, { metrics: { tokensIncludingDescendants: 1000 } }),
      jevTrial('route-off', 1, { metrics: { tokensIncludingDescendants: 2000 } }),
      jevTrial('route-on', 0, { metrics: { downgradedStreaks: [1], tokensIncludingDescendants: onTokens[0] } }),
      jevTrial('route-on', 1, { metrics: { downgradedStreaks: [1], tokensIncludingDescendants: onTokens[1] } }),
    ]
    const atFifteen = verdictTokenDelta(paired([850, 1700]), adoption)
    assert.equal(atFifteen.status, 'evaluable')
    assert.equal(atFifteen.outcome, 'pass')
    closeTo(atFifteen.observed, -0.15)
    assert.equal(atFifteen.trials, 2)

    const above = verdictTokenDelta(paired([851, 1701]), adoption)
    assert.equal(above.outcome, 'fail')

    const onePair = verdictTokenDelta([
      jevTrial('route-off', 0, { metrics: { tokensIncludingDescendants: 1000 } }),
      jevTrial('route-on', 0, { metrics: { downgradedStreaks: [1], tokensIncludingDescendants: 500 } }),
    ], adoption)
    assert.equal(onePair.status, 'not-evaluable')
    assert.match(onePair.reason, /fewer than 2 matched pairs/)
  })

  it('does not call a zero-crossing compaction delta a result', () => {
    const basic = [compactingTrial('compact-basic', 0, { resolved: false }), compactingTrial('compact-basic', 1, { resolved: true }),
      compactingTrial('compact-basic', 2, { resolved: false }), compactingTrial('compact-basic', 3, { resolved: false })]
    const jev = [compactingTrial('compact-jev', 0, { resolved: true }), compactingTrial('compact-jev', 1, { resolved: false }),
      compactingTrial('compact-jev', 2, { resolved: false }), compactingTrial('compact-jev', 3, { resolved: false })]
    const adoption = verdictVerificationAdoption(jev)
    assert.equal(adoption.outcome, 'pass')
    const verdict = verdictCompactionDelta([...basic, ...jev], adoption)
    assert.equal(verdict.status, 'evaluable')
    assert.equal(verdict.outcome, 'fail')
    assert.equal(verdict.observed, 0)
    assert.ok(verdict.ci95[0] <= 0 && verdict.ci95[1] >= 0, 'the interval crosses zero, so the delta is not a result')
    assert.equal(verdict.facts.deltaMet, false)
  })

  it('keeps the compaction token ceiling at exactly 1.2× and fails above it', () => {
    const basic = [0, 1, 2, 3].map(i => compactingTrial('compact-basic', i, { resolved: false, tokens: 1000 }))
    const passing = [0, 1, 2, 3].map(i => compactingTrial('compact-jev', i, { resolved: true, tokens: 1200 }))
    const adoption = verdictVerificationAdoption(passing)
    const atCeiling = verdictCompactionDelta([...basic, ...passing], adoption)
    assert.equal(atCeiling.status, 'evaluable')
    assert.equal(atCeiling.outcome, 'pass')
    closeTo(atCeiling.facts.tokenRatio, 1.2)

    const above = [0, 1, 2, 3].map(i => compactingTrial('compact-jev', i, { resolved: true, tokens: 1201 }))
    const verdict = verdictCompactionDelta([...basic, ...above], verdictVerificationAdoption(above))
    assert.equal(verdict.outcome, 'fail')
    assert.equal(verdict.facts.deltaMet, true)
    assert.equal(verdict.facts.ceilingMet, false)
  })

  it('refuses the compaction verdict when the verification screen it depends on failed', () => {
    const basic = [0, 1].map(i => compactingTrial('compact-basic', i, { resolved: false }))
    const jev = [0, 1].map(i => compactingTrial('compact-jev', i, { resolved: true, verified: false }))
    const adoption = verdictVerificationAdoption(jev)
    assert.equal(adoption.outcome, 'fail')
    const verdict = verdictCompactionDelta([...basic, ...jev], adoption)
    assert.equal(verdict.status, 'not-evaluable')
    assert.match(verdict.reason, /verification-adoption screen \(H6\) failed/)
  })

  it('reports five honest verdicts for an experiment that ran none of the Jev arms', () => {
    const verdicts = buildVerdicts([makeTrial({ arm: 'off', resolved: true })])
    assertHonest(verdicts)
    for (const verdict of verdicts) {
      assert.equal(verdict.status, 'not-evaluable')
      assert.ok(verdict.reason.length > 0)
    }
    // Each rule names its own missing datum rather than a shared catch-all.
    assert.match(verdicts.find(v => v.id === 'H3').reason, /route-on has no success-status trial/)
    assert.match(verdicts.find(v => v.id === 'H2').reason, /no route-on trial logged a downgraded decision/)
    assert.match(verdicts.find(v => v.id === 'H5').reason, /compact-basic has no trial that compacted/)
  })

  it('enforces the honesty invariant in the report schema', () => {
    const base = { version: 1, demo: false, generatedAt: '2026-09-17T00:00:00.000Z', experiment: 'x', tasks: [], cells: [], arms: [], comparisons: [] }
    const honest = { id: 'H3', rule: 'r', arms: ['route-on'], status: 'not-evaluable', outcome: null, reason: 'arm route-on has no trial', observed: null, threshold: null, ci95: null, trials: 0, facts: {} }
    validateReportData({ ...base, verdicts: [honest] })
    assert.throws(
      () => validateReportData({ ...base, verdicts: [{ ...honest, outcome: 'pass' }] }),
      /verdicts\[0\]\.outcome must be null when the verdict is not evaluable/,
    )
    assert.throws(
      () => validateReportData({ ...base, verdicts: [{ ...honest, status: 'evaluable' }] }),
      /verdicts\[0\]\.outcome must be pass\|fail when the verdict is evaluable/,
    )
    assert.throws(
      () => validateReportData({ ...base, verdicts: [{ ...honest, reason: '' }] }),
      /verdicts\[0\]\.reason must state why the verdict is not evaluable/,
    )
    validateReportData({ ...base, verdicts: [{ ...honest, status: 'evaluable', outcome: 'pass', reason: null, observed: 1, threshold: 1, ci95: [0, 1], trials: 3 }] })
    assert.throws(
      () => validateReportData({ ...base, verdicts: [{ ...honest, status: 'evaluable', outcome: 'pass', reason: 'why', observed: 1, threshold: 1, ci95: [0, 1], trials: 3 }] }),
      /verdicts\[0\]\.reason must be null when the verdict is evaluable/,
    )
    assert.throws(
      () => validateReportData({ ...base, verdicts: [{ ...honest, status: 'evaluable', outcome: 'pass', reason: null, observed: 1, threshold: 1, ci95: [0, Number.NaN], trials: 3 }] }),
      /verdicts\[0\]\.ci95 must be a finite two-number interval/,
    )
  })

  it('computes every verdict from an experiment fixture and lands them on the payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-verdicts-'))
    const experimentDir = join(root, 'jev-fixture')
    try {
      const routeOff = []
      const routeOn = []
      for (let i = 0; i < 6; i += 1) {
        routeOff.push(jevTrial(JEV_ARMS.routingControl, i, { metrics: { cacheHitShare: 0.4, tokensIncludingDescendants: 1000 } }))
        routeOn.push(jevTrial(JEV_ARMS.routingTreatment, i, { metrics: { cacheHitShare: 0.4, tokensIncludingDescendants: 700, downgradedStreaks: [2], downgradedShare: 1, keptStrongShare: 0, modelTransitions: 1 } }))
      }
      const basic = [0, 1, 2, 3].map(i => compactingTrial(JEV_ARMS.compactionControl, i, { resolved: false, tokens: 1000 }))
      const jev = [0, 1, 2, 3].map(i => compactingTrial(JEV_ARMS.compactionTreatment, i, { resolved: true, tokens: 1200 }))
      await writeArmDir(experimentDir, JEV_ARMS.routingControl, routeOff)
      await writeArmDir(experimentDir, JEV_ARMS.routingTreatment, routeOn)
      await writeArmDir(experimentDir, JEV_ARMS.compactionControl, basic)
      await writeArmDir(experimentDir, JEV_ARMS.compactionTreatment, jev)

      const uiDataPath = join(root, 'ui', 'data.js')
      const report = await buildExperiment(experimentDir, { uiDataPath, generatedAt: '2026-09-17T00:00:00.000Z' })
      validateReportData(report)

      const verdicts = report.verdicts
      assertHonest(verdicts)
      const byId = new Map(verdicts.map(v => [v.id, v]))
      assert.equal(byId.get('H2').status, 'evaluable')
      assert.equal(byId.get('H2').outcome, 'pass')
      closeTo(byId.get('H2').observed, -0.3)
      assert.equal(byId.get('H2').trials, 6)
      assert.equal(byId.get('H3').outcome, 'pass')
      assert.equal(byId.get('H3').trials, 6)
      assert.equal(byId.get('H4').outcome, 'pass')
      assert.equal(byId.get('H4').trials, 6)
      assert.equal(byId.get('H5').outcome, 'pass')
      assert.equal(byId.get('H5').trials, 4)
      closeTo(byId.get('H5').facts.tokenRatio, 1.2)
      assert.equal(byId.get('H6').outcome, 'pass')
      assert.equal(byId.get('H6').trials, 4)

      // Per-arm results.json carries exactly the verdicts that read that arm.
      const routeOffResults = JSON.parse(await readFile(join(experimentDir, 'route-off', 'results.json'), 'utf8'))
      assert.deepEqual(routeOffResults.verdicts.map(v => v.id), ['H2', 'H4'])
      const routeOnResults = JSON.parse(await readFile(join(experimentDir, 'route-on', 'results.json'), 'utf8'))
      assert.deepEqual(routeOnResults.verdicts.map(v => v.id), ['H2', 'H3', 'H4'])
      const compactBasicResults = JSON.parse(await readFile(join(experimentDir, 'compact-basic', 'results.json'), 'utf8'))
      assert.deepEqual(compactBasicResults.verdicts.map(v => v.id), ['H5'])
      const compactJevResults = JSON.parse(await readFile(join(experimentDir, 'compact-jev', 'results.json'), 'utf8'))
      assert.deepEqual(compactJevResults.verdicts.map(v => v.id), ['H5', 'H6'])

      // The report the UI reads carries the same block.
      const uiData = await readFile(uiDataPath, 'utf8')
      const payload = JSON.parse(uiData.replace('globalThis.BENCH_REPORT = ', '').replace(/;\n$/, ''))
      assert.deepEqual(payload.verdicts.map(v => v.id), ['H2', 'H3', 'H4', 'H5', 'H6'])
      assert.equal(payload.verdicts.filter(v => v.status === 'evaluable').length, 5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * A route-on arm whose router judged turns but never downgraded one.
 * @returns {import('../schema/trial.js').Trial[]}
 */
function trialsWithKeptStrongOnly() {
  return [
    { arm: 'route-on', taskId: 'jev-task', trialIndex: 0 },
    { arm: 'route-on', taskId: 'jev-task', trialIndex: 1 },
  ].map(spec => makeTrial({ ...spec, resolved: true, metrics: { downgradedStreaks: [] } }))
}

/**
 * Write one arm directory (run.json + trials.jsonl) for a payload fixture.
 * @param {string} experimentDir - experiment root.
 * @param {string} arm - arm name.
 * @param {import('../schema/trial.js').Trial[]} trials - the arm's trials.
 */
async function writeArmDir(experimentDir, arm, trials) {
  const dir = join(experimentDir, arm)
  await mkdir(dir, { recursive: true })
  const manifest = {
    version: 1,
    experiment: experimentDir.split(/[/\\]/).pop(),
    arm,
    armConfig: {},
    model: 'deepseek-chat',
    baseUrl: null,
    temperature: 0,
    repeats: 1,
    taskIds: ['jev-task'],
    gitCommit: 'deadbeef',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    tierPatches: [],
    maxTotalTokens: null,
    startedAt: '2026-09-17T00:00:00.000Z',
    endedAt: '2026-09-17T01:00:00.000Z',
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify(manifest) + '\n')
  await writeFile(join(dir, 'trials.jsonl'), trials.map(t => JSON.stringify(t)).join('\n') + '\n')
}
