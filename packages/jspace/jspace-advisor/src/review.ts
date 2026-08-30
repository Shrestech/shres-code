/**
 * Proactive reviewer orchestration: classify triggers, ensure the continuable
 * reviewer child, deliver a review, and capture the settlement notice as a
 * logged `jspace/advisor` event.
 * @module @shres-code/shres-code-jspace-advisor/review
 */

import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import type { Session, SessionEvent, SessionId } from '@shres-code/shres-code-session'
import type { SubagentListEntry } from '@shres-code/shres-code-subagent'
import type { JspaceAdvisorAdvice, AdvisorTrigger } from './types.ts'
import { renderAdvisorDigest } from './digest.ts'
import type { JspaceAdvisorDigest } from './types.ts'

/** Durable creation label for the continuable reviewer child. */
export const ADVISOR_CHILD_LABEL = 'jspace-advisor reviewer'

/** Built-in reviewer persona; overridable via Config. */
export const DEFAULT_REVIEWER_PERSONA =
  'You are the jspace advisor, a reviewer model. You watch a bounded digest of '
  + 'the main session: the open J-Space card and recent tool outcomes. Advise only '
  + 'when something looks wrong or when consulted. Do not edit files or run tools; '
  + 'use wiki_search/wiki_read and the session_search family to gather context, then '
  + 'state a one-sentence verdict and an optional concrete recommendation.'

/** Default reviewer tool filter: durable knowledge and prior-session retrieval. */
export const DEFAULT_REVIEWER_TOOLS = [
  'wiki_search',
  'wiki_read',
  'session_search',
  'session_event_search',
  'session_event_read',
] as const

/** Whether a session is a root (not a delegated child). */
export function isRootSession(session: Session): boolean {
  return session.header.parentSession === undefined
}

/**
 * Classify one committed event as a proactive review trigger, or `undefined`.
 * Coalescing (one review per user turn) is applied by the caller.
 * @param event - the committed session event.
 * @param log - the session log (the event may already be appended).
 * @param errorBurst - consecutive errored tool results that count as a burst.
 * @returns the trigger, or `undefined`.
 */
export function classifyTrigger(
  event: SessionEvent,
  log: readonly SessionEvent[],
  errorBurst: number,
): AdvisorTrigger | undefined {
  if (event.type === 'jspace/charter-run') {
    if (event.data.phase === 'ship') return 'ship-attempt'
    if (!event.data.passed) return 'charter-fail'
    return undefined
  }
  if (event.type === 'jspace/card') {
    const previous = previousCardGoal(log, event.seq)
    if (previous !== undefined && previous !== event.data.goal) return 'goal-epoch'
    return undefined
  }
  if (event.type === 'tool/result') {
    const message = (event.data as {
      message?: { source?: { kind?: string }; content?: ReadonlyArray<{ type?: string; isError?: boolean }> }
    }).message
    if (message?.source?.kind !== 'tool') return undefined
    const block = message.content?.find(part => part.type === 'tool-result')
    if (block?.isError !== true) return undefined
    return countConsecutiveErrors(log, event.seq) >= errorBurst ? 'error-burst' : undefined
  }
  return undefined
}

/** Goal of the last `jspace/card` before `seq`, or `undefined`. */
function previousCardGoal(log: readonly SessionEvent[], seq: number): string | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined || event.type !== 'jspace/card' || event.seq >= seq) continue
    return event.data.goal
  }
  return undefined
}

/** Consecutive errored tool results ending at `seq`. */
function countConsecutiveErrors(log: readonly SessionEvent[], seq: number): number {
  let count = 0
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined || event.seq > seq) continue
    if (event.type !== 'tool/result') break
    const message = (event.data as {
      message?: { source?: { kind?: string }; content?: ReadonlyArray<{ type?: string; isError?: boolean }> }
    }).message
    if (message?.source?.kind !== 'tool') break
    const block = message.content?.find(part => part.type === 'tool-result')
    if (block?.isError !== true) break
    count += 1
  }
  return count
}

