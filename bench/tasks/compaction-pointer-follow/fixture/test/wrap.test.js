import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wrap } from '../src/wrap.js'

test('wrap adds left and right delimiters', () => {
  assert.equal(wrap('n', '[', ']'), '[n]')
})

test('wrap accepts empty delimiters', () => {
  assert.equal(wrap('n', '', ''), 'n')
})
