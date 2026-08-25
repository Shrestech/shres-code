import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateTrial } from '../schema/trial.js'
import { summarizeArm, summarizeCell, summarizeCells } from '../stats/aggregate.js'
import { bootstrapDeltaCi, bootstrapMeanCi, mulberry32, wilsonInterval } from '../stats/intervals.js'
import { gradeComparison, mcnemarExactP, pairOutcomes, passAtK } from '../stats/paired.js'

/**
 * Fabricate a schema-valid Trial for stats tests; overrides merge shallowly,
 * with `metrics` merging field-wise.
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
      inputTokens: 100, outputTokens: 50, durationMs: 1000, turns: 4,
      toolCalls: 3, identicalRetries: 0, checkpoints: 0, shipPasses: 0,
      tokensIncludingDescendants: null, costIncludingDescendants: null,
      danglingCard: null, verifiedCheckpointShare: null,
      coverageRefusalThenPad: 0, noopNoteRefusals: 0, noteCapRefusals: 0,
      sessionQueryCalls: null,
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
        inputTokens: 100, outputTokens: 50, durationMs: 1000, turns: 4,
        toolCalls: 3, identicalRetries: 0, checkpoints: 0, shipPasses: 0,
        tokensIncludingDescendants: null, costIncludingDescendants: null,
        danglingCard: null, verifiedCheckpointShare: null,
        coverageRefusalThenPad: 0, noopNoteRefusals: 0, noteCapRefusals: 0,
        sessionQueryCalls: null,
      },
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:00:01.000Z',
    }
  }

  it('accepts well-formed phases and integrity records', () => {
    validateTrial(makeTrial({ phases: [makePhase(0), makePhase(1)] }))
    validateTrial(makeTrial({ phases: [makePhase(0)], integrity: { violations: ['off-arm-jspace-event:jspace/card-open'] } }))
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
