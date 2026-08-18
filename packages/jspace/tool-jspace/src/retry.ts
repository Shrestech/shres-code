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

/** Model-visible refuse when the same call repeats with no card write in between. */
export const REPEAT_DENY =
  'jspace refuses a repeated tool call with the same arguments while a card is open. '
  + 'Write a jspace_note naming the diagnosis, then retry with different arguments or a different tool.'

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
 * Whether this call matches any prior non-current tool/call with no later card
 * write. The scan covers the whole span since the last card write, not only
 * the immediately previous call: alternating `A, B, A` with identical
 * arguments is the same undiagnosed repeat as `A, A`.
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
    if (event.type !== 'tool/call') continue
    const data = event.data as { name?: string; arguments?: unknown; callId?: string }
    if (currentCallId !== undefined && data.callId === currentCallId) continue
    if (data.name === name && canonicalizeArgs(data.arguments) === incoming) return true
  }
  return false
}
