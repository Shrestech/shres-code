import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const config = require('../config.json', { with: { type: 'json' } })

/**
 * Build a connection string from the flat config.
 * @returns {string} postgres connection URI.
 */
export function connectionString() {
  return `postgres://${config.db_host}:${config.db_port}/${config.db_name}`
}

/**
 * Return the configured database port.
 * @returns {number}
 */
export function dbPort() {
  return config.db_port
}
