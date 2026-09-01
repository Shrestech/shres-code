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
import type { JspaceAdvisorDelta, JspaceAdvisorDigest, JspaceAdvisorToolSignal } from './types.ts'

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

/** Preferred tool-argument keys, in priority order, for the digest excerpt. */
const ARG_EXCERPT_KEYS = ['command', 'file_path', 'path', 'target_file', 'url', 'query', 'question'] as const

/**
 * Bound a path, command, or JSON argument blob for the trailing tool window.
 * @param raw - `tool/call` arguments JSON string, or undefined.
 * @param max - character cap.
 * @returns the excerpt, or undefined when the call carried no arguments.
 */
export function argsExcerpt(raw: string | undefined, max: number): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return boundText(raw, max)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return boundText(typeof parsed === 'string' ? parsed : JSON.stringify(parsed), max)
  }
  const obj = parsed as Record<string, unknown>
  for (const key of ARG_EXCERPT_KEYS) {
    const value = obj[key]
    if (typeof value === 'string' && value.length > 0) return boundText(value, max)
  }
  return boundText(JSON.stringify(obj), max)
}

/**
 * Resolve a tool/result to its owning call seq, name, success bit, and
 * bounded excerpts, oldest-first within the trailing window.
 * @param events - session log.
 * @param maxItems - maximum signal items to retain.
 * @param maxExcerpt - character cap on each error excerpt.
 * @param maxArgs - character cap on each argument excerpt.
 * @returns the trailing window, oldest-first.
 */
