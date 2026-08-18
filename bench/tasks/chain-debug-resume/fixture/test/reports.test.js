import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '../src/store.js'
import { createReports } from '../src/reports.js'

/**
 * Store with two tools (hammer 20×10, drill 50×2) and one garden sku.
 * @returns {object} seeded store.
 */
function seed() {
  const store = createStore()
  store.setSku('hammer', { category: 'tools', price: 20, quantity: 10 })
  store.setSku('drill', { category: 'tools', price: 50, quantity: 2 })
  store.setSku('roses', { category: 'garden', price: 5, quantity: 12 })
  return store
}

test('valueByCategory sums price times quantity per category', () => {
  const reports = createReports(seed())
  assert.equal(reports.valueByCategory('tools'), 300)
  assert.equal(reports.valueByCategory('garden'), 60)
  assert.equal(reports.valueByCategory('unknown'), 0)
})

test('total recomputed after a sku is added', () => {
  const store = seed()
  const reports = createReports(store)
  assert.equal(reports.valueByCategory('tools'), 300)
  store.setSku('saw', { category: 'tools', price: 30, quantity: 1 })
  assert.equal(reports.valueByCategory('tools'), 330)
})

test('total recomputed after a sku is replaced', () => {
  const store = seed()
  const reports = createReports(store)
  assert.equal(reports.valueByCategory('tools'), 300)
  store.setSku('hammer', { category: 'tools', price: 25, quantity: 10 })
  assert.equal(reports.valueByCategory('tools'), 350)
})

test('total recomputed after a sku is removed', () => {
  const store = seed()
  const reports = createReports(store)
  assert.equal(reports.valueByCategory('tools'), 300)
  store.deleteSku('hammer')
  assert.equal(reports.valueByCategory('tools'), 100)
})
