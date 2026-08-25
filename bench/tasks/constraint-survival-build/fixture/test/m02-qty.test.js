import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invAddQty, invClampQty, invParseQty, invSubQty } from '../src/m02-qty.js'

describe('m02-qty', () => {
  it('parses numbers and numeric strings, flooring fractions', () => {
    assert.equal(invParseQty(4), 4)
    assert.equal(invParseQty('7'), 7)
    assert.equal(invParseQty(3.9), 3)
  })

  it('rejects negatives and non-numeric input', () => {
    assert.throws(() => invParseQty(-1), /invalid qty/)
    assert.throws(() => invParseQty('x'), /invalid qty/)
  })

  it('clamps to the inclusive range', () => {
    assert.equal(invClampQty(5, 1, 4), 4)
    assert.equal(invClampQty(0, 1, 4), 1)
    assert.equal(invClampQty(2, 1, 4), 2)
  })

  it('adds and subtracts quantities', () => {
    assert.equal(invAddQty(2, 3), 5)
    assert.equal(invSubQty(5, 2), 3)
  })

  it('rejects a subtract that would go negative', () => {
    assert.throws(() => invSubQty(2, 5), /negative qty/)
  })
})
