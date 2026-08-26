import { ORIGIN_STATION } from './origin.js'

/**
 * Format a shipping quote label.
 * @param {string} orderId - caller-supplied order id.
 * @returns {string} `<origin>:<orderId>`.
 */
export function formatLabel(orderId) {
  return `${ORIGIN_STATION}:${orderId}`
}
