import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TAX_RATE } from '../src/constants.js'
import { withTax } from '../src/price.js'

test('withTax uses TAX_RATE from constants', () => {
  assert.equal(TAX_RATE, 0.08)
  assert.equal(withTax(1000), 1080)
  assert.equal(withTax(0), 0)
  assert.equal(withTax(333), 360)
})
