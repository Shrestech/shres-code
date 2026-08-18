/**
 * Create memoized inventory reports over a store. Category totals are cached
 * per category and recomputed only when the store revision has moved on.
 * @param {object} store - store from createStore().
 * @returns {object} reports with valueByCategory.
 */
export function createReports(store) {
  const cache = new Map()
  return {
    /**
     * Total stock value (price × quantity) of one category.
     * @param {string} category - category name.
     * @returns {number} total value; 0 for an unknown category.
     */
    valueByCategory(category) {
      const hit = cache.get(category)
      if (hit && hit.revision === store.revision()) return hit.value
      let value = 0
      for (const sku of store.listSkus()) {
        const record = store.getSku(sku)
        if (record.category === category) value += record.price * record.quantity
      }
      cache.set(category, { revision: store.revision(), value })
      return value
    },
  }
}
