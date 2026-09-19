/**
 * Bounded worker digest: enough for the Lead to see what a stuck worker was
 * doing, not so much that the report becomes the worker's transcript.
 * Reconstructable from the worker's own log alone, so what the report carried
 * is always readable back from the session.
 *
 * The anchor is the worker-mode fix: a delegated worker's conversation has no
 * human in it, so the fold anchors on the Lead's assignment — the first
 * delivered team message, whose `team-message` source kind the human-message
 * fold drops — plus the card's charter. Human messages are deliberately not an
 * anchor here.
 *
 * @module @shres-code/shres-code-worker-escalation/digest
 */

import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import type {} from '@shres-code/shres-code-agent-team'
import type {} from '@shres-code/shres-code-jspace'
import type { WorkerEscalationDigest, WorkerEscalationToolSignal } from './types.ts'

/** Truncation marker appended when a bounded field is cut. */
export const TRUNCATION_MARKER = '…'

/** Digest fold caps. */
export interface WorkerDigestCaps {
  /** Trailing tool signals to retain. */
  readonly maxTools: number
  /** Character cap on the complete rendered digest. */
  readonly maxChars: number
  /** Character cap on each bounded excerpt. */
  readonly maxExcerpt: number
  /** Character cap on each tool-argument excerpt. */
  readonly maxArgs: number
}

/**
 * Bound a string to a maximum length, appending a marker when cut.
 * @param text - source text.
 * @param max - maximum length; must be >= 1.
 * @returns the bounded text.
 */
export function boundText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + TRUNCATION_MARKER
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
  const record = parsed as Record<string, unknown>
  for (const key of ARG_EXCERPT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return boundText(value, max)
  }
  return boundText(JSON.stringify(record), max)
}

/** Text of one user-role message, or an empty string when it carries none. */
function userMessageText(event: SessionEvent<'user/message'>): string {
  const parts: string[] = []
  for (const part of event.data.content) {
    if (part.type === 'text' && part.text.length > 0) parts.push(part.text)
  }
  return parts.join('\n').trim()
}

/** The bounded team-message fold a worker digest anchors on. */
export interface WorkerAssignmentFold {
  /** The Lead's assignment: the first delivered team message, bounded; empty when the worker carries none. */
  readonly assignment: string
  /** Later team mail, oldest-first and bounded; the assignment is never in this list. */
  readonly mail: readonly string[]
  /** Count of team messages the total cap dropped. */
  readonly elided: number
}

/**
 * Fold every delivered team message, oldest-first. The first is the Lead's
 * assignment and is always retained; later mail is retained newest-first under
 * the total cap, and the caller renders the dropped count.
 * @param events - session log.
 * @param maxPerMessage - character cap on each message.
 * @param maxTotal - character cap on the retained mail, excluding the assignment.
 * @returns the assignment, the retained later mail, and the dropped count.
 */
export function foldTeamMessages(
  events: readonly SessionEvent[],
  maxPerMessage: number,
  maxTotal: number,
): WorkerAssignmentFold {
  const all: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'team-message') continue
    const text = userMessageText(event)
    if (text.length === 0) continue
    all.push(boundText(text, maxPerMessage))
  }
  const assignment = all[0]
  if (assignment === undefined) return { assignment: '', mail: [], elided: 0 }
  const rest = all.slice(1)
  let used = 0
  let retained = 0
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const entry = rest[index] as string
    if (used + entry.length > maxTotal) break
    used += entry.length
    retained += 1
  }
  const mail = retained === 0 ? [] : rest.slice(rest.length - retained)
  return { assignment, mail, elided: rest.length - mail.length }
}

/**
 * Fold the latest logged card's charter as one bounded line per entry.
 * @param events - session log.
 * @param maxChars - character cap on each line.
 * @returns the bounded lines, oldest entry first; empty when no card carries a charter.
 */
export function foldWorkerCharter(events: readonly SessionEvent[], maxChars: number): readonly string[] {
  let charter: readonly { readonly id: unknown; readonly constraint: string }[] | undefined
  for (const event of events) {
    if (event.type === 'jspace/card') charter = event.data.charter
  }
  if (charter === undefined) return []
  return charter.map(entry => boundText(String(entry.id) + ': ' + entry.constraint, maxChars))
}

