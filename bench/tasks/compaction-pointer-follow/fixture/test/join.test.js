import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinParts } from '../src/join.js'

test('joinParts joins with a separator', () => {
  assert.equal(joinParts(['a', 'b'], '-'), 'a-b')
})

test('joinParts handles empty and singleton lists', () => {
  assert.equal(joinParts([], ','), '')
  assert.equal(joinParts(['only'], ','), 'only')
})
