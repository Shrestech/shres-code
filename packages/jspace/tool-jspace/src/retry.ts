/**
 * Refuse a blank identical retry while a J-Space card is open.
 * @module @shres-code/shres-code-tool-jspace/retry
 */

import type { SessionEvent } from '@shres-code/shres-code-session'

/** Card tools write diagnosis; they never trip the repeat refuse. */
const CARD_TOOLS = new Set([
  'jspace_open',
  'jspace_note',
  'jspace_checkpoint',
  'jspace_ship',
])

/** Default `jspace_note` calls accepted in one user turn. Raising it is a deployment choice. */
export const DEFAULT_MAX_NOTES_PER_TURN = 8

/** Model-visible refuse when the same call repeats with no card write in between. */
export const REPEAT_DENY =
  'jspace refuses repeating a tool call with the same arguments within a turn while a card is open. '
  + 'Write a jspace_note naming the diagnosis first; after that note the same call runs again.'

/**
 * Model-visible refuse when this turn already spent its `jspace_note` budget.
 * @param maxNotesPerTurn - configured cap.
 * @returns one-sentence denial.
 */
export function noteCapDeny(maxNotesPerTurn: number): string {
  return `jspace_note is limited to ${String(maxNotesPerTurn)} calls this turn; write a checkpoint or do the work instead.`
}

/**
 * Canonical JSON for logged or live tool arguments.
 * @param value - parsed object or a logged JSON string.
 * @returns a stable string, or empty when the value is not JSON.
 */
export function canonicalizeArgs(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value) as unknown)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Whether this call matches any prior non-current tool/call in the same turn
 * with no later card write. The scan covers the whole span since the last
 * card write or `turn/start`, not only the immediately previous call:
 * alternating `A, B, A` with identical arguments is the same undiagnosed
 * repeat as `A, A`. A new user turn bounds the scan, so re-issuing a command
 * the user asked for again stays legal.
 * @param events - session log (the current `tool/call` may already be appended).
 * @param name - incoming tool name.
 * @param args - incoming parsed arguments.
 * @param currentCallId - call id of the in-flight execution, when logged.
 * @returns true when the harness must deny.
 */
export function shouldRefuseRepeat(
  events: readonly SessionEvent[],
  name: string,
  args: unknown,
  currentCallId?: string,
): boolean {
  if (CARD_TOOLS.has(name)) return false
  const incoming = canonicalizeArgs(args)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'jspace/card' || event.type === 'jspace/closed') return false
    if (event.type === 'turn/start') return false
    if (event.type !== 'tool/call') continue
    const data = event.data as { name?: string; arguments?: unknown; callId?: string }
    if (currentCallId !== undefined && data.callId === currentCallId) continue
    if (data.name === name && canonicalizeArgs(data.arguments) === incoming) return true
  }
  return false
}

/**
 * Count `jspace_note` tool/call events in the current turn, excluding the
 * in-flight call. A new `turn/start` resets the count; card writes do not.
 * @param events - session log (the current `tool/call` may already be appended).
 * @param currentCallId - call id of the in-flight execution, when logged.
 * @returns notes already issued this turn.
 */
export function countNotesThisTurn(
  events: readonly SessionEvent[],
  currentCallId?: string,
): number {
  let count = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') return count
    if (event.type !== 'tool/call') continue
    const data = event.data as { name?: string; callId?: string }
    if (currentCallId !== undefined && data.callId === currentCallId) continue
    if (data.name === 'jspace_note') count += 1
  }
  return count
}

/**
 * Whether this `jspace_note` has already spent the per-turn budget.
 * @param events - session log.
 * @param name - incoming tool name.
 * @param maxNotesPerTurn - configured cap.
 * @param currentCallId - call id of the in-flight execution, when logged.
 * @returns true when the harness must deny.
 */
export function shouldRefuseNoteCap(
  events: readonly SessionEvent[],
  name: string,
  maxNotesPerTurn: number,
  currentCallId?: string,
): boolean {
  if (name !== 'jspace_note') return false
  return countNotesThisTurn(events, currentCallId) >= maxNotesPerTurn
}