/** Completed step/end events. */
function countSteps(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'step/end') count += 1
  }
  return count
}

/**
 * Resolve a tool/result to its owning call seq, name, success bit, and bounded
 * excerpts, oldest-first within the trailing window.
 * @param events - session log.
 * @param caps - digest caps.
 * @returns the trailing window, oldest-first.
 */
function recentTools(events: readonly SessionEvent[], caps: WorkerDigestCaps): readonly WorkerEscalationToolSignal[] {
  const resultByCall = new Map<string, { ok: boolean; excerpt?: string }>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const parts: string[] = []
    for (const part of block.content) {
      if (part.type === 'text' && part.text.length > 0) parts.push(part.text)
    }
    const ok = block.isError !== true
    const text = parts.join('\n')
    resultByCall.set(String(event.data.message.source.callId), {
      ok,
      ...ok || text.length === 0 ? {} : { excerpt: boundText(text, caps.maxExcerpt) },
    })
  }
  const out: WorkerEscalationToolSignal[] = []
  for (let index = events.length - 1; index >= 0 && out.length < caps.maxTools; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/call') continue
    const callId = String(event.data.callId)
    const result = resultByCall.get(callId)
    if (result === undefined) continue
    const args = argsExcerpt(event.data.arguments, caps.maxArgs)
    out.push({
      seq: event.seq,
      name: event.data.name,
      ok: result.ok,
      ...args === undefined ? {} : { argsExcerpt: args },
      ...result.excerpt === undefined ? {} : { errorExcerpt: result.excerpt },
    })
  }
  return out.reverse()
}

/**
 * Fold a bounded worker digest from one worker session's committed events.
 * @param session - live worker session whose log to fold.
 * @param caps - digest caps.
 * @returns the digest.
 */
export function foldWorkerDigest(session: Session, caps: WorkerDigestCaps): WorkerEscalationDigest {
  const messages = foldTeamMessages(session.events, caps.maxExcerpt, caps.maxChars)
  return {
    sessionId: session.id,
    assignment: messages.assignment,
    mail: messages.mail,
    elidedMail: messages.elided,
    charter: foldWorkerCharter(session.events, caps.maxExcerpt),
    recentTools: recentTools(session.events, caps),
    steps: countSteps(session.events),
    seq: session.seq,
    maxTools: caps.maxTools,
    maxChars: caps.maxChars,
  }
}

/** Render trailing tool signals, oldest-first, one per line. */
function renderToolSignals(signals: readonly WorkerEscalationToolSignal[]): string {
  return signals
    .map((signal) => {
      const args = signal.argsExcerpt === undefined ? '' : ' ' + signal.argsExcerpt
      const fail = signal.ok ? '' : (signal.errorExcerpt === undefined ? '' : ': ' + signal.errorExcerpt)
      return (signal.ok ? 'ok ' : 'FAIL ') + signal.name + ' seq=' + String(signal.seq) + args + fail
    })
    .join('\n')
}

/**
 * Render the digest as the report's input text, bounded to `maxChars`. Order
 * is truncation priority: the session identity, the Lead's assignment, and the
 * charter survive first, and the trailing tool window renders last so the cap
 * eats it first.
 * @param digest - folded digest.
 * @returns the bounded render.
 */
export function renderWorkerDigest(digest: WorkerEscalationDigest): string {
  const lines: string[] = [
    'Worker session id: ' + digest.sessionId,
    'Folded through seq: ' + String(digest.seq),
    digest.assignment.length === 0
      ? "Assignment (the Lead's team message): (none recorded)"
      : "Assignment (the Lead's team message): " + digest.assignment,
  ]
  if (digest.charter.length > 0) lines.push('Charter:\n' + digest.charter.join('\n'))
  if (digest.mail.length > 0) {
    const mail = digest.mail.map((text, index) => 'M' + String(index + 1) + ': ' + text)
    if (digest.elidedMail > 0) mail.splice(0, 0, '(' + String(digest.elidedMail) + ' earlier team messages elided)')
    lines.push('Later team mail:\n' + mail.join('\n'))
  }
  lines.push('Completed steps: ' + String(digest.steps))
  if (digest.recentTools.length > 0) {
    lines.push('Recent tool outcomes:\n' + renderToolSignals(digest.recentTools))
  }
  return boundText(lines.join('\n'), digest.maxChars)
}
