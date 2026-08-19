import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transformLines } from '../src/transform.js'

test('the first line is a header and is skipped', () => {
  assert.deepEqual(transformLines(['name,qty', 'apple,3']), ['["apple","3"]'])
})

test('records are split on commas', () => {
  assert.deepEqual(transformLines(['name,qty,note', 'pear,2,ripe']), ['["pear","2","ripe"]'])
})

test('double quotes are literal characters', () => {
  assert.deepEqual(transformLines(['h', '"a",1']), ['["\\"a\\"","1"]'])
})
