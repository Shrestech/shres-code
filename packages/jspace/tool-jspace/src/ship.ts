/**
 * Register-only ship check: a checkpoint must exist for the current Goal.
 * @module @shres-code/shres-code-tool-jspace/ship
 */

import type { SessionEvent } from '@shres-code/shres-code-session'
import type { JspaceCard } from '@shres-code/shres-code-jspace'

/**
 * Session event seq of the latest card snapshot that grew `checked`.
 * A close tombstone resets the growth baseline so a later card is not
 * credited with a parent checkpoint.
 * @param events - session log.
 * @returns the latest checkpoint seq, or `undefined` when none exists.
 */
function latestCheckpointSeq(events: readonly SessionEvent[]): number | undefined {
  let last: number | undefined
  let previous = 0
  for (const event of events) {
    if (event.type === 'jspace/closed') {
      previous = 0
      continue
    }
    if (event.type !== 'jspace/card') continue
    const checked = event.data?.checked
    // Skip an unreadable payload so the last well-formed length stays the baseline.
    if (!Array.isArray(checked)) continue
    const length = checked.length
    if (length > previous) last = event.seq
    previous = length
  }
  return last
}

/**
 * Why `jspace_ship` must refuse, or `undefined` when the register check passes.
 * @param card - current folded card.
 * @param events - session log used to find a checkpoint for the current Goal.
 * @returns the refusal message.
 */
export function shipRefusal(card: JspaceCard | null, events: readonly SessionEvent[]): string | undefined {
  if (card === null) return 'jspace card is not open'
  if (card.goal.length === 0) return 'jspace ship requires a non-empty Goal'
  if (card.next.length === 0) return 'jspace ship requires a non-empty Next'
  const checkpointSeq = latestCheckpointSeq(events)
  if (checkpointSeq === undefined || checkpointSeq < card.goalOpenedSeq) {
    return 'jspace ship requires a checkpoint for the current Goal'
  }
  return undefined
}
