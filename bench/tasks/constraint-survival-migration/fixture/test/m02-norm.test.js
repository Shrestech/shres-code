import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyNormName, legacyNormSku } from '../src/m02-norm.js'

describe('m02-norm', () => {
  it('normalizes skus to trimmed uppercase', () => {
    assert.equal(legacyNormSku(' ab-1 '), 'AB-1')
    assert.equal(legacyNormSku(null), '')
  })

  it('collapses name whitespace', () => {
    assert.equal(legacyNormName('  red   box  '), 'red box')
    assert.equal(legacyNormName(null), '')
  })
})
