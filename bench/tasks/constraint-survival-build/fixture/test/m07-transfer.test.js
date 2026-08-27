import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invApplyTransfer, invMakeTransfer } from '../src/m07-transfer.js'

describe('m07-transfer', () => {
  it('builds a transfer record', () => {
    assert.deepEqual(invMakeTransfer('AA', 'N1', 'N2', 3), {
      sku: 'AA',
      fromBin: 'N1',
      toBin: 'N2',
      qty: 3,
    })
  })

  it('rejects a same-bin or non-positive transfer', () => {
    assert.throws(() => invMakeTransfer('AA', 'N1', 'N1', 3), /distinct bins/)
    assert.throws(() => invMakeTransfer('AA', 'N1', 'N2', 0), /qty must be positive/)
  })

  it('applies a transfer without mutating the bin map', () => {
    const bins = { N1: { AA: 5 }, N2: { AA: 1 } }
    assert.deepEqual(invApplyTransfer(bins, { sku: 'AA', fromBin: 'N1', toBin: 'N2', qty: 3 }), {
      N1: { AA: 2 },
      N2: { AA: 4 },
    })
    assert.deepEqual(bins, { N1: { AA: 5 }, N2: { AA: 1 } })
  })

  it('rejects a transfer that overdraws the source', () => {
    assert.throws(
      () => invApplyTransfer({ N1: { AA: 1 } }, { sku: 'AA', fromBin: 'N1', toBin: 'N2', qty: 3 }),
      /insufficient stock/,
    )
  })
})
