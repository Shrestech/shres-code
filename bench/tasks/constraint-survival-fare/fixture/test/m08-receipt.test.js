import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatReceipt } from '../src/m08-receipt.js'

const PRICED = {
  legs: [
    {
      from: 'CEN',
      to: 'PAR',
      fromZone: 1,
      toZone: 2,
      base: 340,
      discount: 0,
      surcharge: 0,
      fare: 340,
    },
    {
      from: 'PAR',
      to: 'AIR',
      fromZone: 2,
      toZone: 4,
      base: 430,
      discount: 180,
      surcharge: 0,
      fare: 250,
    },
  ],
  subtotal: 590,
  total: 590,
}

describe('m08-receipt', () => {
  it('formats legs, subtotal, and total as newline-joined lines', () => {
    assert.equal(
      formatReceipt(PRICED),
      [
        'CEN -> PAR  Z1-Z2  340',
        'PAR -> AIR  Z2-Z4  250',
        'SUBTOTAL  590',
        'TOTAL  590',
      ].join('\n'),
    )
  })

  it('rejects a null or incomplete priced object', () => {
    assert.throws(() => formatReceipt(null), /invalid receipt/)
    assert.throws(() => formatReceipt({ legs: PRICED.legs, subtotal: 590 }), /invalid receipt/)
    assert.throws(() => formatReceipt({ legs: [], subtotal: 0, total: 0 }), /invalid receipt/)
    assert.throws(
      () => formatReceipt({ legs: [{ from: 'CEN', to: 'PAR', fromZone: 1, toZone: 2 }], subtotal: 0, total: 0 }),
      /invalid receipt/,
    )
  })
})
