import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineTotal, round2 } from '../src/money.js'
import { cartTotal } from '../src/cart.js'

test('round2 rounds to whole cents', () => {
  assert.equal(round2(1.234), 1.23)
  assert.equal(round2(2.5), 2.5)
})

test('lineTotal multiplies the unit price by the quantity', () => {
  assert.equal(lineTotal(2.5, 4, 0), 10)
})

test('lineTotal rounds the discounted line total to cents', () => {
  assert.equal(lineTotal(0.12, 3, 0.05), 0.34)
})

test('cartTotal adds sales tax to the subtotal', () => {
  assert.equal(cartTotal([{ unitPrice: 2, quantity: 2 }]), 4.4)
})

test('cartTotal taxes the discounted subtotal', () => {
  assert.equal(cartTotal([{ unitPrice: 0.12, quantity: 3, discountRate: 0.05 }]), 0.37)
})

test('cartTotal totals a mixed cart with a discounted line', () => {
  const items = [
    { unitPrice: 0.14, quantity: 4, discountRate: 0.05 },
    { unitPrice: 1, quantity: 1 },
  ]
  assert.equal(cartTotal(items), 1.68)
})

test('cartTotal sums lines without discounts', () => {
  const items = [
    { unitPrice: 1.5, quantity: 2 },
    { unitPrice: 0.5, quantity: 3, discountRate: 0 },
  ]
  assert.equal(cartTotal(items), 4.95)
})

test('cartTotal of an empty cart is zero', () => {
  assert.equal(cartTotal([]), 0)
})
