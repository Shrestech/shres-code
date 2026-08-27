import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDiscount } from '../src/discount.js'

test('applyDiscount subtracts basis points', () => {
  assert.equal(applyDiscount(10000, 2500), 7500)
  assert.equal(applyDiscount(1000, 0), 1000)
  assert.equal(applyDiscount(199, 1000), 179)
})
