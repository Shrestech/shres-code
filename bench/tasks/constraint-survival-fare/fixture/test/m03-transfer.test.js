import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { transferDiscount } from '../src/m03-transfer.js'

describe('m03-transfer', () => {
  it('caps a continuing-zone transfer at half the next base fare', () => {
    assert.equal(
      transferDiscount({ fromZone: 1, toZone: 2 }, { fromZone: 2, toZone: 4 }),
      180,
    )
  })

  it('gives a quarter-fare discount for an adjacent-zone transfer', () => {
    assert.equal(
      transferDiscount({ fromZone: 1, toZone: 2 }, { fromZone: 3, toZone: 4 }),
      85,
    )
  })

  it('gives no discount when the gap is larger than one zone', () => {
    assert.equal(
      transferDiscount({ fromZone: 1, toZone: 2 }, { fromZone: 5, toZone: 6 }),
      0,
    )
  })

  it('rejects a null or non-object leg', () => {
    assert.throws(() => transferDiscount(null, { fromZone: 1, toZone: 2 }), /invalid transfer/)
    assert.throws(() => transferDiscount({ fromZone: 1, toZone: 2 }, 'x'), /invalid transfer/)
    assert.throws(
      () => transferDiscount({ fromZone: 1 }, { fromZone: 1, toZone: 2 }),
      /invalid transfer/,
    )
  })
})
