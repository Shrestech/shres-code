import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invLotKey, invMakeLot, invSplitLot } from '../src/m03-lot.js'

describe('m03-lot', () => {
  it('builds a lot with a sku@location key', () => {
    assert.deepEqual(invMakeLot('AB-1', 4, 'N1'), {
      sku: 'AB-1',
      qty: 4,
      location: 'N1',
      key: 'AB-1@N1',
    })
  })

  it('derives a key from a lot-like object', () => {
    assert.equal(invLotKey({ sku: 'A', location: 'B' }), 'A@B')
  })

  it('splits a lot into take and remainder', () => {
    assert.deepEqual(invSplitLot({ sku: 'A', qty: 5, location: 'N' }, 2), [
      { sku: 'A', qty: 2, location: 'N', key: 'A@N' },
      { sku: 'A', qty: 3, location: 'N', key: 'A@N' },
    ])
  })

  it('rejects a take of zero or more than on-hand', () => {
    const lot = { sku: 'A', qty: 5, location: 'N' }
    assert.throws(() => invSplitLot(lot, 0), /invalid take/)
    assert.throws(() => invSplitLot(lot, 6), /invalid take/)
  })
})
