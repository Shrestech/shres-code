import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyAssertRow, legacyIsValidRow } from '../src/m03-valid.js'

describe('m03-valid', () => {
  it('accepts a known prefix with a positive price', () => {
    assert.equal(legacyIsValidRow({ sku: 'AB-1', price: 1, qty: 0 }), true)
    assert.equal(legacyIsValidRow({ sku: 'CD-9', price: 2, qty: 4 }), true)
  })

  it('rejects unknown prefixes and non-positive prices', () => {
    assert.equal(legacyIsValidRow({ sku: 'ZZ-1', price: 1, qty: 0 }), false)
    assert.equal(legacyIsValidRow({ sku: 'AB-1', price: 0, qty: 1 }), false)
    assert.equal(legacyIsValidRow(null), false)
  })

  it('assert throws on an invalid row', () => {
    assert.throws(() => legacyAssertRow({ sku: 'ZZ-1', price: 1, qty: 0 }), /invalid row/)
    assert.deepEqual(legacyAssertRow({ sku: 'EF-2', price: 3, qty: 1 }), {
      sku: 'EF-2',
      price: 3,
      qty: 1,
    })
  })
})
