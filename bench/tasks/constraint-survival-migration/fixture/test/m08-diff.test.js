import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyAdded, legacyParseNamed, legacyRemoved, legacySourceName } from '../src/m08-diff.js'

const before = [
  { sku: 'AA', name: 'a', price: 1, qty: 1 },
  { sku: 'BB', name: 'b', price: 2, qty: 1 },
]
const after = [
  { sku: 'BB', name: 'b', price: 2, qty: 1 },
  { sku: 'CC', name: 'c', price: 3, qty: 1 },
]

describe('m08-diff', () => {
  it('names a source file without its .txt suffix', () => {
    assert.equal(legacySourceName('/tmp/feed.txt'), 'feed')
  })

  it('lists added and removed rows by sku', () => {
    assert.deepEqual(legacyAdded(before, after), [{ sku: 'CC', name: 'c', price: 3, qty: 1 }])
    assert.deepEqual(legacyRemoved(before, after), [{ sku: 'AA', name: 'a', price: 1, qty: 1 }])
  })

  it('parses a named row', () => {
    assert.deepEqual(legacyParseNamed('/data/east.txt', 'AB|W|1|2'), {
      sku: 'AB',
      name: 'W',
      price: 1,
      qty: 2,
      source: 'east',
    })
  })
})
