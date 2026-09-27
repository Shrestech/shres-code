/**
 * Assemble the bounded, model-visible state used by the routing judgment.
 *
 * The session surface is the source of truth here.  Reading the raw event log
 * would put messages shadowed by compaction back into the state and would also
 * expose stream/replay records which never reached the model.
 *
 * @module @shres-code/shres-code-model-router/state
 */

import type { Message, ContentBlock } from '@shres-code/shres-code-llm'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { deriveEventMessage, foldSurface } from '@shres-code/shres-code-session'

/** The assembled judgment state and the surface records that supplied it. */
export interface RoutingState {
  /** JSON text sent to the judgment. */
  text: string
  /** Surface event sequences whose rendered messages are present in `text`. */
  seqs: number[]
  /** Surface event sequences omitted by the context window or character cap. */
  omittedSeqs: number[]
  /** Whether the latest user message could not fit as one complete entry. */
  oversizedCurrent: boolean
}

/** One JSON-safe visible block in a routing-state message. */
type RenderedBlock =
  | { type: 'text'; text: string }
  | { type: 'image' }
  | { type: 'unsupported'; kind: string }
  | { type: 'tool-call'; name: string; arguments: string }
  | { type: 'tool-result'; status: 'success' | 'error'; content: RenderedBlock[] }
  | {
    type: 'hosted-tool-call'
    kind: string
    name?: string
    /** Absent when the provider or adapter reported no completion state. */
    status?: 'completed' | 'failed'
    results?: Array<{ title?: string; url?: string; snippet?: string }>
  }

/** One JSON-safe message in routing state. */
interface RenderedMessage {
  seq: number
  role: Message['role']
  source: string
  content: RenderedBlock[]
}

/** The non-message array item that makes omitted context visible to the judge. */
interface OmissionMarker {
  type: 'omitted'
  count: number
}

type StateItem = RenderedMessage | OmissionMarker

/** A live surface event paired with the message it derives to. */
interface SurfaceEntry {
  seq: number
  eventType: SessionEvent['type']
  message: Message
  rendered: RenderedMessage
}

/**
 * Render visible content without carrying provider identity, message ids, or
 * replay state into a routing judgment.
 *
 * @param block - one provider-neutral content block.
 * @returns the JSON-safe projection, an unsupported-type marker for unknown
 * extensions, or `undefined` for reasoning.
 */
function renderBlock(block: ContentBlock): RenderedBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return undefined
    case 'image':
      return { type: 'image' }
    case 'tool-call':
      return { type: 'tool-call', name: block.name, arguments: block.arguments }
    case 'tool-result':
      return {
        type: 'tool-result',
        status: block.isError === true ? 'error' : 'success',
        content: renderBlocks(block.content),
      }
    case 'server-tool-call':
      return {
        type: 'hosted-tool-call',
        kind: block.kind,
        ...block.name === undefined ? {} : { name: block.name },
        ...block.status === undefined ? {} : { status: block.status },
        ...block.results === undefined ? {} : {
          results: block.results.map(result => ({
            ...result.title === undefined ? {} : { title: result.title },
            ...result.url === undefined ? {} : { url: result.url },
            ...result.snippet === undefined ? {} : { snippet: result.snippet },
          })),
        },
      }
    default:
      // ContentBlockMap is merge-extensible.  Preserve the type marker without
      // copying an extension's provider-specific payload into the judgment.
      return { type: 'unsupported', kind: (block as unknown as { type: string }).type }
  }
}

/**
 * Render all visible blocks in their source order.
 * @param blocks - message or nested tool-result blocks.
 * @returns visible blocks and unsupported-type markers, excluding reasoning.
 */
function renderBlocks(blocks: readonly ContentBlock[]): RenderedBlock[] {
  return blocks.flatMap((block) => {
    const rendered = renderBlock(block)
    return rendered === undefined ? [] : [rendered]
  })
}

/**
 * Render one derived message with its source sequence and semantic source kind.
 * @param seq - surface event sequence.
 * @param message - message derived from that surface event.
 * @returns the JSON-safe message projection.
 */
function renderMessage(seq: number, message: Message): RenderedMessage {
  return {
    seq,
    role: message.role,
    source: message.source.kind,
    content: renderBlocks(message.content),
  }
}

/** Serialize selected entries and, when needed, the omission marker. */
function serialize(
  entries: readonly SurfaceEntry[],
  selected: ReadonlySet<number>,
  omittedCount: number,
): string {
  const items: StateItem[] = []
  for (const [index, entry] of entries.entries()) {
    if (selected.has(index)) items.push(entry.rendered)
  }
  if (omittedCount > 0) items.push({ type: 'omitted', count: omittedCount })
  return JSON.stringify(items)
}

/** Return the surface sequence numbers not represented by selected entries. */
function omittedSequences(entries: readonly SurfaceEntry[], selected: ReadonlySet<number>): number[] {
  return entries.flatMap((entry, index) => selected.has(index) ? [] : [entry.seq])
}

/**
 * Resolve the context start for a non-empty user-message index list.
 * @param userIndexes - indexes of user-message entries in the surface.
 * @param contextTurns - number of prior user-message turns to retain.
 * @returns the first entry index in the selected context window.
 */
function contextStartIndex(userIndexes: readonly number[], contextTurns: number): number {
  const index = Math.max(0, userIndexes.length - (contextTurns + 1))
  const start = userIndexes[index]
  /* v8 ignore next 2 -- currentIndex is read from this non-empty userIndexes array. */
  if (start === undefined) {
    throw new Error('routing state context start invariant violated')
  }
  return start
}

