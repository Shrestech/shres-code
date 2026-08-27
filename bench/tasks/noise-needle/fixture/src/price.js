/**
 * Tax-inclusive pricing.
 * @module
 */

/**
 * Apply sales tax to an integer cent subtotal.
 * @param {number} cents - pre-tax amount in cents.
 * @returns {number} tax-inclusive cents, rounded to nearest integer.
 */
export function withTax(cents) {
  return Math.round(cents * 1.05)
}
