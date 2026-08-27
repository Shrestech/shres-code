import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyBuildIndex, legacyLookup } from '../src/m04-index.js'

const rows = [
  { sku: 'AA', name: 'a', price: 1, qty: 2 },
  { sku: 'BB', name: 'b', price: 3, qty: 0 },
]

describe('m04-index', () => {
  it('indexes rows by sku, last write wins', () => {
    const extra = [...rows, { sku: 'AA', name: 'a2', price: 9, qty: 1 }]
    assert.deepEqual(legacyBuildIndex(extra).AA, { sku: 'AA', name: 'a2', price: 9, qty: 1 })
  })

  it('looks up a sku or returns null', () => {
    const index = legacyBuildIndex(rows)
    assert.deepEqual(legacyLookup(index, 'BB'), { sku: 'BB', name: 'b', price: 3, qty: 0 })
    assert.equal(legacyLookup(index, 'ZZ'), null)
    assert.equal(legacyLookup(index, null), null)
  })
})
