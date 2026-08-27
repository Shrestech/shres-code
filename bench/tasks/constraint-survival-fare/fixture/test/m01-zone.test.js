import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { zoneForStop } from '../src/m01-zone.js'

describe('m01-zone', () => {
  it('maps known stops to zones', () => {
    assert.equal(zoneForStop('CEN'), 1)
    assert.equal(zoneForStop('UNI'), 1)
    assert.equal(zoneForStop('PAR'), 2)
    assert.equal(zoneForStop('RIV'), 2)
    assert.equal(zoneForStop('HBR'), 3)
    assert.equal(zoneForStop('AIR'), 4)
    assert.equal(zoneForStop('OAK'), 5)
    assert.equal(zoneForStop('BAY'), 6)
  })

  it('rejects an unknown stop', () => {
    assert.throws(() => zoneForStop('XXX'), /unknown stop/)
    assert.throws(() => zoneForStop('cen'), /unknown stop/)
  })

  it('rejects a non-string', () => {
    assert.throws(() => zoneForStop(1), /stop must be a string/)
  })
})
