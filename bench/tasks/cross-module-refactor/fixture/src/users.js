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
 * Create a user record after validation.
 * @param {{ id: string, email: string, name: string }} data
 * @returns {{ ok: boolean, user?: object, error?: string }}
 */
export function createUser(data) {
  if (!isValidId(data.id)) return { ok: false, error: 'invalid id' }
  if (!isValidEmail(data.email)) return { ok: false, error: 'invalid email' }
  return { ok: true, user: { id: data.id, email: data.email, name: data.name } }
}

/**
 * Update a user's email after validation.
 * @param {string} id
 * @param {string} newEmail
 * @returns {{ ok: boolean, error?: string }}
 */
export function updateEmail(id, newEmail) {
  if (!isValidId(id)) return { ok: false, error: 'invalid id' }
  if (!isValidEmail(newEmail)) return { ok: false, error: 'invalid email' }
  return { ok: true }
}
