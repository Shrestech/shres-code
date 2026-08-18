import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitIntoPages, pageNumbers } from '../src/pagination.js'

test('exact multiple fills every page', () => {
  assert.deepEqual(splitIntoPages([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
})

test('partial last page is kept', () => {
  assert.deepEqual(splitIntoPages([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('fewer items than page size still yields one page', () => {
  assert.deepEqual(splitIntoPages([1, 2], 10), [[1, 2]])
})

test('empty input yields no pages', () => {
  assert.deepEqual(splitIntoPages([], 3), [])
})

test('pageNumbers are one-based', () => {
  assert.deepEqual(pageNumbers([1, 2, 3, 4, 5], 2), [1, 2, 3])
})
