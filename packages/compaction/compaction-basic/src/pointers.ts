/**
 * Code-assembled seq pointers into the lossless log for a compaction summary.
 *
 * Pointers are model-followed cues, not harness auto-dereference: each line
 * names what the shadowed event holds and how to read it with
 * `session_event_read` against the current session. They ride in
 * `compaction/summary` content and the replacement checkpoint, never on the
 * J-Space card.
 *
 * @module @shres-code/shres-code-compaction-basic/pointers
 */

import { isCompactCheckpointSource } from '@shres-code/shres-code-compaction'
import type { ContentBlock } from '@shres-code/shres-code-llm'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'

/** Markdown heading for the pointer section appended to a summary. */
export const POINTER_SECTION_HEADING = '## Recoverable originals'

/** Cue that names the exact tool and current-session targeting. */
export const POINTER_READ_CUE = 'session_event_read this session, seq'

/** One selected elided surface node the model can dereference. */
export interface ElisionPointer {
  /** Log seq of the shadowed surface event. */
  readonly seq: number
  /** Terse subject naming what that seq holds. */
  readonly subject: string
}

/**
 * Format one pointer line.
 * @param pointer - selected seq and subject.
 * @returns a single markdown bullet the model can follow.
 */
export function formatElisionPointerLine(pointer: ElisionPointer): string {
  return `- ${pointer.subject} at seq ${pointer.seq} — ${POINTER_READ_CUE} ${pointer.seq}`
}

/**
 * Select up to `maxPointers` salient seqs from a shadowed surface span.
 * Tool results rank first (full output), then user messages (including prior
 * checkpoints), then assistant messages only when the span has neither.
 * @param session - session whose log still holds the shadowed events.
 * @param shadowedSeqs - surface-node seqs, in surface order, being replaced.
 * @param maxPointers - maximum number of pointer lines; `0` selects none.
 * @returns selected pointers in the rank-then-chronological order they emit.
 */
export function selectElisionPointers(
  session: Session,
  shadowedSeqs: readonly number[],
  maxPointers: number,
): ElisionPointer[] {
  if (maxPointers <= 0 || shadowedSeqs.length === 0) return []

  const toolPointers: ElisionPointer[] = []
  const userPointers: ElisionPointer[] = []
  const assistantPointers: ElisionPointer[] = []
  for (const seq of shadowedSeqs) {
    const event = session.events[seq]
    if (event === undefined) continue
    switch (event.type) {
      case 'tool/result':
        toolPointers.push({
          seq,
          subject: `full output of ${toolNameForResult(session, event)}`,
        })
        break
      case 'user/message':
        userPointers.push({
          seq,
          subject: isCompactCheckpointSource(event.data.source)
            ? 'prior checkpoint'
            : 'user message',
        })
        break
      case 'assistant/message':
        assistantPointers.push({ seq, subject: 'assistant message' })
        break
      default:
        break
    }
  }

  const preferred = [...toolPointers, ...userPointers]
  const ranked = preferred.length > 0 ? preferred : assistantPointers
  return ranked.slice(0, maxPointers)
}

/**
 * Append a pointer section to a summary, or return a shallow copy when none
 * apply. The returned array is always detached from `summary`.
 * @param summary - safe text blocks from the summarizer.
 * @param session - session whose log still holds the shadowed events.
 * @param shadowedSeqs - surface-node seqs, in surface order, being replaced.
 * @param maxPointers - maximum number of pointer lines; `0` appends nothing.
 * @returns summary blocks plus an optional pointer text block.
 */
export function attachElisionPointers(
  summary: readonly ContentBlock[],
  session: Session,
  shadowedSeqs: readonly number[],
  maxPointers: number,
): ContentBlock[] {
  return withPointerSection(summary, selectElisionPointers(session, shadowedSeqs, maxPointers))
}

/**
 * Attach as many leading pointers as still leave the framed checkpoint
 * strictly smaller than `budget`. Pointers are dropped from the least-salient
 * end first; all of them are omitted when even one would not shrink.
 * @param summary - safe text blocks from the summarizer.
 * @param session - session whose log still holds the shadowed events.
 * @param shadowedSeqs - surface-node seqs, in surface order, being replaced.
 * @param maxPointers - maximum number of pointer lines; `0` appends nothing.
 * @param estimate - framed-checkpoint token count for a candidate summary.
 * @param budget - exclusive upper bound (`shadowedTokenCount`).
 * @returns summary blocks plus an optional pointer text block that fits.
 */
export function attachElisionPointersWithinBudget(
  summary: readonly ContentBlock[],
  session: Session,
  shadowedSeqs: readonly number[],
  maxPointers: number,
  estimate: (blocks: readonly ContentBlock[]) => number,
  budget: number,
): ContentBlock[] {
  const pointers = selectElisionPointers(session, shadowedSeqs, maxPointers)
  const base = [...summary]
  for (let count = pointers.length; count >= 1; count -= 1) {
    const candidate = withPointerSection(base, pointers.slice(0, count))
    if (estimate(candidate) < budget) return candidate
  }
  return base
}

/** Append the pointer section when `pointers` is non-empty. */
function withPointerSection(
  summary: readonly ContentBlock[],
  pointers: readonly ElisionPointer[],
): ContentBlock[] {
  const detached = [...summary]
  if (pointers.length === 0) return detached
  detached.push({
    type: 'text',
    text: `\n\n${POINTER_SECTION_HEADING}\n${pointers.map(formatElisionPointerLine).join('\n')}`,
  })
  return detached
}

/** Resolve the tool name for a result from its cited or preceding `tool/call`. */
function toolNameForResult(
  session: Session,
  event: SessionEvent<'tool/result'>,
): string {
  const callId = event.data.message.source.callId
  const cited = event.sourceEventSeqs ?? []
  for (const seq of cited) {
    const found = namedCall(session.events[seq], callId)
    if (found !== undefined) return found
  }
  for (let seq = event.seq - 1; seq >= 0; seq -= 1) {
    const found = namedCall(session.events[seq], callId)
    if (found !== undefined) return found
  }
  /* v8 ignore next -- a well-formed log always has the matching tool/call before its result. */
  return 'tool'
}

/** Return the tool name when `event` is the matching `tool/call`. */
function namedCall(
  event: SessionEvent | undefined,
  callId: SessionEvent<'tool/result'>['data']['message']['source']['callId'],
): string | undefined {
  if (event?.type === 'tool/call' && event.data.callId === callId) return event.data.name
  return undefined
}
