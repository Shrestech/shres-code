import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invApplyAdjust, invMakeAdjust } from '../src/m06-adjust.js'

describe('m06-adjust', () => {
  it('classifies credit and debit adjustments', () => {
    assert.deepEqual(invMakeAdjust('AA', 3, 'recv'), {
      sku: 'AA',
      delta: 3,
      reason: 'recv',
      kind: 'credit',
    })
    assert.deepEqual(invMakeAdjust('AA', -2, 'brk'), {
      sku: 'AA',
      delta: -2,
      reason: 'brk',
      kind: 'debit',
    })
  })

  it('rejects a zero delta', () => {
    assert.throws(() => invMakeAdjust('AA', 0, 'x'), /delta must be nonzero/)
  })

  it('applies an adjust to an on-hand map without mutation', () => {
    const onHand = { AA: 5 }
    assert.deepEqual(invApplyAdjust(onHand, { sku: 'AA', delta: 2 }), { AA: 7 })
    assert.deepEqual(invApplyAdjust(onHand, { sku: 'AA', delta: -5 }), { AA: 0 })
    assert.deepEqual(onHand, { AA: 5 })
  })

  it('rejects an adjust that would go negative', () => {
    assert.throws(() => invApplyAdjust({ AA: 5 }, { sku: 'AA', delta: -6 }), /negative qty/)
  })
})
