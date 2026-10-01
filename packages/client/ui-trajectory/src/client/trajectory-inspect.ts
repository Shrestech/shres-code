/** Resolution of a cross-view inspect target to one Trajectory ledger record. */
import type { InspectTarget } from '@shres-code/shres-code-client-ui-conversation/client'
import type { TrajectoryCellProps } from './trajectory-record.ts'

/** 'conversation.view' entry id of the routing view an Explain link reveals. */
export const ROUTING_VIEW_ID = 'routing'

/** The loaded history window an event target is resolved within. */
export interface InspectHistoryWindow {
  /** Seq of the first loaded event; absent when unknown. */
  readonly startSeq: number | undefined
  /** Whether an older history page can still be loaded. */
  readonly hasOlder: boolean
}

/**
 * Resolve an inspect target against the loaded ledger records.
 *
 * A `call` target resolves to the record carrying that call id and otherwise
 * stays pending, because the call can arrive with a later history page or a
 * later event. An `event` target resolves to the record whose `sourceSeq` is
 * the greatest at or before the target seq: the record the event produced, or
 * the nearest earlier record when the event produced none. It stays pending
 * while older history that could hold that record is unloaded, and resolves to
 * `absent` when the whole history is loaded and no record precedes the seq.
 * Request-only separators never resolve a target.
 * @param records - loaded ledger records in display order.
 * @param target - the target a view was asked to show.
 * @param history - the loaded history window.
 * @returns the record, `pending`, or `absent`.
 */
export function resolveInspectRecord<R extends { readonly cell: TrajectoryCellProps }>(
  records: readonly R[],
  target: InspectTarget,
  history: InspectHistoryWindow,
): R | 'pending' | 'absent' {
  switch (target.kind) {
    case 'call':
      return records.find(record => record.cell.callId === target.callId) ?? 'pending'
    case 'event':
      return resolveEventRecord(records, target.seq, history)
    // A reveal that only selects the view names no record to land on.
    case 'none':
      return 'absent'
    /* v8 ignore next -- closed InspectTarget union */
    default: return assertNever(target)
  }
}

function resolveEventRecord<R extends { readonly cell: TrajectoryCellProps }>(
  records: readonly R[],
  eventSeq: number,
  history: InspectHistoryWindow,
): R | 'pending' | 'absent' {
  if (history.hasOlder && (history.startSeq === undefined || eventSeq < history.startSeq)) return 'pending'
  let best: R | undefined
  let bestSeq = -1
  for (const record of records) {
    const seq = record.cell.sourceSeq
    if (seq === undefined || seq > eventSeq || record.cell.requestOnly === true) continue
    // Strictly greater: among records sharing a seq, the first in display order wins.
    if (seq > bestSeq) {
      best = record
      bestSeq = seq
    }
  }
  if (best !== undefined) return best
  return history.hasOlder ? 'pending' : 'absent'
}

/** Local exhaustiveness helper; client packages do not depend on `shres-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a target kind is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable inspect target: ${JSON.stringify(value)}`)
}
