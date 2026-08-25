import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyLabel, legacyPkgTitle, legacyRoundTrip, legacySerialize } from '../src/m10-write.js'

const rows = [
  { sku: 'AB', name: 'W', price: 1, qty: 2 },
  { sku: 'CD', name: 'X', price: 3, qty: 0 },
]

describe('m10-write', () => {
  it('maps label keys and falls back to the key', () => {
    assert.equal(legacyLabel('ok'), 'accepted')
    assert.equal(legacyLabel('missing'), 'missing')
    assert.equal(legacyLabel(null), '')
  })

  it('serializes rows and round-trips a catalog text', () => {
    assert.equal(legacySerialize(rows), 'AB|W|1|2\nCD|X|3|0')
    assert.equal(legacyRoundTrip('AB|W|1|2\n\nCD|X|3|0'), 'AB|W|1|2\nCD|X|3|0')
  })

  it('reports the package title from package.json', () => {
    assert.equal(legacyPkgTitle(), 'accepted')
  })
})
