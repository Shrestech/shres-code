/**
 * Simple in-memory route dispatcher.
 * @module
 */

const routes = {
  'GET /users': { status: 200, body: { users: ['alice', 'bob'] } },
  'GET /health': { status: 200, body: { ok: true } },
  'POST /users': { status: 201, body: { created: true } },
}

/**
 * Handle a request by matching method + path to known routes.
 * @param {string} method - HTTP method.
 * @param {string} path - Request path.
 * @returns {{ status: number, body: object }}
 */
export function handleRequest(method, path) {
  const key = `${method} ${path}`
  if (routes[key]) return routes[key]
  return { status: 404, body: { error: 'not found' } }
}
