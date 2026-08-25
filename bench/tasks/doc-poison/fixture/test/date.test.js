import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEvent, isInYear } from '../src/events.js'
import { reportHeader, isInMonth } from '../src/reports.js'

describe('events', () => {
  it('createEvent parses the date', () => {
    const e = createEvent('Launch', '2025-03-15')
    assert.deepEqual(e, { title: 'Launch', date: { year: 2025, month: 3, day: 15 } })
  })

  it('isInYear matches correctly', () => {
    const e = createEvent('X', '2024-01-01')
    assert.equal(isInYear(e, 2024), true)
    assert.equal(isInYear(e, 2025), false)
  })
})

describe('reports', () => {
  it('reportHeader parses both dates', () => {
    const h = reportHeader('2025-01-01', '2025-12-31')
    assert.deepEqual(h.from, { year: 2025, month: 1, day: 1 })
    assert.deepEqual(h.to, { year: 2025, month: 12, day: 31 })
    assert.equal(h.generated, true)
  })

  it('isInMonth checks month', () => {
    assert.equal(isInMonth('2025-06-15', 6), true)
    assert.equal(isInMonth('2025-06-15', 7), false)
  })
})