/** Whether a user turn is already open (a `user/message` with no later `turn/end`). */
export function userTurnOpen(log: readonly SessionEvent[]): boolean {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') return false
    if (event.type === 'user/message' && event.data.source.kind === 'user') return true
  }
  return false
}

/** Whether a proactive review is already in flight for this session. */
export function reviewInFlight(log: readonly SessionEvent[]): boolean {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined) continue
    if (event.type === 'jspace/advisor') return true
    if (event.type === 'turn/end') return false
  }
  return false
}

/** Resolved reviewer child id, or `undefined` when none exists yet. */
export function existingReviewer(
  children: readonly SubagentListEntry[],
  label: string,
): SessionId | undefined {
  for (const child of children) {
    if (child.kind !== 'child' || child.mode !== 'continuable') continue
    if (child.label === label) return child.id
  }
  return undefined
}

/**
 * Ensure the continuable reviewer child exists for a parent session, creating
 * it when absent.
 * @param ctx - context with subagents.
 * @param parent - the main session's agent.
 * @param provider - the `ctx.subagents` provider name.
 * @param persona - reviewer persona.
 * @param toolFilter - reviewer tool filter.
 * @param signal - cancellation signal.
 * @returns the reviewer child id.
 */
export async function ensureReviewer(
  ctx: Context,
  parent: Agent,
  provider: string,
  persona: string,
  toolFilter: readonly string[],
  signal: AbortSignal,
): Promise<SessionId> {
  const children = await ctx.subagents.listChildren(parent.session.id, signal)
  const existing = existingReviewer(children, ADVISOR_CHILD_LABEL)
  if (existing !== undefined) return existing
  const started = await ctx.subagents.startContinuable({
    provider,
    label: ADVISOR_CHILD_LABEL,
    request: {
      prompt: [{ type: 'text', text: 'You are the jspace advisor reviewer. Await a digest to review.' }],
      parent,
      persona,
      toolFilter: { allow: [...toolFilter] },
    },
    signal,
  })
  return started.childId
}

/**
 * Deliver one proactive review to the reviewer child.
 * @param ctx - context with subagents.
 * @param parent - the main session's agent.
 * @param childId - the reviewer child id.
 * @param digest - the folded advisory digest.
 * @param trigger - why the review ran.
 * @param signal - cancellation signal.
 */
export async function deliverReview(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  digest: JspaceAdvisorDigest,
  trigger: AdvisorTrigger,
  signal: AbortSignal,
): Promise<void> {
  const content = `${renderAdvisorDigest(digest)}\n\nTrigger: ${trigger}\n`
    + 'Review the main session. If something looks wrong, state a one-sentence verdict '
    + 'and an optional concrete recommendation. If nothing is wrong, say so briefly.'
  await ctx.subagents.followup(parent, childId, [{ type: 'text', text: content }], {
    source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.session.id },
    signal,
  })
}

/**
 * Capture a settlement notice for the reviewer child as a logged
 * `jspace/advisor` event.
 * @param session - the parent session.
 * @param event - the committed `user/message` settlement notice.
 * @param trigger - the trigger that started the review.
 * @param maxAdvice - character cap on the advice.
 * @returns the advice, or `undefined` when the notice is not a reviewer settlement.
 */
export function captureSettlement(
  session: Session,
  event: SessionEvent<'user/message'>,
  trigger: AdvisorTrigger,
  maxAdvice: number,
): JspaceAdvisorAdvice | undefined {
  const source = event.data.source
  if (source.kind !== 'subagent-settled') return undefined
  const text = event.data.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
  if (text.length === 0) return undefined
  const advice = text.length <= maxAdvice ? text : `${text.slice(0, maxAdvice - 1)}…`
  return {
    sessionId: session.id,
    childId: source.senderSessionId,
    trigger,
    advice,
    seq: event.seq,
  }
}
