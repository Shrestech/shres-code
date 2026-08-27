import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stamp } from '../src/stamp.js'

test('stamp prefixes a body', () => {
  assert.equal(stamp('Q', '12'), 'Q:12')
})

test('stamp accepts empty parts', () => {
  assert.equal(stamp('', 'x'), ':x')
  assert.equal(stamp('x', ''), 'x:')
})
