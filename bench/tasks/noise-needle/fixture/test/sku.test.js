import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSku } from '../src/sku.js'

test('normalizeSku trims, uppercases, and replaces runs of whitespace', () => {
  assert.equal(normalizeSku('  abc def '), 'ABC-DEF')
  assert.equal(normalizeSku('ok'), 'OK')
  assert.equal(normalizeSku('\tfoo   bar\n'), 'FOO-BAR')
})
