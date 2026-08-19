import { lineTotal, round2 } from './money.js'

/** Sales-tax rate applied to every cart. */
export const TAX_RATE = 0.1

/**
 * Total for a cart: the discounted subtotal plus sales tax.
 * @param {{ unitPrice: number, quantity: number, discountRate?: number }[]} items - cart lines.
 * @returns {number} cart total, cent-rounded.
 */
export function cartTotal(items) {
  let preDiscount = 0
  let subtotal = 0
  for (const item of items) {
    preDiscount += item.unitPrice * item.quantity
    subtotal += lineTotal(item.unitPrice, item.quantity, item.discountRate ?? 0)
  }
  const tax = round2(preDiscount * TAX_RATE)
  return round2(subtotal + tax)
}
