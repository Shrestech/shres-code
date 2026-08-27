import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyMerge, legacyUnionSkus } from '../src/m07-merge.js'

const left = [
  { sku: 'ab-1', name: 'old', price: 1, qty: 1 },
  { sku: 'cd-1', name: 'c', price: 2, qty: 1 },
]
const right = [
  { sku: 'AB-1', name: 'new', price: 9, qty: 4 },
  { sku: 'ef-1', name: 'e', price: 3, qty: 1 },
]

describe('m07-merge', () => {
  it('merges by normalized sku, right side wins, keys sorted', () => {
    assert.deepEqual(legacyMerge(left, right), [
      { sku: 'AB-1', name: 'new', price: 9, qty: 4 },
      { sku: 'cd-1', name: 'c', price: 2, qty: 1 },
      { sku: 'ef-1', name: 'e', price: 3, qty: 1 },
    ])
  })

  it('unions normalized skus', () => {
    assert.deepEqual(legacyUnionSkus(left, right), ['AB-1', 'CD-1', 'EF-1'])
  })
})
