import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyFilterByPrefix, legacyFilterInStock, legacyParseAndFilter } from '../src/m05-filter.js'

const rows = [
  { sku: 'AB-1', name: 'a', price: 1, qty: 2 },
  { sku: 'CD-1', name: 'c', price: 2, qty: 0 },
  { sku: 'AB-2', name: 'b', price: 3, qty: 1 },
]

describe('m05-filter', () => {
  it('filters by sku prefix', () => {
    assert.deepEqual(legacyFilterByPrefix(rows, 'AB'), [rows[0], rows[2]])
  })

  it('filters to in-stock rows', () => {
    assert.deepEqual(legacyFilterInStock(rows), [rows[0], rows[2]])
  })

  it('parses a line and keeps it only on prefix match', () => {
    assert.deepEqual(legacyParseAndFilter('AB-1|W|1|2', 'AB'), {
      sku: 'AB-1',
      name: 'W',
      price: 1,
      qty: 2,
    })
    assert.equal(legacyParseAndFilter('CD-1|W|1|2', 'AB'), null)
    assert.equal(legacyParseAndFilter('', 'AB'), null)
  })
})
