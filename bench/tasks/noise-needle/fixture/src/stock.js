/**
 * On-hand quantity adjustments.
 * @module
 */

/**
 * Apply a signed delta to an on-hand count.
 * @param {number} current - units currently on hand.
 * @param {number} delta - units to add (negative to remove).
 * @returns {number} resulting on-hand count.
 */
export function adjust(current, delta) {
  return current + delta
}
