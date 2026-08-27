import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacySortByPrice, legacySortBySku } from '../src/m06-sort.js'

const rows = [
  { sku: 'CD', name: 'c', price: 2, qty: 1 },
  { sku: 'AB', name: 'a', price: 5, qty: 1 },
  { sku: 'EF', name: 'e', price: 2, qty: 1 },
]

describe('m06-sort', () => {
  it('sorts by sku without mutating input', () => {
    const snapshot = rows.slice()
    assert.deepEqual(legacySortBySku(rows).map(r => r.sku), ['AB', 'CD', 'EF'])
    assert.deepEqual(rows, snapshot)
  })

  it('sorts by price, breaking ties by sku', () => {
    assert.deepEqual(legacySortByPrice(rows).map(r => r.sku), ['CD', 'EF', 'AB'])
  })
})
