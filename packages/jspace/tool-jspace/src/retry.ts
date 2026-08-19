/**
 * Pre-execute refusals while a J-Space card is open: placeholder state and an
 * unchanged retry of a failed non-card operation.
 * @module @shres-code/shres-code-tool-jspace/retry
 */

import { JSPACE_ALWAYS_OPEN_GOAL } from '@shres-code/shres-code-jspace'
import type { JspaceCard } from '@shres-code/shres-code-jspace'
import type { SessionEvent } from '@shres-code/shres-code-session'

/** Card tools repair or finish state and never trip the pre-execute refusals. */
const CARD_TOOLS = new Set([
  'jspace_open',
  'jspace_note',
  'jspace_checkpoint',
  'jspace_ship',
])

/** Model-visible refusal for an unchanged retry after a failed operation. */
export const REPEAT_DENY =
  'jspace refuses repeating the same failed tool call while Core and Next are unchanged. '
  + 'Use jspace_note to record the changed intermediate or next action before retrying.'

/** Model-visible refusal while the open card still holds the placeholder Goal. */
export const PLACEHOLDER_DENY =
  'jspace denies tool calls while the open card holds the placeholder Goal. '
  + "Record the task's done-means as Goal and any must-not-forget intermediate or constraint as Core "
  + 'with jspace_note or jspace_open before acting.'

/**
 * Whether this call must wait for a real Goal. Card tools remain available so
 * the model can repair the placeholder opened by bare `/j-space on`.
 * @param card - current folded card.
 * @param name - incoming tool name.
 * @returns true when the harness must deny.
 */
export function shouldRefusePlaceholder(card: JspaceCard, name: string): boolean {
  return card.goal === JSPACE_ALWAYS_OPEN_GOAL && !CARD_TOOLS.has(name)
}

/**
 * Canonical JSON for logged or live tool arguments.
 * @param value - parsed object or a logged JSON string.
 * @returns a stable string, or empty when the value is not JSON.
 */
export function canonicalizeArgs(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return canonicalize(JSON.parse(value) as unknown)
    } catch {
      return value
    }
  }
  try {
    return canonicalize(value)
  } catch {
    return ''
  }
}

/** Stable JSON with recursively sorted object keys. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Whether a card mutation changed the diagnosis-bearing fields. */
function diagnosisChanged(previous: JspaceCard, current: JspaceCard): boolean {
  return previous.goal !== current.goal
    || previous.next !== current.next
    || JSON.stringify(previous.core) !== JSON.stringify(current.core)
    || JSON.stringify(previous.open) !== JSON.stringify(current.open)
}

/**
 * Whether this call repeats a failed identical call since the last Goal/Core/
 * Next mutation or `turn/start`. Checkpoint-only card writes do not count as a
 * changed diagnosis. The current in-flight call may already be logged and is
 * skipped by call id.
 * @param events - session log.
 * @param name - incoming tool name.
 * @param args - incoming parsed arguments.
 * @param currentCallId - in-flight call id, when logged.
 * @param visibleSurfaceSeqs - current message-producing event seqs; when
 * provided, a failed result shadowed by compaction cannot trigger a refusal.
 * @returns true when the harness must deny.
 */
export function shouldRefuseRepeat(
  events: readonly SessionEvent[],
  name: string,
  args: unknown,
  currentCallId?: string,
  visibleSurfaceSeqs?: readonly number[],
): boolean {
  if (CARD_TOOLS.has(name)) return false
  const incoming = canonicalizeArgs(args)
  const visible = visibleSurfaceSeqs === undefined ? undefined : new Set(visibleSurfaceSeqs)
  let boundary = 0
  let previousCard: JspaceCard | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start' || event.type === 'jspace/closed') {
      boundary = index + 1
      previousCard = undefined
      continue
    }
    if (event.type !== 'jspace/card') continue
    const card = event.data as JspaceCard
    if (previousCard !== undefined && diagnosisChanged(previousCard, card)) boundary = index + 1
    previousCard = card
  }

  const failed = new Set<string>()
  for (let index = boundary; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/result') continue
    if (visible !== undefined && !visible.has(event.seq)) continue
    const message = event.data.message
    if (message.source.kind !== 'tool') continue
    const block = message.content.find(part => part.type === 'tool-result')
    if (block?.type === 'tool-result' && block.isError === true) {
      failed.add(String(message.source.callId))
    }
  }
  for (let index = boundary; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'tool/result') {
      continue
    }
    if (event.type !== 'tool/call') continue
    const callId = String(event.data.callId)
    if (currentCallId !== undefined && callId === currentCallId) continue
    if (event.data.name === name
      && canonicalizeArgs(event.data.arguments) === incoming
      && failed.has(callId)) return true
  }
  return false
}
