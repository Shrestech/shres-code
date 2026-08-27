import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invIsValidSku, invNormalizeSku, invSkuParts } from '../src/m01-sku.js'

describe('m01-sku', () => {
  it('normalizes case, spaces, and underscores', () => {
    assert.equal(invNormalizeSku('  ab_c  '), 'AB-C')
  })

  it('collapses repeated separators', () => {
    assert.equal(invNormalizeSku('ab--c__d'), 'AB-C-D')
  })

  it('rejects a non-string', () => {
    assert.throws(() => invNormalizeSku(1), /sku must be a string/)
  })

  it('validates length and charset after normalize', () => {
    assert.equal(invIsValidSku('AB'), false)
    assert.equal(invIsValidSku('ABC'), true)
    assert.equal(invIsValidSku('ABCDEFGHIJKLMNOPQ'), false)
    assert.equal(invIsValidSku('AB-C1'), true)
    assert.equal(invIsValidSku('AB-c1'), true)
  })

  it('splits normalized parts', () => {
    assert.deepEqual(invSkuParts('ab-c-1'), ['AB', 'C', '1'])
  })

  it('throws on an invalid sku for parts', () => {
    assert.throws(() => invSkuParts('x'), /invalid sku/)
  })
})
