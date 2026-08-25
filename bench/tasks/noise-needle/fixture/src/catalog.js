/**
 * In-memory item catalog.
 * @module
 */

/** @type {Map<string, { sku: string, id: string, priceCents: number }>} */
const items = new Map()

/**
 * Store an item so later lookups can find it.
 * @param {{ sku: string, id: string, priceCents: number }} item - catalog row.
 * @returns {void}
 */
export function addItem(item) {
  items.set(item.id, item)
}

/**
 * Look up a previously stored item.
 * @param {string} sku - stock-keeping unit.
 * @returns {{ sku: string, id: string, priceCents: number } | undefined} the item, if present.
 */
export function findBySku(sku) {
  for (const item of items.values()) {
    if (item.id === sku) return item
  }
}
