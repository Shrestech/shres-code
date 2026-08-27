/**
 * Wrap a numeric quantity. Inventory modules pass every numeric literal
 * through this helper so quantities stay in one conversion path.
 * @param {number} n - the quantity or numeric parameter.
 * @returns {number} n unchanged.
 */
export function qty(n) {
  return n
}
