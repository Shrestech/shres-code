/**
 * Bounded advisory digest over a parent session: enough for a reviewer to
 * judge whether the main session is going wrong, not so much that the digest
 * becomes the full transcript. Reconstructable from the session log alone —
 * the fold reads only committed events, so model-visible reviewer input is
 * always reconstructable from the parent session.
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
  return `${text.slice(0, max - 1)}${TRUNCATION_MARKER}`
}

/** Completed `step/end` events in one session log. */
function countSteps(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'step/end') count += 1
  }
  return count
}

/**
 * Latest human user text from the session log, bounded.
 * @param events - session log.
 * @param max - character cap.
 * @returns the bounded text, or empty when none.
 */
function latestUserIntent(events: readonly SessionEvent[], max: number): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (text.length === 0) continue
    return boundText(text, max)
  }
  return ''
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
    if (event.type !== 'tool/result') continue
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
  /** Character cap on the latest user intent. */
  readonly maxIntent: number
}

/**
 * Fold a bounded advisory digest from one session's committed events.
 * @param session - live session whose log to fold.
 * @param card - the open card, or `null` when none is open.
 * @param caps - digest caps.
 * @returns the digest.
 */
export function foldAdvisorDigest(
  session: Session,
  card: JspaceCard | null,
  caps: AdvisorDigestCaps,
): JspaceAdvisorDigest {
  const recent = recentTools(session.events, caps.maxTools, caps.maxExcerpt)
  const renderedCard = card === null
    ? null
    : formatJspaceCard(card, {
      checkedReprintLimit: DEFAULT_CHECKED_REPRINT_LIMIT,
      openReprintLimit: DEFAULT_OPEN_REPRINT_LIMIT,
    })
  const digest: JspaceAdvisorDigest = {
    card: renderedCard,
    recentTools: recent,
    userIntent: latestUserIntent(session.events, caps.maxIntent),
    steps: countSteps(session.events),
    seq: session.seq,
    maxTools: caps.maxTools,
    maxChars: caps.maxChars,
  }
  return digest
}

/**
 * Render the digest as the reviewer's input text, bounded to `maxChars`.
 * @param digest - folded digest.
 * @returns the bounded render.
 */
export function renderAdvisorDigest(digest: JspaceAdvisorDigest): string {
  const lines: string[] = []
  if (digest.card !== null) lines.push(`Card:\n${digest.card}`)
  if (digest.userIntent.length > 0) lines.push(`Latest user intent: ${digest.userIntent}`)
  lines.push(`Completed steps: ${String(digest.steps)}`)
  if (digest.recentTools.length > 0) {
    const tools = digest.recentTools
      .map(signal => signal.ok
        ? `ok ${signal.name}`
        : `FAIL ${signal.name}${signal.errorExcerpt === undefined ? '' : `: ${signal.errorExcerpt}`}`)
      .join('\n')
    lines.push(`Recent tool outcomes:\n${tools}`)
  }
  return boundText(lines.join('\n'), digest.maxChars)
}