function recentTools(
  events: readonly SessionEvent[],
  maxItems: number,
  maxExcerpt: number,
  maxArgs: number,
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
    const args = argsExcerpt((event.data as { arguments?: string }).arguments, maxArgs)
    out.push({
      seq: typeof event.seq === 'number' ? event.seq : 0,
      name: (event.data as { name?: string }).name ?? '<unknown>',
      ok: result.ok,
      ...args === undefined ? {} : { argsExcerpt: args },
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
  /** Character cap on each tool-argument excerpt. */
  readonly maxArgs: number
}

/**
 * Latest passing ship for this Goal epoch, if any.
 * @param events - session log.
 * @param card - open card, or null.
 * @returns the digest line, or undefined.
 */
export function foldShippedMarker(
  events: readonly SessionEvent[],
  card: JspaceCard | null,
): string | undefined {
  if (card === null) return undefined
  let seq: number | undefined
  for (const event of events) {
    if (event.seq < card.goalOpenedSeq) continue
    if (event.type === 'jspace/shipped') {
      const opened = (event.data as { goalOpenedSeq?: number }).goalOpenedSeq
      if (opened === card.goalOpenedSeq) seq = event.seq
      continue
    }
    if (event.type === 'jspace/charter-run' && event.data.phase === 'ship' && event.data.passed) {
      seq = event.seq
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = (event.data as {
      message?: { source?: { kind?: string; callId?: string } }
    }).message
    if (message?.source?.kind !== 'tool' || message.source.callId === undefined) continue
    const block = (event.data as {
      message?: { content?: ReadonlyArray<{ type?: string; isError?: boolean }> }
    }).message?.content?.find(part => part.type === 'tool-result')
    if (block?.isError === true) continue
    const callId = message.source.callId
    for (const candidate of events) {
      if (candidate.type !== 'tool/call') continue
      const data = candidate.data as { callId?: string; name?: string }
      if (data.callId === callId && data.name === 'jspace_ship') seq = event.seq
    }
  }
  if (seq === undefined) return undefined
  return 'Card Goal shipped (register check passed at seq ' + String(seq)
    + '; ship does not close the card)'
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
  const recent = recentTools(session.events, caps.maxTools, caps.maxExcerpt, caps.maxArgs)
  const history = foldUserMessages(session.events, caps.maxUserMessage, caps.maxUserHistory)
  const renderedCard = card === null
    ? null
    : formatJspaceCard(card, {
      checkedReprintLimit: DEFAULT_CHECKED_REPRINT_LIMIT,
      openReprintLimit: DEFAULT_OPEN_REPRINT_LIMIT,
    })
  const shipped = foldShippedMarker(session.events, card)
  return {
    sessionId: session.id,
    card: renderedCard,
    userMessages: history.messages,
    elidedUserMessages: history.elided,
    recentTools: recent,
    steps: countSteps(session.events),
    seq: session.seq,
    maxTools: caps.maxTools,
    maxChars: caps.maxChars,
    ...shipped === undefined ? {} : { shipped },
  }
}

/** Render trailing tool signals, oldest-first, one per line. */
function renderToolSignals(signals: readonly JspaceAdvisorToolSignal[]): string {
  return signals
    .map((signal) => {
      const args = signal.argsExcerpt === undefined ? '' : ' ' + signal.argsExcerpt
      const fail = signal.ok ? '' : (signal.errorExcerpt === undefined ? '' : ': ' + signal.errorExcerpt)
      return (signal.ok ? 'ok ' : 'FAIL ') + signal.name + ' seq=' + String(signal.seq) + args + fail
    })
    .join('\n')
}

/**
 * Render the digest as the reviewer's input text, bounded to maxChars.
 * Order is truncation priority: the parent session id and seq range, then the
 * user stream and the card; the trailing tool window renders last so the cap
 * eats it first.
 * @param digest - folded digest.
 * @returns the bounded render.
 */
export function renderAdvisorDigest(digest: JspaceAdvisorDigest): string {
  const lines: string[] = [
    'Main session id: ' + digest.sessionId,
    'Folded through seq: ' + String(digest.seq),
  ]
  if (digest.userMessages.length > 0) {
    const history = digest.userMessages.map((text, index) => 'U' + String(index + 1) + ': ' + text)
    if (digest.elidedUserMessages > 0) {
      history.splice(1, 0, '(' + String(digest.elidedUserMessages) + ' earlier user messages elided)')
    }
    lines.push('User messages (the goal ground truth):\n' + history.join('\n'))
  }
  if (digest.card !== null) lines.push('Session card (the session\'s own claim):\n' + digest.card)
  if (digest.shipped !== undefined) lines.push(digest.shipped)
  lines.push('Completed steps: ' + String(digest.steps))
  if (digest.recentTools.length > 0) {
    lines.push('Recent tool outcomes:\n' + renderToolSignals(digest.recentTools))
  }
  return boundText(lines.join('\n'), digest.maxChars)
}
/**
 * First non-empty source-'user' message text, bounded, or an empty string
 * when the session carries none.
 * @param events - session log.
 * @param max - character cap.
 * @returns the bounded goal statement.
 */
function goalMessage(events: readonly SessionEvent[], max: number): string {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const text = userMessageText(event)
    if (text.length === 0) continue
    return boundText(text, max)
  }
  return ''
}

/**
 * Fold the bounded delta since the standing reviewer's previous turn. The
 * tool window pairs only calls and results that both fall inside the delta:
 * a call from before the last review whose result landed after it carries no
 * signal.
 * @param session - live session whose log to fold.
 * @param card - the open card, or null when none is open.
 * @param caps - digest caps.
 * @param sinceSeq - session event seq the previous review folded through.
 * @returns the delta.
 */
export function foldAdvisorDelta(
  session: Session,
  card: JspaceCard | null,
  caps: AdvisorDigestCaps,
  sinceSeq: number,
): JspaceAdvisorDelta {
  const since = session.events.filter(event => event.seq > sinceSeq)
  const history = foldUserMessages(since, caps.maxUserMessage, caps.maxUserHistory)
  const renderedCard = card === null
    ? null
    : formatJspaceCard(card, {
      checkedReprintLimit: DEFAULT_CHECKED_REPRINT_LIMIT,
      openReprintLimit: DEFAULT_OPEN_REPRINT_LIMIT,
    })
  const shipped = foldShippedMarker(session.events, card)
  return {
    sessionId: session.id,
    goal: goalMessage(session.events, caps.maxUserMessage),
    userMessages: history.messages,
    card: renderedCard,
    recentTools: recentTools(since, caps.maxTools, caps.maxExcerpt, caps.maxArgs),
    steps: countSteps(since),
    sinceSeq,
    seq: session.seq,
    maxTools: caps.maxTools,
    maxChars: caps.maxChars,
    ...shipped === undefined ? {} : { shipped },
  }
}

/**
 * Render the delta as the reviewer's follow-up input text, bounded to
 * maxChars with the same truncation priority as the full digest: the goal
 * anchor, new user messages, and the card survive first and the tool window
 * renders last.
 * @param delta - folded delta.
 * @returns the bounded render.
 */
export function renderAdvisorDelta(delta: JspaceAdvisorDelta): string {
  const lines: string[] = [
    'Main session id: ' + delta.sessionId,
    'Folded events: ' + String(delta.sinceSeq) + ' → ' + String(delta.seq),
  ]
  if (delta.goal.length > 0) lines.push('Goal (U1): ' + delta.goal)
  if (delta.userMessages.length > 0) {
    const fresh = delta.userMessages.map((text, index) => 'N' + String(index + 1) + ': ' + text).join('\n')
    lines.push('New user messages since event ' + String(delta.sinceSeq) + ':\n' + fresh)
  } else {
    lines.push('New user messages since event ' + String(delta.sinceSeq) + ': (none)')
  }
  if (delta.card !== null) lines.push('Session card (the session\'s own claim):\n' + delta.card)
  if (delta.shipped !== undefined) lines.push(delta.shipped)
  lines.push('Steps completed since the last review: ' + String(delta.steps))
  if (delta.recentTools.length > 0) {
    lines.push('Tool outcomes since the last review:\n' + renderToolSignals(delta.recentTools))
  }
  return boundText(lines.join('\n'), delta.maxChars)
}
