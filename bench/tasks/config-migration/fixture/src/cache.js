import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const config = require('../config.json', { with: { type: 'json' } })

/**
 * Return the configured TTL for cache entries.
 * @returns {number} seconds.
 */
export function ttl() {
  return config.cache_ttl
}

/**
 * Return the maximum number of cache entries.
 * @returns {number}
 */
export function maxSize() {
  return config.cache_max_size
}
