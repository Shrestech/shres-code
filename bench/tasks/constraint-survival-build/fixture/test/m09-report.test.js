import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invAgingBuckets, invLowStock, invValuation } from '../src/m09-report.js'

const lots = [
  { sku: 'AA', qty: 2, receivedDay: 10 },
  { sku: 'AA', qty: 1, receivedDay: 20 },
  { sku: 'BB', qty: 8, receivedDay: 1 },
]

describe('m09-report', () => {
  it('lists skus whose on-hand is below the threshold, sorted', () => {
    assert.deepEqual(invLowStock(lots, 4), ['AA'])
    assert.deepEqual(invLowStock(lots, 1), [])
  })

  it('values lots against a price map', () => {
    assert.equal(invValuation(lots, { AA: 5, BB: 2 }), 31)
  })

  it('buckets lots by age given nowDay and ascending edges', () => {
    assert.deepEqual(invAgingBuckets(lots, 25, [7, 20]), [1, 1, 1])
  })

  it('rejects a non-array lots argument', () => {
    assert.throws(() => invLowStock(null, 4), /lots must be an array/)
  })
})
