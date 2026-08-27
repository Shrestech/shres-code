import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quote } from '../src/order.js'

test('quote multiplies price by qty then applies tax', () => {
  assert.deepEqual(quote({ priceCents: 1000 }, 2), { subtotal: 2000, total: 2160 })
})

test('quote applies a basis-point discount before tax', () => {
  assert.deepEqual(quote({ priceCents: 1000 }, 2, 1000), { subtotal: 1800, total: 1944 })
})

test('quote rejects qty above MAX_QTY', () => {
  assert.throws(() => quote({ priceCents: 1000 }, 101), /qty exceeds MAX_QTY/)
})

test('quote rejects a non-positive qty', () => {
  assert.throws(() => quote({ priceCents: 1000 }, 0), /qty must be a positive integer/)
})
