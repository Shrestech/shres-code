/**
 * Report generation with date-range filtering.
 * @module
 */

/**
 * Parse a YYYY-MM-DD date string into components.
 * @param {string} str - date string.
 * @returns {{ year: number, month: number, day: number }}
 */
function parseDate(str) {
  const [y, m, d] = str.split('-')
  return { year: Number(y), month: Number(m), day: Number(d) }
}

/**
 * Generate a report header with a date range.
 * @param {string} fromStr - YYYY-MM-DD
 * @param {string} toStr - YYYY-MM-DD
 * @returns {{ from: { year: number, month: number, day: number }, to: { year: number, month: number, day: number }, generated: boolean }}
 */
export function reportHeader(fromStr, toStr) {
  return { from: parseDate(fromStr), to: parseDate(toStr), generated: true }
}

/**
 * Check if a date string falls within a month.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} month - 1-12
 * @returns {boolean}
 */
export function isInMonth(dateStr, month) {
  return parseDate(dateStr).month === month
}
