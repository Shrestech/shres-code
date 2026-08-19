/**
 * Register-only ship check: a real Goal and an evidence-backed checkpoint for it.
 * @module @shres-code/shres-code-tool-jspace/ship
 */

import type { SessionEvent } from '@shres-code/shres-code-session'
import { JSPACE_ALWAYS_OPEN_GOAL } from '@shres-code/shres-code-jspace'
import type { JspaceCard } from '@shres-code/shres-code-jspace'

/**
 * Session event seq of the latest card snapshot that grew `checked`.
 * A close tombstone resets the growth baseline so a later card is not
 * credited with a parent checkpoint.
 * @param events - session log.
 * @returns the latest checkpoint seq, or `undefined` when none exists.
 */
function latestEvidenceCheckpointSeq(events: readonly SessionEvent[]): number | undefined {
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
    if (length > previous) {
      const appended = checked.slice(previous)
      if (appended.some(item =>
        typeof item === 'object' && item !== null && typeof item.evidence === 'string')) {
        last = event.seq
      }
    }
    previous = length
  }
  return last
}

/**
 * Why `jspace_ship` must refuse, or `undefined` when the register check passes.
 * A card still holding the placeholder Goal never ships: the model must record
 * the task's done-means as Goal before a checkpoint can count.
 * @param card - current folded card.
 * @param events - session log used to find a checkpoint for the current Goal.
 * @returns the refusal message.
 */
export function shipRefusal(card: JspaceCard | null, events: readonly SessionEvent[]): string | undefined {
  if (card === null) return 'jspace card is not open'
  if (card.goal.length === 0) return 'jspace ship requires a non-empty Goal'
  if (card.goal === JSPACE_ALWAYS_OPEN_GOAL) {
    return `jspace ship refuses the placeholder Goal "${JSPACE_ALWAYS_OPEN_GOAL}"; `
      + "record the task's done-means as Goal with jspace_note or jspace_open first"
  }
  if (card.next.length === 0) return 'jspace ship requires a non-empty Next'
  const checkpointSeq = latestEvidenceCheckpointSeq(events)
  if (checkpointSeq === undefined || checkpointSeq < card.goalOpenedSeq) {
    return 'jspace ship requires an evidence-backed checkpoint for the current Goal'
  }
  return undefined
}
