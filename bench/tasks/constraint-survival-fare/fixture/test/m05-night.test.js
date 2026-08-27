import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nightSurcharge } from '../src/m05-night.js'

describe('m05-night', () => {
  it('adds a 15% floored surcharge during the night window', () => {
    assert.equal(nightSurcharge(400, 0), 60)
    assert.equal(nightSurcharge(400, 299), 60)
    assert.equal(nightSurcharge(400, 1320), 60)
    assert.equal(nightSurcharge(400, 1439), 60)
    assert.equal(nightSurcharge(333, 0), 49)
  })

  it('adds nothing during the day', () => {
    assert.equal(nightSurcharge(400, 300), 0)
    assert.equal(nightSurcharge(400, 800), 0)
    assert.equal(nightSurcharge(400, 1319), 0)
  })

  it('rejects an out-of-range or non-integer minute count', () => {
    assert.throws(() => nightSurcharge(400, -1), /invalid time/)
    assert.throws(() => nightSurcharge(400, 1440), /invalid time/)
    assert.throws(() => nightSurcharge(400, 1.5), /invalid time/)
  })

  it('rejects a non-finite or negative fare', () => {
    assert.throws(() => nightSurcharge(-1, 0), /invalid fare/)
    assert.throws(() => nightSurcharge(NaN, 0), /invalid fare/)
  })
})
