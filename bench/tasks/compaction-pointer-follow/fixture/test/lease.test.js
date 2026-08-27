import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LEASE_TOKEN } from '../src/lease.js'

test('LEASE_TOKEN is a non-empty lease code', () => {
  assert.equal(typeof LEASE_TOKEN, 'string')
  assert.match(LEASE_TOKEN, /^[A-Z0-9-]+$/)
})
