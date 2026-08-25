import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addItem, findBySku } from '../src/catalog.js'

test('findBySku looks up the sku, not the internal id', () => {
  const item = { sku: 'WIDGET', id: '1', priceCents: 1000 }
  addItem(item)
  assert.deepEqual(findBySku('WIDGET'), item)
  assert.equal(findBySku('1'), undefined)
})
