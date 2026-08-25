/**
 * Event record creation and date handling.
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
 * Create an event record.
 * @param {string} title
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {{ title: string, date: { year: number, month: number, day: number } }}
 */
export function createEvent(title, dateStr) {
  return { title, date: parseDate(dateStr) }
}

/**
 * Check if an event falls on a given year.
 * @param {{ date: { year: number }}} event
 * @param {number} year
 * @returns {boolean}
 */
export function isInYear(event, year) {
  return event.date.year === year
}
