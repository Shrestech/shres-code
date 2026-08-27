/**
 * Check whether a string looks like a valid email.
 * @param {string} str
 * @returns {boolean}
 */
function isValidEmail(str) {
  return typeof str === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
}

/**
 * Check whether a string is a valid entity ID (alphanumeric, 4-20 chars).
 * @param {string} str
 * @returns {boolean}
 */
function isValidId(str) {
  return typeof str === 'string' && /^[a-zA-Z0-9]{4,20}$/.test(str)
}

/**
 * Register a product after validation.
 * @param {{ productId: string, vendorEmail: string, title: string }} data
 * @returns {{ ok: boolean, product?: object, error?: string }}
 */
export function registerProduct(data) {
  if (!isValidId(data.productId)) return { ok: false, error: 'invalid product id' }
  if (!isValidEmail(data.vendorEmail)) return { ok: false, error: 'invalid vendor email' }
  return { ok: true, product: { productId: data.productId, vendorEmail: data.vendorEmail, title: data.title } }
}

/**
 * Look up a product by ID.
 * @param {string} productId
 * @returns {{ ok: boolean, error?: string }}
 */
export function lookupProduct(productId) {
  if (!isValidId(productId)) return { ok: false, error: 'invalid product id' }
  return { ok: true }
}
