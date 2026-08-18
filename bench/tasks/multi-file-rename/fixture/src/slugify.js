/**
 * Convert free text into a URL slug.
 * @param {string} text - raw title text.
 * @returns {string} lowercase slug with dashes.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Check whether a string is already a valid slug.
 * @param {string} slug - candidate slug.
 * @returns {boolean} true when the slug needs no changes.
 */
export function isValidSlug(slug) {
  return slugify(slug) === slug && slug.length > 0
}
