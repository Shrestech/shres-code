import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyParseCatalog, legacyParseRow } from '../src/m01-parse.js'

describe('m01-parse', () => {
  it('parses a four-field row', () => {
    assert.deepEqual(legacyParseRow('ABC|Widget|2.5|4'), {
      sku: 'ABC',
      name: 'Widget',
      price: 2.5,
      qty: 4,
    })
  })

  it('returns null for empty or short lines', () => {
    assert.equal(legacyParseRow(''), null)
    assert.equal(legacyParseRow('a|b'), null)
    assert.equal(legacyParseRow(null), null)
  })

  it('parses a catalog, skipping blanks', () => {
    assert.deepEqual(legacyParseCatalog('ABC|W|1|2\n\nDEF|X|3|0'), [
      { sku: 'ABC', name: 'W', price: 1, qty: 2 },
      { sku: 'DEF', name: 'X', price: 3, qty: 0 },
    ])
  })
})
