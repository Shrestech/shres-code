/**
 * Format a user's full name.
 * @param {string} first
 * @param {string} last
 * @returns {string}
 */
export function fullName(first, last) {
  console.log('formatting name for', first, last)
  return `${first} ${last}`
}

/**
 * Generate initials from a full name.
 * @param {string} first
 * @param {string} last
 * @returns {string}
 */
export function initials(first, last) {
  console.log('initials called')
  return `${first[0].toUpperCase()}${last[0].toUpperCase()}`
}
