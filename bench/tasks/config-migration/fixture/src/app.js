import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const config = require('../config.json', { with: { type: 'json' } })

/**
 * Return the application display name.
 * @returns {string}
 */
export function appName() {
  return config.app_name
}

/**
 * Return the configured listen port.
 * @returns {number}
 */
export function listenPort() {
  return config.app_port
}
