/** Resolution of cross-view inspect targets to Trajectory ledger records. */
import { describe, expect, it } from 'vitest'
import { resolveInspectRecord } from '../src/client/trajectory-inspect.ts'
import type { TrajectoryCellProps } from '../src/client/trajectory-record.ts'

function record(index: number, over: Partial<TrajectoryCellProps> = {}): { cell: TrajectoryCellProps } {
  return { cell: { index, kind: 'message', text: `#${index}`, timeSeconds: null, ...over } }
}

// Display order: a user record at seq 3, a request-only separator and the
// assistant record sharing seq 5, a tool call at seq 8, and a record with no seq.
const RECORDS = [
  record(1, { kind: 'user', sourceSeq: 3 }),
  record(2, { requestOnly: true, sourceSeq: 5 }),
  record(3, { sourceSeq: 5 }),
  record(4, { kind: 'tool', sourceSeq: 8, callId: 'call-8' }),
  record(5, { kind: 'tool' }),
]
const COMPLETE = { startSeq: 3, hasOlder: false }

describe('resolveInspectRecord', () => {
  it('resolves a call target to the record carrying the call and leaves an unknown call pending', () => {
    expect(resolveInspectRecord(RECORDS, { kind: 'call', callId: 'call-8' }, COMPLETE)).toBe(RECORDS[3])
    expect(resolveInspectRecord(RECORDS, { kind: 'call', callId: 'call-9' }, COMPLETE)).toBe('pending')
  })

  it('resolves an event target to the record its event produced', () => {
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 8 }, COMPLETE)).toBe(RECORDS[3])
  })

  it('resolves an event without a record to the nearest earlier record, never a request-only separator', () => {
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 7 }, COMPLETE)).toBe(RECORDS[2])
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 40 }, COMPLETE)).toBe(RECORDS[3])
  })

  it('picks the first record in display order among records sharing the seq', () => {
    const tied = [record(1, { sourceSeq: 6 }), record(2, { sourceSeq: 6 })]
    expect(resolveInspectRecord(tied, { kind: 'event', seq: 6 }, COMPLETE)).toBe(tied[0])
  })

  it('stays pending while older history that could hold the record is unloaded', () => {
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 1 }, { startSeq: 3, hasOlder: true })).toBe('pending')
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 8 }, { startSeq: undefined, hasOlder: true }))
      .toBe('pending')
    // The first loaded event produced no record: the event may belong to an older record.
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 2 }, { startSeq: 2, hasOlder: true })).toBe('pending')
  })

  it('resolves within the loaded window while older history remains', () => {
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 8 }, { startSeq: 3, hasOlder: true })).toBe(RECORDS[3])
  })

  it('reports absent when the whole history is loaded and no record precedes the seq', () => {
    expect(resolveInspectRecord(RECORDS, { kind: 'event', seq: 2 }, { startSeq: 0, hasOlder: false })).toBe('absent')
    expect(resolveInspectRecord([], { kind: 'event', seq: 2 }, { startSeq: undefined, hasOlder: false })).toBe('absent')
  })
})
