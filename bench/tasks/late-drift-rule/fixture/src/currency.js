/**
 * Currency formatting.
 * @module
 */

/**
 * Format an amount with a three-letter currency code.
 * @param {number} amount - the amount; must be finite.
 * @param {string} currency - ISO-style code; exactly three characters.
 * @returns {string} the formatted amount, e.g. "USD 12.50".
 */
export function formatAmount(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError('amount is not valid for formatAmount')
  }
  if (typeof currency !== 'string' || currency.length !== 3) {
    throw new TypeError('currency is not valid for formatAmount')
  }
  return `${currency} ${amount.toFixed(2)}`
}
