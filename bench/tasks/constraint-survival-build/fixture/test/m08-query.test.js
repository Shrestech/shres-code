import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invByBin, invEmptyBins, invFindSku, invOnHand } from '../src/m08-query.js'

const lots = [
  { sku: 'AA-1', qty: 2, bin: 'N1' },
  { sku: 'AA-2', qty: 3, bin: 'N2' },
  { sku: 'BB-1', qty: 1, bin: 'N1' },
]

describe('m08-query', () => {
  it('sums on-hand for a sku', () => {
    assert.equal(invOnHand(lots, 'AA-1'), 2)
    assert.equal(invOnHand(lots, 'ZZ'), 0)
  })

  it('lists lots in a bin in input order', () => {
    assert.deepEqual(invByBin(lots, 'N1'), [
      { sku: 'AA-1', qty: 2, bin: 'N1' },
      { sku: 'BB-1', qty: 1, bin: 'N1' },
    ])
  })

  it('finds skus by prefix, sorted', () => {
    assert.deepEqual(invFindSku(lots, 'AA'), [
      { sku: 'AA-1', qty: 2, bin: 'N1' },
      { sku: 'AA-2', qty: 3, bin: 'N2' },
    ])
  })

  it('lists known bins that hold no lots', () => {
    assert.deepEqual(invEmptyBins(lots, ['N1', 'N2', 'N3']), ['N3'])
  })

  it('rejects a non-array lots argument', () => {
    assert.throws(() => invOnHand(null, 'AA-1'), /lots must be an array/)
  })
})
