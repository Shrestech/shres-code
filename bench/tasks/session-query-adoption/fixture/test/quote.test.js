import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORIGIN_STATION } from '../src/origin.js'
import { formatLabel } from '../src/quote.js'

test('ORIGIN_STATION is a non-empty station code', () => {
  assert.equal(typeof ORIGIN_STATION, 'string')
  assert.match(ORIGIN_STATION, /^[A-Z0-9-]+$/)
})

test('formatLabel stamps the origin station', () => {
  assert.equal(formatLabel('ORD-1'), `${ORIGIN_STATION}:ORD-1`)
})
