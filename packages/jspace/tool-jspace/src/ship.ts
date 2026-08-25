/**
 * Register-only ship check: a checkpoint must exist for the current Goal.
 * @module @shres-code/shres-code-tool-jspace/ship
 */

import type { SessionEvent } from '@shres-code/shres-code-session'
import type { JspaceCard } from '@shres-code/shres-code-jspace'

/** Model-visible refusal when `requireVerifiedEvidence` finds no verifier citation. */
export const SHIP_REQUIRES_VERIFIED_EVIDENCE
  = 'jspace ship requires an evidence-grade checkpoint that cites a completed non-error verifier tool call'

/** Options for the register-only ship check. */
export interface ShipRefusalOptions {
  /** When true, require a `verified` checkpoint in the current Goal epoch. */
  readonly requireVerifiedEvidence?: boolean
}

/**
 * Session event seq of the latest card snapshot that grew `checked`.
 * A close tombstone resets the growth baseline so a later card is not
 * credited with a parent checkpoint.
 * @param events - session log.
 * @param verifiedOnly - when true, only count a growth that adds `verified: true`.
 * @returns the latest matching checkpoint seq, or `undefined` when none exists.
 */
function latestCheckpointSeq(
  events: readonly SessionEvent[],
  verifiedOnly = false,
): number | undefined {
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
      const added = checked.slice(previous)
      if (!verifiedOnly || added.some(lineIsVerified)) last = event.seq
    }
    previous = length
  }
  return last
}

/**
 * Whether a checked-line value carries `verified: true`.
 * @param line - candidate from a card payload.
 * @returns true when the line is evidence-grade.
 */
function lineIsVerified(line: unknown): boolean {
  return typeof line === 'object'
    && line !== null
    && !Array.isArray(line)
    && (line as { verified?: unknown }).verified === true
}

/**
 * Why `jspace_ship` must refuse, or `undefined` when the register check passes.
 * @param card - current folded card.
 * @param events - session log used to find a checkpoint for the current Goal.
 * @param options - optional evidence-grade requirement from seat config.
 * @returns the refusal message.
 */
export function shipRefusal(
  card: JspaceCard | null,
  events: readonly SessionEvent[],
  options?: ShipRefusalOptions,
): string | undefined {
  if (card === null) return 'jspace card is not open'
  if (card.goal.length === 0) return 'jspace ship requires a non-empty Goal'
  if (card.next.length === 0) return 'jspace ship requires a non-empty Next'
  const checkpointSeq = latestCheckpointSeq(events)
  if (checkpointSeq === undefined || checkpointSeq < card.goalOpenedSeq) {
    return 'jspace ship requires a checkpoint for the current Goal'
  }
  if (options?.requireVerifiedEvidence === true) {
    const verifiedSeq = latestCheckpointSeq(events, true)
    if (verifiedSeq === undefined || verifiedSeq < card.goalOpenedSeq) {
      return SHIP_REQUIRES_VERIFIED_EVIDENCE
    }
  }
  return undefined
}
