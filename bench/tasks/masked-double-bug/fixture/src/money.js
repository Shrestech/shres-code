/**
 * Round an amount to whole cents, half up.
 * @param {number} amount - amount to round.
 * @returns {number} amount rounded to two decimal places.
 */
export function round2(amount) {
  return Math.round(amount * 100) / 100
}

/**
 * Total for one cart line: the discounted unit price times the quantity,
 * rounded to cents.
 * @param {number} unitPrice - price of one unit.
 * @param {number} quantity - units purchased.
 * @param {number} [discountRate] - fraction taken off the unit price, 0–1.
 * @returns {number} line total, cent-rounded.
 */
export function lineTotal(unitPrice, quantity, discountRate = 0) {
  const discounted = round2(unitPrice * (1 - discountRate))
  return round2(discounted * quantity)
}
