import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyDailyCap } from '../src/m04-cap.js'

describe('m04-cap', () => {
  it('returns the candidate when it fits under the daily cap', () => {
    assert.equal(applyDailyCap(0, 500), 500)
    assert.equal(applyDailyCap(0, 1400), 1400)
  })

  it('clips a candidate that would exceed the daily cap', () => {
    assert.equal(applyDailyCap(1200, 400), 200)
    assert.equal(applyDailyCap(1400, 100), 0)
    assert.equal(applyDailyCap(1500, 50), 0)
  })

  it('rejects a non-finite or negative amount', () => {
    assert.throws(() => applyDailyCap(-1, 100), /invalid amount/)
    assert.throws(() => applyDailyCap(0, -1), /invalid amount/)
    assert.throws(() => applyDailyCap(NaN, 100), /invalid amount/)
    assert.throws(() => applyDailyCap(0, Infinity), /invalid amount/)
  })
})