/**
 * Assemble a bounded JSON state from the live model-visible session surface.
 *
 * The most recent `contextTurns + 1` user-authored message nodes establish the
 * candidate window.  Assistant and tool nodes between those user nodes remain
 * candidates, so a `continue` message keeps the evidence that led to it.  The
 * newest candidate entries are packed first; the final JSON is chronological.
 * Every entry is whole, and the omission marker is included in the size check.
 *
 * @param session - live session whose surface is being judged.
 * @param config - resolved context window and complete JSON character cap.
 * @returns the bounded state, included source sequences, and omissions.
 */
export function buildRoutingState(
  session: Session,
  config: { contextTurns: number; maxChars: number },
): RoutingState {
  return assembleRoutingStates(session.events, session.surface.nodes, config, 1)[0]
}

/**
 * Offer progressively shorter complete context alternatives for exact token fitting.
 * Older entries are removed first. The last alternative retains the current
 * user entry, or the latest entry when the surface has no user message.
 * @param session - live session whose surface supplies the entries.
 * @param config - character budget, context window, and maximum alternatives (at least two).
 * @returns most context first, with complete selected and omitted sequence lists.
 */
export function buildRoutingStateCandidates(
  session: Session,
  config: { contextTurns: number; maxChars: number; maxFitCandidates: number },
): [RoutingState, ...RoutingState[]] {
  return assembleRoutingStates(session.events, session.surface.nodes, config, config.maxFitCandidates)
}

/**
 * The same alternatives as {@link buildRoutingStateCandidates}, assembled from
 * a log prefix via the public surface fold (no live Session required).
 * @param events - the session-event prefix to fold.
 * @param config - character budget, context window, and maximum alternatives.
 * @returns most context first, with complete selected and omitted sequence lists.
 */
export function buildRoutingStateCandidatesFromEvents(
  events: readonly SessionEvent[],
  config: { contextTurns: number; maxChars: number; maxFitCandidates: number },
): [RoutingState, ...RoutingState[]] {
  return assembleRoutingStates(events, foldSurface(events).nodes, config, config.maxFitCandidates)
}

/** Assemble a nonempty ordered list from the same live surface snapshot. */
function assembleRoutingStates(
  events: readonly SessionEvent[],
  nodes: readonly number[],
  config: { contextTurns: number; maxChars: number },
  maxCandidates: number,
): [RoutingState, ...RoutingState[]] {
  const entries: SurfaceEntry[] = []
  for (const seq of nodes) {
    const event = events[seq]
    /* v8 ignore next -- Session keeps every live surface node resident. */
    if (event === undefined) throw new Error(`session surface node seq ${seq} is not resident`)
    const message = deriveEventMessage(event)
    if (message === null) continue
    entries.push({ seq, eventType: event.type, message, rendered: renderMessage(seq, message) })
  }

  if (entries.length === 0) {
    const text = '[]'
    return text.length <= config.maxChars
      ? [{ text, seqs: [], omittedSeqs: [], oversizedCurrent: false }]
      : [{ text: '', seqs: [], omittedSeqs: [], oversizedCurrent: true }]
  }

  const userIndexes = entries.flatMap((entry, index) =>
    entry.eventType === 'user/message' && entry.message.source.kind === 'user' ? [index] : [])
  const currentIndex = userIndexes.at(-1)
  const windowStart = currentIndex === undefined
    ? 0
    : contextStartIndex(userIndexes, config.contextTurns)
  const candidates = entries.slice(windowStart)
  const candidateOffset = windowStart
  const selected = new Set<number>()
  const allCount = entries.length

  if (currentIndex !== undefined) {
    selected.add(currentIndex)
    const currentText = serialize(entries, selected, allCount - selected.size)
    if (currentText.length > config.maxChars) {
      return [{
        text: '',
        seqs: [],
        omittedSeqs: entries.map(entry => entry.seq),
        oversizedCurrent: true,
      }]
    }
  }

  for (let index = candidates.length - 1; index >= 0; index--) {
    const absoluteIndex = candidateOffset + index
    if (selected.has(absoluteIndex)) continue
    const tentative = new Set(selected)
    tentative.add(absoluteIndex)
    const text = serialize(entries, tentative, allCount - tentative.size)
    if (text.length > config.maxChars) continue
    selected.add(absoluteIndex)
  }

  const omittedSeqs = omittedSequences(entries, selected)
  const text = serialize(entries, selected, omittedSeqs.length)
  if (text.length > config.maxChars && currentIndex === undefined) {
    return [{ text: '', seqs: [], omittedSeqs, oversizedCurrent: true }]
  }
  const first: RoutingState = {
    text,
    seqs: entries.flatMap((entry, index) => selected.has(index) ? [entry.seq] : []),
    omittedSeqs,
    oversizedCurrent: false,
  }
  const states: [RoutingState, ...RoutingState[]] = [first]
  const required = currentIndex ?? [...selected].sort((a, b) => a - b).at(-1)
  const removable = [...selected].filter(index => index !== required).sort((a, b) => a - b)
  const count = Math.min(maxCandidates, removable.length + 1)
  for (let alternative = 1; alternative < count; alternative++) {
    const dropCount = Math.ceil(removable.length * alternative / (count - 1))
    const retained = new Set(selected)
    for (const index of removable.slice(0, dropCount)) retained.delete(index)
    const omittedSeqs = omittedSequences(entries, retained)
    states.push({
      text: serialize(entries, retained, omittedSeqs.length),
      seqs: entries.flatMap((entry, index) => retained.has(index) ? [entry.seq] : []),
      omittedSeqs,
      oversizedCurrent: false,
    })
  }
  return states
}
