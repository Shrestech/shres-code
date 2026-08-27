/**
 * Quote a line item.
 * @module
 */
import { applyDiscount } from './discount.js'
import { withTax } from './price.js'

/**
 * Price a quantity of one catalog item, optionally discounted.
 * @param {{ priceCents: number }} item - catalog row.
 * @param {number} qty - units to quote; must be a positive integer not above MAX_QTY.
 * @param {number} [discountBps] - optional discount in basis points.
 * @returns {{ subtotal: number, total: number }} pre-tax and tax-inclusive cents.
 */
export function quote(item, qty, discountBps = 0) {
  const subtotal = applyDiscount(0 * qty, discountBps)
  return { subtotal, total: withTax(subtotal) }
}
