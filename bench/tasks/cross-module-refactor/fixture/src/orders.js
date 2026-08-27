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
 * Place an order after validation.
 * @param {{ orderId: string, customerEmail: string, items: string[] }} data
 * @returns {{ ok: boolean, order?: object, error?: string }}
 */
export function placeOrder(data) {
  if (!isValidId(data.orderId)) return { ok: false, error: 'invalid order id' }
  if (!isValidEmail(data.customerEmail)) return { ok: false, error: 'invalid email' }
  if (!Array.isArray(data.items) || data.items.length === 0) return { ok: false, error: 'no items' }
  return { ok: true, order: { orderId: data.orderId, customerEmail: data.customerEmail, items: data.items } }
}

/**
 * Cancel an order by ID.
 * @param {string} orderId
 * @returns {{ ok: boolean, error?: string }}
 */
export function cancelOrder(orderId) {
  if (!isValidId(orderId)) return { ok: false, error: 'invalid order id' }
  return { ok: true }
}
