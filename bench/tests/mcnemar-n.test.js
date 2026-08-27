import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ALPHA,
  TARGET_POWER,
  Z_ALPHA_2,
  connorN,
  discordantCells,
  exactBinomialMcnemarPower,
  exactDiscordantN,
  exactMcnemarN,
  exactMcnemarPower,
  miettinenCorrectedN,
  planN,
} from '../analysis/mcnemar-n.js'
import { assertFixtureMatchesRuns, loadFixture, pairFromRuns, w9PowerReport } from '../analysis/w9-power.js'
import { mcnemarExactP } from '../stats/paired.js'

/**
 * Assert |actual - expected| < eps.
 * @param {number} actual
 * @param {number} expected
 * @param {number} [eps]
 */
function closeTo(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`)
}

describe('discordantCells', () => {
  it('splits ψ and δ into p01 and p10', () => {
    assert.deepEqual(discordantCells(0.5, 0.25), { p01: 0.375, p10: 0.125 })
  })

  it('rejects |δ| > ψ, non-positive ψ, and ψ > 1', () => {
    assert.equal(discordantCells(0.2, 0.25), null)
    assert.equal(discordantCells(0, 0), null)
    assert.equal(discordantCells(1.1, 0.1), null)
    assert.equal(discordantCells(0.4, Number.NaN), null)
  })
})

describe('connorN / miettinenCorrectedN', () => {
  it('matches the Connor (1987) closed form at ψ = 0.5, δ = 0.25', () => {
    const psi = 0.5
    const delta = 0.25
    const num = Z_ALPHA_2 * Math.sqrt(psi) + 0.841621233572914 * Math.sqrt(psi - delta * delta)
    closeTo(connorN(psi, delta), (num * num) / (delta * delta))
    closeTo(connorN(psi, delta) ?? 0, 60.378, 0.01)
  })

  it('is invariant to the sign of δ and larger after continuity correction', () => {
    const n = connorN(0.5, 0.25)
    assert.equal(n, connorN(0.5, -0.25))
    assert.ok((miettinenCorrectedN(0.5, 0.25) ?? 0) > (n ?? 0))
  })

  it('returns null when the alternative is infeasible or δ = 0', () => {
    assert.equal(connorN(0.2, 0.25), null)
    assert.equal(miettinenCorrectedN(0.2, 0.25), null)
    assert.equal(connorN(0.5, 0), null)
  })

  it('recomputes z when α or power is overridden', () => {
    const def = connorN(0.5, 0.25)
    const tighter = connorN(0.5, 0.25, { alpha: 0.01 })
    const weaker = connorN(0.5, 0.25, { power: 0.5 })
    const lowTail = connorN(0.5, 0.25, { power: 0.01 })
    assert.ok((tighter ?? 0) > (def ?? 0))
    assert.ok((weaker ?? 0) < (def ?? 0))
    assert.ok((lowTail ?? 0) < (weaker ?? 0))
    assert.throws(() => connorN(0.5, 0.25, { power: 0 }), /inverseNorm/)
  })
})

describe('exact McNemar power', () => {
  it('is near α under the null and rises with n under H1', () => {
    const nullPower = exactMcnemarPower(20, 0.5, 0)
    assert.ok(nullPower !== null && nullPower < 0.12)
    const small = exactMcnemarPower(20, 0.5, 0.25)
    const large = exactMcnemarPower(80, 0.5, 0.25)
    assert.ok((small ?? 0) < (large ?? 0))
    assert.ok((large ?? 0) > TARGET_POWER)
  })

  it('handles a one-sided discordant cell (p10 = 0)', () => {
    const pwr = exactMcnemarPower(8, 0.25, 0.25)
    assert.ok(pwr !== null && pwr > 0 && pwr <= 1)
  })

  it('returns null when infeasible and throws on a non-positive n', () => {
    assert.equal(exactMcnemarPower(8, 0.2, 0.25), null)
    assert.throws(() => exactMcnemarPower(0, 0.5, 0.25), /positive integer/)
  })
})

describe('exactMcnemarN', () => {
  it('returns the smallest n whose power meets the target', () => {
    const found = exactMcnemarN(0.5, 0.25)
    assert.ok(found)
    assert.ok(found.power >= TARGET_POWER)
    assert.ok((exactMcnemarPower(found.n - 1, 0.5, 0.25) ?? 1) < TARGET_POWER)
    assert.ok(found.n >= Math.floor(connorN(0.5, 0.25) ?? 0))
  })

  it('returns null when infeasible or max is below the required n', () => {
    assert.equal(exactMcnemarN(0.2, 0.25), null)
    assert.equal(exactMcnemarN(0.5, 0.25, { max: 8 }), null)
  })
})

describe('exactDiscordantN', () => {
  it('finds an n_d whose conditional power meets the target', () => {
    const found = exactDiscordantN(0.5, 0.25)
    assert.ok(found)
    closeTo(found.pi, 0.75)
    assert.ok(found.power >= TARGET_POWER)
    assert.ok(exactBinomialMcnemarPower(found.nDiscordant - 1, found.pi) < TARGET_POWER)
  })

  it('returns null when infeasible or max is too small', () => {
    assert.equal(exactDiscordantN(0.2, 0.25), null)
    assert.equal(exactDiscordantN(0.5, 0.25, { max: 4 }), null)
  })

  it('throws on a non-positive discordant count', () => {
    assert.throws(() => exactBinomialMcnemarPower(0, 0.75), /positive integer/)
  })
})

describe('planN', () => {
  it('ceils to a multiple of the task count', () => {
    assert.equal(planN(55.1, 2), 56)
    assert.equal(planN(56, 2), 56)
    assert.equal(planN(1.1), 2)
  })

  it('rejects non-positive inputs', () => {
    assert.throws(() => planN(0, 2), /planN/)
    assert.throws(() => planN(10, 0), /planN/)
  })
})

describe('w9PowerReport', () => {
  it('pairs the committed w7/w8 fixture and powers n at the pooled ψ', () => {
    const report = w9PowerReport()
    const [w7, , w8] = report.rows
    assert.equal(w7.n, 8)
    assert.equal(w7.wins, 1)
    assert.equal(w7.losses, 3)
    assert.equal(w8.n, 16)
    assert.equal(w8.wins, 3)
    assert.equal(w8.losses, 4)
    assert.equal(report.pooledN, 24)
    assert.equal(report.pooledDiscordant, 11)
    closeTo(report.observedPsi, 11 / 24)
    assert.ok(report.primary)
    assert.equal(report.primary.n, 62)
    assert.equal(report.primary.planN, 62)
    assert.ok(report.primary.power >= TARGET_POWER)
    assert.match(report.text, /infeasible/)
    assert.equal(mcnemarExactP(3, 4), 1)
    assert.equal(ALPHA, 0.05)
  })

  const runsOff = join(dirname(fileURLToPath(import.meta.url)), '../runs/w7-build-confirm-2026-08-26/off/trials.jsonl')
  it('fixture matches trials.jsonl pairing when runs/ is present', { skip: !existsSync(runsOff) }, () => {
    const fixture = loadFixture()
    assertFixtureMatchesRuns(fixture, pairFromRuns(fixture))
  })

  it('assertFixtureMatchesRuns rejects a drifted pair', () => {
    const fixture = loadFixture()
    const drifted = structuredClone(fixture)
    drifted[0].pairs[0].on = !drifted[0].pairs[0].on
    assert.throws(() => assertFixtureMatchesRuns(fixture, drifted), /disagrees/)
    assert.throws(() => assertFixtureMatchesRuns(fixture, []), /missing contrast/)
  })
})
