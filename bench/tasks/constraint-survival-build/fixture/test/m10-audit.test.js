import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { invAuditEvent, invAuditFilter, invAuditReplay, invAuditTypes } from '../src/m10-audit.js'

describe('m10-audit', () => {
  it('stamps an event with type and sorted payload keys', () => {
    assert.deepEqual(invAuditEvent('in', { sku: 'AA', qty: 2 }), {
      type: 'in',
      payload: { sku: 'AA', qty: 2 },
      stamp: 'in:qty,sku',
    })
  })

  it('filters events by type', () => {
    const events = [{ type: 'in' }, { type: 'out' }, { type: 'in' }]
    assert.deepEqual(invAuditFilter(events, 'in'), [{ type: 'in' }, { type: 'in' }])
  })

  it('replays in/out events into an on-hand map', () => {
    assert.deepEqual(
      invAuditReplay([
        { type: 'in', payload: { sku: 'AA', qty: 5 } },
        { type: 'out', payload: { sku: 'AA', qty: 2 } },
        { type: 'in', payload: { sku: 'BB', qty: 1 } },
      ]),
      { AA: 3, BB: 1 },
    )
  })

  it('rejects an overdraw or unknown type', () => {
    assert.throws(
      () => invAuditReplay([{ type: 'out', payload: { sku: 'AA', qty: 1 } }]),
      /negative qty/,
    )
    assert.throws(
      () => invAuditReplay([{ type: 'set', payload: { sku: 'AA', qty: 1 } }]),
      /unknown type/,
    )
  })

  it('lists unique types sorted', () => {
    assert.deepEqual(invAuditTypes([{ type: 'out' }, { type: 'in' }, { type: 'in' }]), ['in', 'out'])
  })
})
