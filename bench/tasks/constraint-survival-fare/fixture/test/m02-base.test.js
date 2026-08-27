import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { baseFare } from '../src/m02-base.js'

describe('m02-base', () => {
  it('prices same-zone and cross-zone trips in cents', () => {
    assert.equal(baseFare(1, 1), 250)
    assert.equal(baseFare(1, 2), 340)
    assert.equal(baseFare(1, 4), 520)
    assert.equal(baseFare(4, 6), 430)
  })

  it('is symmetric in the two zones', () => {
    assert.equal(baseFare(4, 1), 520)
    assert.equal(baseFare(6, 4), 430)
  })

  it('rejects a zone outside 1-9 or a non-integer', () => {
    assert.throws(() => baseFare(0, 1), /invalid zone/)
    assert.throws(() => baseFare(1, 10), /invalid zone/)
    assert.throws(() => baseFare(1.5, 2), /invalid zone/)
    assert.throws(() => baseFare(1, '2'), /invalid zone/)
  })
})
