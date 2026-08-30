/**
 * Bounded advisory digest over a parent session: enough for a reviewer to
 * judge whether the main session still serves the user's goal, not so much
 * that the digest becomes the full transcript. Reconstructable from the
 * session log alone — the fold reads only committed events, so model-visible
 * reviewer input is always reconstructable from the parent session.
 * @module @shres-code/shres-code-jspace-advisor/digest
 */

import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import {
  DEFAULT_CHECKED_REPRINT_LIMIT,
  DEFAULT_OPEN_REPRINT_LIMIT,
  formatJspaceCard,
} from '@shres-code/shres-code-jspace'
import type { JspaceCard } from '@shres-code/shres-code-jspace'
import type { JspaceAdvisorDigest, JspaceAdvisorToolSignal } from './types.ts'

/** Truncation marker appended when a bounded field is cut. */
export const TRUNCATION_MARKER = '…'

/**
 * Bound a string to a maximum length, appending a marker when cut.
 * @param text - source text.
 * @param max - maximum length; must be ≥ 1.
 * @returns the bounded text.
 */
export function boundText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + TRUNCATION_MARKER
}

/** Completed step/end events in one session log. */
function countSteps(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event !== undefined && event.type === 'step/end') count += 1
  }
  return count
}

/** Text of one source-'user' message, or an empty string when it carries none. */
function userMessageText(event: SessionEvent<'user/message'>): string {
  return event.data.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/**
 * Fold every human user message, oldest-first, bounded per message and in
 * total. The first message — the session's goal statement — is always
 * retained; the total cap drops the oldest droppable entries first and the
 * caller renders the elided count in the card's elision voice.
 * @param events - session log.
 * @param maxPerMessage - character cap on each message.
 * @param maxTotal - character cap on the retained history as a whole.
 * @returns the retained messages plus the count of elided ones.
 */
export function foldUserMessages(
  events: readonly SessionEvent[],
  maxPerMessage: number,
  maxTotal: number,
): { messages: string[]; elided: number } {
  const all: string[] = []
  for (const event of events) {
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const text = userMessageText(event)
    if (text.length === 0) continue
    all.push(boundText(text, maxPerMessage))
  }
  if (all.length <= 1) return { messages: all, elided: 0 }
  const first = all[0] as string
  const keep = new Set<number>([0])
  let used = first.length
  for (let index = all.length - 1; index >= 1; index -= 1) {
    const entry = all[index] as string
    if (used + entry.length > maxTotal) break
    keep.add(index)
    used += entry.length
  }
  const messages = all.filter((_, index) => keep.has(index))
  return { messages, elided: all.length - messages.length }
}

/**
 * Resolve a tool/result to its owning call name, success bit, and a bounded
 * error excerpt, oldest-first within the trailing window.
 * @param events - session log.
 * @param maxItems - maximum signal items to retain.
 * @param maxExcerpt - character cap on each error excerpt.
 * @returns the trailing window, oldest-first.
 */
function recentTools(
  events: readonly SessionEvent[],
  maxItems: number,
  maxExcerpt: number,
): readonly JspaceAdvisorToolSignal[] {
  const resultByCall = new Map<string, { ok: boolean; excerpt?: string }>()
  for (const event of events) {
    if (event === undefined || event.type !== 'tool/result') continue
    const message = (event.data as {
      message?: {
        source?: { kind?: string; callId?: string }
        content?: ReadonlyArray<{ type?: string; isError?: boolean; text?: string }>
      }
    }).message
    if (message?.source?.kind !== 'tool') continue
    const callId = message.source.callId
    if (callId === undefined) continue
    const block = message.content?.find(part => part.type === 'tool-result')
    const ok = block?.isError !== true
    const excerpt = ok || block?.text === undefined
      ? undefined
      : boundText(block.text, maxExcerpt)
    resultByCall.set(callId, { ok, ...excerpt === undefined ? {} : { excerpt } })
  }
  const out: JspaceAdvisorToolSignal[] = []
  for (let index = events.length - 1; index >= 0 && out.length < maxItems; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/call') continue
    const callId = (event.data as { callId?: string }).callId
    if (callId === undefined) continue
    const result = resultByCall.get(callId)
    if (result === undefined) continue
    out.push({
      name: (event.data as { name?: string }).name ?? '<unknown>',
      ok: result.ok,
      ...result.excerpt === undefined ? {} : { errorExcerpt: result.excerpt },
    })
  }
  return out.reverse()
}

/** Digest fold caps. */
export interface AdvisorDigestCaps {
  /** Trailing tool signals to retain. */
  readonly maxTools: number
  /** Character cap on the complete rendered digest. */
  readonly maxChars: number
  /** Character cap on each error excerpt. */
  readonly maxExcerpt: number
  /** Character cap on each user message. */
  readonly maxUserMessage: number
  /** Character cap on the retained user-message history. */
  readonly maxUserHistory: number
}

/**
 * Fold a bounded advisory digest from one session's committed events.
 * @param session - live session whose log to fold.
 * @param card - the open card, or null when none is open.
 * @param caps - digest caps.
 * @returns the digest.
 */
export function foldAdvisorDigest(
  session: Session,
  card: JspaceCard | null,
  caps: AdvisorDigestCaps,
): JspaceAdvisorDigest {
  const recent = recentTools(session.events, caps.maxTools, caps.maxExcerpt)
  const history = foldUserMessages(session.events, caps.maxUserMessage, caps.maxUserHistory)
  const renderedCard = card === null
    ? null
    : formatJspaceCard(card, {
      checkedReprintLimit: DEFAULT_CHECKED_REPRINT_LIMIT,
      openReprintLimit: DEFAULT_OPEN_REPRINT_LIMIT,
    })
  return {
    card: renderedCard,
    userMessages: history.messages,
    elidedUserMessages: history.elided,
    recentTools: recent,
    steps: countSteps(session.events),
    seq: session.seq,
    maxTools: caps.maxTools,
    maxChars: caps.maxChars,
  }
}

/**
 * Render the digest as the reviewer's input text, bounded to maxChars.
 * Order is truncation priority: the user stream (goal ground truth) and the
 * card survive first; the trailing tool window renders last so the cap eats
 * it first.
 * @param digest - folded digest.
 * @returns the bounded render.
 */
export function renderAdvisorDigest(digest: JspaceAdvisorDigest): string {
  const lines: string[] = []
  if (digest.userMessages.length > 0) {
    const history = digest.userMessages.map((text, index) => 'U' + String(index + 1) + ': ' + text)
    if (digest.elidedUserMessages > 0) {
      history.splice(1, 0, '(' + String(digest.elidedUserMessages) + ' earlier user messages elided)')
    }
    lines.push('User messages (the goal ground truth):\n' + history.join('\n'))
  }
  if (digest.card !== null) lines.push('Session card (the session\'s own claim):\n' + digest.card)
  lines.push('Completed steps: ' + String(digest.steps))
  if (digest.recentTools.length > 0) {
    const tools = digest.recentTools
      .map(signal => signal.ok
        ? 'ok ' + signal.name
        : 'FAIL ' + signal.name + (signal.errorExcerpt === undefined ? '' : ': ' + signal.errorExcerpt))
      .join('\n')
    lines.push('Recent tool outcomes:\n' + tools)
  }
  return boundText(lines.join('\n'), digest.maxChars)
}
