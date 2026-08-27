import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invApplyReserve, invPlanReserve } from '../src/m05-reserve.js'

const lots = [
  { key: 'B', sku: 'AA', qty: 2 },
  { key: 'A', sku: 'AA', qty: 3 },
  { key: 'C', sku: 'BB', qty: 9 },
]

describe('m05-reserve', () => {
  it('plans a reserve walking matching lots by key', () => {
    assert.deepEqual(invPlanReserve(lots, 'AA', 4), [
      { key: 'A', take: 3 },
      { key: 'B', take: 1 },
    ])
  })

  it('rejects insufficient stock and non-positive need', () => {
    assert.throws(() => invPlanReserve(lots, 'AA', 6), /insufficient stock/)
    assert.throws(() => invPlanReserve(lots, 'AA', 0), /qty must be positive/)
  })

  it('applies a plan, dropping zero-qty lots, without mutating input', () => {
    const snapshot = lots.map(lot => ({ ...lot }))
    assert.deepEqual(invApplyReserve(lots, [{ key: 'A', take: 3 }]), [
      { key: 'B', sku: 'AA', qty: 2 },
      { key: 'C', sku: 'BB', qty: 9 },
    ])
    assert.deepEqual(lots, snapshot)
  })
})
