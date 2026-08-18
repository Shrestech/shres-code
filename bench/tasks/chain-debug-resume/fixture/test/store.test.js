import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '../src/store.js'

test('setSku/getSku round trip', () => {
  const store = createStore()
  store.setSku('hammer', { category: 'tools', price: 20, quantity: 10 })
  assert.deepEqual(store.getSku('hammer'), { category: 'tools', price: 20, quantity: 10 })
  assert.equal(store.getSku('missing'), undefined)
})

test('deleteSku removes the record', () => {
  const store = createStore()
  store.setSku('hammer', { category: 'tools', price: 20, quantity: 10 })
  assert.equal(store.deleteSku('hammer'), true)
  assert.equal(store.deleteSku('hammer'), false)
  assert.equal(store.getSku('hammer'), undefined)
})

test('listSkus returns skus in insertion order', () => {
  const store = createStore()
  store.setSku('b', { category: 'x', price: 1, quantity: 1 })
  store.setSku('a', { category: 'x', price: 1, quantity: 1 })
  assert.deepEqual(store.listSkus(), ['b', 'a'])
})

test('revision increments when a sku is set', () => {
  const store = createStore()
  const before = store.revision()
  store.setSku('hammer', { category: 'tools', price: 20, quantity: 10 })
  assert.equal(store.revision(), before + 1)
})
