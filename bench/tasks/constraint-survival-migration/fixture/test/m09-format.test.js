import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { legacyFormatIndexed, legacyFormatRow, legacyFormatTable } from '../src/m09-format.js'

const rows = [
  { sku: 'AB', name: 'W', price: 1, qty: 2 },
  { sku: 'CD', name: 'X', price: 3, qty: 0 },
]

describe('m09-format', () => {
  it('formats a row and a table', () => {
    assert.equal(legacyFormatRow(rows[0]), 'AB|W|1|2')
    assert.equal(legacyFormatTable(rows), 'AB|W|1|2\nCD|X|3|0')
  })

  it('formats an indexed row under a row/ prefix', () => {
    assert.equal(legacyFormatIndexed(rows, 'AB'), join('row', 'AB|W|1|2'))
    assert.equal(legacyFormatIndexed(rows, 'ZZ'), '')
  })
})
