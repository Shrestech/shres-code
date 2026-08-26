import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clip } from '../src/clip.js'

test('clip shortens overlong text', () => {
  assert.equal(clip('abcdef', 3), 'abc')
})

test('clip returns text within max', () => {
  assert.equal(clip('ab', 3), 'ab')
  assert.equal(clip('', 0), '')
})
