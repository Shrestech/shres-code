/**
 * The judged state of one checked tool call: the call's own facts plus the text
 * its result brought into the session, capped and hash-pinned.
 *
 * One state per checked call, assembled from the session log alone, so a check
 * is reproducible from the log it read: the same call and result under the same
 * caps produce the same text and therefore the same hash. Nothing here reads a
 * clock, a workspace path, or the current time.
 *
 * @module @shres-code/shres-code-judgment-guardrails/state
 */

import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import type { GuardStateCaps } from './config.ts'

/** Tool name recorded for a result whose call is no longer in the log. */
const UNKNOWN_TOOL = 'unknown'

/** Text recorded for a call that carried no arguments. */
const NO_ARGUMENTS = '(none)'

/** Text recorded for a result that carried no text block. */
const NO_TEXT = '(empty)'

/** Marker a capped state ends with, so a reader sees that content was dropped. */
const TRUNCATION_PREFIX = '[truncated: '
const TRUNCATION_SUFFIX = ' chars dropped]'

/** The state one check runs on, with the evidence it was built from. */
export interface GuardStateFacts {
  /** The assembled, capped state text. */
  readonly text: string
  /** Hash of {@link text}, recorded on the decision and never used as a gate. */
  readonly hash: string
  /** Session event seqs the state was assembled from: the call, then its result. */
  readonly seqs: readonly number[]
  /** Characters the state cap dropped, 0 when nothing was dropped. */
  readonly droppedChars: number
}

/**
 * The stable hash recorded on every guard decision: a 32-bit FNV-1a of the state
 * text, rendered as eight hex digits.
 *
 * It is the same function the model-router records its own state hashes with, so
 * a reader can compare hashes across the two packages for identical text; it is
 * restated here because a hash is not a service and neither package owns the
 * other.
 *
 * @param text - the assembled state.
 * @returns eight hex digits.
 */
export function guardStateHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Assemble the one state a checked tool call is judged on.
 *
 * The state names the tool, how the call ended, the call's argument excerpt, and
 * the text the result brought into the session. The caps are hard: the excerpt
 * is cut at `maxArgChars`, and the state never exceeds `maxChars` — content is
 * dropped from the end, and the state then ends with a note naming how many
 * characters it lost.
 *
 * @param session - the session whose log holds the committed call and result.
 * @param result - the committed `tool/result` event being checked.
 * @param caps - the resolved caps to assemble under.
 * @returns the state text, its hash, the seqs it came from, and the dropped count.
 */
export function foldGuardState(
  session: Session,
  result: SessionEvent<'tool/result'>,
  caps: GuardStateCaps,
): GuardStateFacts {
  const call = owningCall(session, result)
  const seqs = call === undefined ? [result.seq] : [call.seq, result.seq]
  const text = capState([
    `tool: ${call?.data.name ?? UNKNOWN_TOOL}`,
    `status: ${resultFailed(result) ? 'error' : 'ok'}`,
    `arguments: ${argumentExcerpt(call?.data.arguments, caps.maxArgChars)}`,
    'result:',
    resultText(result) || NO_TEXT,
  ].join('\n'), caps.maxChars)
  return {
    text: text.text,
    hash: guardStateHash(text.text),
    seqs,
    droppedChars: text.droppedChars,
  }
}

/**
 * The callId one result answers, read from its first block. A \`tool/result\`
 * message is composed by the tool path, which always writes the block this reads.
 */
function resultCallId(result: SessionEvent<'tool/result'>): string {
  return result.data.message.content[0].toolCallId
}

/** Whether any block of one result reports a failure. */
function resultFailed(result: SessionEvent<'tool/result'>): boolean {
  return result.data.message.content.some(block => block.isError === true)
}

/** The text one result brought into the session: its text blocks, joined. */
function resultText(result: SessionEvent<'tool/result'>): string {
  const parts: string[] = []
  for (const block of result.data.message.content) {
    for (const part of block.content) {
      if (part.type === 'text' && part.text.length > 0) parts.push(part.text)
    }
  }
  return parts.join('\n')
}

/**
 * The `tool/call` event one result answers: the newest call with that callId
 * committed before the result, or undefined when the log holds none.
 * @param session - the session holding the log.
 * @param result - the result being checked.
 * @returns the owning call event, when the log carries it.
 */
function owningCall(session: Session, result: SessionEvent<'tool/result'>): SessionEvent<'tool/call'> | undefined {
  const callId = resultCallId(result)
  let owning: SessionEvent<'tool/call'> | undefined
  for (const event of session.events) {
    if (event.type !== 'tool/call' || event.seq >= result.seq) continue
    if (event.data.callId === callId) owning = event
  }
  return owning
}

/**
 * One argument excerpt: whitespace collapsed so formatting cannot move the hash,
 * then cut at the cap.
 * @param args - the call's argument JSON string, or undefined when it carried none.
 * @param maxArgChars - the hard character cap.
 * @returns the excerpt, or a placeholder when the call carried no arguments.
 */
function argumentExcerpt(args: string | undefined, maxArgChars: number): string {
  if (args === undefined) return NO_ARGUMENTS
  const collapsed = args.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return NO_ARGUMENTS
  return collapsed.slice(0, maxArgChars)
}

/**
 * Cap one state text, naming what the cap dropped.
 *
 * The cap is hard even when the note itself would not fit: a state shorter than
 * its own removal note is a bare prefix, which is what a cap that small asked
 * for.
 * @param text - the assembled state.
 * @param maxChars - the hard character cap.
 * @returns the capped text and the number of characters dropped.
 */
function capState(text: string, maxChars: number): { text: string; droppedChars: number } {
  if (text.length <= maxChars) return { text, droppedChars: 0 }
  const droppedChars = text.length - maxChars
  const note = `${TRUNCATION_PREFIX}${String(droppedChars)}${TRUNCATION_SUFFIX}`
  if (note.length >= maxChars) return { text: text.slice(0, maxChars), droppedChars }
  return { text: text.slice(0, maxChars - note.length) + note, droppedChars }
}
