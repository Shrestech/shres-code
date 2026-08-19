import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatAmount } from '../src/currency.js'

test('formatAmount renders the code and two decimals', () => {
  assert.equal(formatAmount(12.5, 'USD'), 'USD 12.50')
  assert.equal(formatAmount(0, 'eur'), 'eur 0.00')
})

test('formatAmount rejects invalid arguments', () => {
  assert.throws(() => formatAmount('5', 'USD'), /amount is not valid for formatAmount/)
  assert.throws(() => formatAmount(5, 'US'), /currency is not valid for formatAmount/)
})
