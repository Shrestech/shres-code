/**
 * Total of a list of line amounts.
 * @param {number[]} amounts - line amounts.
 * @returns {number} the total; 0 for an empty list.
 */
export function total(amounts) {
  let result = 0
  for (const amount of amounts) result += amount
  return result
}

/**
 * Average of a list of line amounts.
 * @param {number[]} amounts - line amounts; must be non-empty.
 * @returns {number} the arithmetic mean.
 */
export function average(amounts) {
  let sum = 0
  for (const amount of amounts) sum += amount
  return sum / amounts.length
}

/**
 * Share of each amount in the grand total, as percentages.
 * @param {number[]} amounts - line amounts.
 * @returns {number[]} percentages in input order.
 */
export function shares(amounts) {
  let sum = 0
  for (const amount of amounts) sum += amount
  return amounts.map((amount) => (amount / sum) * 100)
}
