/**
 * Epoch-scoped design-defense evidence over the session log: which debate
 * tools hold a completed non-error call at or after the current Goal epoch
 * anchor. The walk mirrors the jspace evidence-grade call lookup so one
 * definition of "completed call" backs both gates.
 * @module @shres-code/shres-code-research-protocol/epoch
 */

import type { SessionEvent } from '@shres-code/shres-code-session'

/** One completed non-error call the walk credits to its tool name. */
export interface CompletedDebateCall {
  /** Tool name the call was made against. */
  readonly tool: string
  /** Tool-call id the result is matched by. */
  readonly callId: string
  /** Session event seq of the call. */
  readonly seq: number
}

/**
 * Whether one `tool/call` event names one of the watched tools at or after
 * the anchor.
 * @param event - candidate session event.
 * @param toolNames - watched tool names.
 * @param anchorSeq - inclusive epoch anchor.
 * @returns true when the event is a watched call in the epoch.
 */
function isWatchedCall(event: SessionEvent, toolNames: readonly string[], anchorSeq: number): event is SessionEvent<'tool/call'> & { seq: number } {
  if (event.seq < anchorSeq) return false
  if (event.type !== 'tool/call') return false
  const name = (event.data as { name?: unknown }).name
  return typeof name === 'string' && toolNames.includes(name)
}

/**
 * Whether the log holds a non-error `tool/result` for one call id, matching
 * the jspace evidence walk field for field.
 * @param events - session log.
 * @param callId - claimed tool-call id.
 * @returns true when the call completed without an error block.
 */
function hasNonErrorResult(events: readonly SessionEvent[], callId: string): boolean {
  return events.some((event) => {
    if (event.type !== 'tool/result') return false
    const message = (event.data as {
      message?: {
        source?: { kind?: string; callId?: string }
        content?: ReadonlyArray<{ type?: string; isError?: boolean }>
      }
    }).message
    const block = message?.content?.find(part => part.type === 'tool-result')
    return message?.source?.kind === 'tool'
      && message.source.callId === callId
      && block !== undefined
      && block.isError !== true
  })
}

/**
 * Latest completed non-error call per watched tool at or after the anchor.
 * @param events - session log.
 * @param toolNames - watched tool names.
 * @param anchorSeq - inclusive epoch anchor; calls strictly before it never count.
 * @returns the latest credited call per tool name that has one.
 */
export function completedDebateCalls(
  events: readonly SessionEvent[],
  toolNames: readonly string[],
  anchorSeq: number,
): Map<string, CompletedDebateCall> {
  const latest = new Map<string, CompletedDebateCall>()
  for (const event of events) {
    if (!isWatchedCall(event, toolNames, anchorSeq)) continue
    const callId = (event.data as { callId?: unknown }).callId
    if (typeof callId !== 'string') continue
    const previous = latest.get(event.data.name)
    if (previous !== undefined && previous.seq >= event.seq) continue
    latest.set(event.data.name, { tool: event.data.name, callId, seq: event.seq })
  }
  for (const [tool, call] of latest) {
    if (!hasNonErrorResult(events, call.callId)) latest.delete(tool)
  }
  return latest
}

/**
 * Watched debate tools without a completed non-error call in the epoch, in
 * the order they are configured.
 * @param events - session log.
 * @param toolNames - watched tool names, in configured order.
 * @param anchorSeq - inclusive epoch anchor.
 * @returns the missing tool names.
 */
export function missingDebateTools(
  events: readonly SessionEvent[],
  toolNames: readonly string[],
  anchorSeq: number,
): string[] {
  const completed = completedDebateCalls(events, toolNames, anchorSeq)
  return toolNames.filter(tool => !completed.has(tool))
}

/** Prefix every design-defense refusal carries; the invariant keys on it. */
export const DESIGN_DEFENSE_DENY_PREFIX = 'research protocol requires a design defense before logging a run'

/**
 * The model-visible refusal naming the debate tools still missing this epoch.
 * @param missing - missing tool names, in configured order.
 * @returns the refusal reason.
 */
export function designDefenseDeny(missing: readonly string[]): string {
  return `${DESIGN_DEFENSE_DENY_PREFIX}: completed calls missing for: ${missing.join(', ')}`
}
