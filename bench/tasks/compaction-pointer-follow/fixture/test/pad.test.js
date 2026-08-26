import assert from 'node:assert/strict'
import { test } from 'node:test'
import { padLeft } from '../src/pad.js'

test('padLeft prepends spaces to reach width', () => {
  assert.equal(padLeft('ab', 5), '   ab')
})

test('padLeft returns text that already meets width', () => {
  assert.equal(padLeft('abcde', 5), 'abcde')
  assert.equal(padLeft('abcdef', 3), 'abcdef')
})
