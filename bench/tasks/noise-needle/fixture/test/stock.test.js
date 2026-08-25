import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjust } from '../src/stock.js'

test('adjust applies a signed delta', () => {
  assert.equal(adjust(5, -3), 2)
  assert.equal(adjust(0, 4), 4)
})

test('adjust refuses a negative result', () => {
  assert.throws(() => adjust(5, -6), /stock cannot be negative/)
})
