import assert from 'node:assert/strict'
import { test } from 'node:test'
import { total, average, shares } from '../src/calc.js'

test('total adds line amounts', () => {
  assert.equal(total([1, 2, 3]), 6)
  assert.equal(total([]), 0)
})

test('average divides by count', () => {
  assert.equal(average([2, 4, 6]), 4)
})

test('shares are percentages of the total', () => {
  assert.deepEqual(shares([1, 3]), [25, 75])
})
