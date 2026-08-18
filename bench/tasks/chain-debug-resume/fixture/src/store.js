/**
 * Create an in-memory product store. The store carries a revision counter
 * that increments on every mutation; derived views compare revisions to
 * invalidate memoized computations.
 * @returns {object} store with setSku/getSku/deleteSku/listSkus/revision.
 */
export function createStore() {
  const records = new Map()
  let revision = 0
  return {
    /**
     * Add or replace a SKU record.
     * @param {string} sku - stock-keeping unit id.
     * @param {{ category: string, price: number, quantity: number }} record - product record.
     * @returns {void}
     */
    setSku(sku, record) {
      records.set(sku, record)
      revision += 1
    },

    /**
     * Look up a SKU record.
     * @param {string} sku - stock-keeping unit id.
     * @returns {{ category: string, price: number, quantity: number } | undefined} the record, if present.
     */
    getSku(sku) {
      return records.get(sku)
    },

    /**
     * Remove a SKU record.
     * @param {string} sku - stock-keeping unit id.
     * @returns {boolean} true when the record existed.
     */
    deleteSku(sku) {
      if (!records.has(sku)) return false
      records.delete(sku)
      return true
    },

    /**
     * List every SKU in insertion order.
     * @returns {string[]} sku ids.
     */
    listSkus() {
      return [...records.keys()]
    },

    /**
     * Current mutation counter; changes whenever the store changes.
     * @returns {number} revision number.
     */
    revision() {
      return revision
    },
  }
}
