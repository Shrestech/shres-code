import assert from 'node:assert/strict'
import { test } from 'node:test'
import { availableBalance, balance } from '../src/ledger.js'

test('deposits and withdrawals sum', () => {
  assert.equal(balance([
    { kind: 'deposit', amount: 100 },
    { kind: 'withdrawal', amount: 40 },
  ]), 60)
})

test('a zero withdrawal must not flip the balance', () => {
  assert.equal(balance([
    { kind: 'deposit', amount: 50 },
    { kind: 'withdrawal', amount: 0 },
  ]), 50)
})
