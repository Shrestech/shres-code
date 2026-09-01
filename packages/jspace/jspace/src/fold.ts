/**
 * Pure replay fold for J-Space card events.
 *
 * Native events (payload `sessionId` equals the fold owner) apply in `seq`
 * order. Inherited fork-seed events from another session are candidates for
 * copy-on-fork and are not the live card. A regressing native `seq`, a
 * foreign write after a native origin, or a shape failure keeps the last
 * good native snapshot and records a fault.
 *
 * @module @shres-code/shres-code-jspace/fold
 */

import type { SessionEvent } from '@shres-code/shres-code-session'
import { decodeJspaceCharter, formatCharterEntrySummary } from './charter.ts'
import type {
  JspaceCard,
  JspaceCheckedLine,
  JspaceClosed,
  JspaceOpenLine,
  JspaceProjection,
  JspaceSettled,
  JspaceShipped,
} from './types.ts'

/** Fold result including an inherited parent card used only for copy-on-fork. */
export interface JspaceFold extends JspaceProjection {
  /** Last well-formed card from a foreign sessionId in this log, if any. */
  readonly inherited: JspaceCard | null
}

/** Mutable accumulator kept private to the fold. */
interface FoldState {
  card: JspaceCard | null
  closed: boolean
  fault: string | undefined
  lastSeq: number
  nativeStarted: boolean
  inherited: JspaceCard | null
  inheritedClosed: boolean
  seenChecked: Set<number>
  settled: JspaceSettled | undefined
}

/**
 * Build an empty fold accumulator.
 * @returns mutable state with no card.
 */
export function emptyJspaceFoldState(): FoldState {
  return {
    card: null,
    closed: false,
    fault: undefined,
    lastSeq: 0,
    nativeStarted: false,
    inherited: null,
    inheritedClosed: false,
    seenChecked: new Set(),
    settled: undefined,
  }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require a non-empty trimmed string.
 * @param value - candidate.
 * @param field - field name for the error.
 * @returns the string.
 */
function requiredLine(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`jspace ${field} must be a non-empty trimmed string`)
  }
  return value
}

/**
 * Require a positive safe integer.
 * @param value - candidate.
 * @param field - field name for the error.
 * @returns the integer.
 */
function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`jspace ${field} must be a positive safe integer`)
  }
  return value
}

/**
 * Session event seqs start at 0 (`log.length` of the append).
 * @param value - candidate.
 * @param field - field name.
 * @returns the integer.
 */
function sessionEventSeq(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`jspace ${field} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Decode one Checked line.
 * @param value - candidate line.
 * @returns the line.
 */
function decodeChecked(value: unknown): JspaceCheckedLine {
  if (!isRecord(value)) throw new Error('jspace checked line must be a record')
  const n = positiveInt(value['n'], 'checked.n')
  const check = requiredLine(value['check'], 'checked.check')
  const by = requiredLine(value['by'], 'checked.by')
  const evidence = value['evidence']
  if (evidence !== undefined && (typeof evidence !== 'string' || evidence.trim().length === 0)) {
    throw new Error('jspace checked.evidence must be a non-empty string when present')
  }
  const verified = value['verified']
  if (verified !== undefined && verified !== true) {
    throw new Error('jspace checked.verified must be true when present')
  }
  return {
    n,
    check,
    by,
    ...evidence === undefined ? {} : { evidence },
    ...verified === true ? { verified: true as const } : {},
  }
}

/**
 * Decode one Open line.
 * @param value - candidate line.
 * @returns the line.
 */
function decodeOpen(value: unknown): JspaceOpenLine {
  if (!isRecord(value)) throw new Error('jspace open line must be a record')
  const question = requiredLine(value['question'], 'open.question')
  const settles = value['settles']
  if (settles !== undefined && (typeof settles !== 'string' || settles.trim().length === 0)) {
    throw new Error('jspace open.settles must be a non-empty string when present')
  }
  return settles === undefined ? { question } : { question, settles }
}

/**
 * Decode a `jspace/card` payload. Throws on shape failure.
 * @param value - event data.
 * @returns the card.
 */
export function decodeJspaceCard(value: unknown): JspaceCard {
  if (!isRecord(value)) throw new Error('jspace card must be a record')
  const seq = positiveInt(value['seq'], 'seq')
  const sessionId = requiredLine(value['sessionId'], 'sessionId')
  const goal = requiredLine(value['goal'], 'goal')
  if (!Array.isArray(value['core'])) throw new Error('jspace core must be an array')
  if (value['core'].length > 2) throw new Error('jspace core may hold at most two items')
  const core = value['core'].map((item, index) => requiredLine(item, `core[${String(index)}]`))
  if (!Array.isArray(value['checked'])) throw new Error('jspace checked must be an array')
  const checked = value['checked'].map(decodeChecked)
  const seen = new Set<number>()
  for (const line of checked) {
    if (seen.has(line.n)) throw new Error(`jspace checked number ${String(line.n)} is reused`)
    seen.add(line.n)
  }
  if (!Array.isArray(value['open'])) throw new Error('jspace open must be an array')
  const open = value['open'].map(decodeOpen)
  const next = requiredLine(value['next'], 'next')
  const goalOpenedSeq = sessionEventSeq(value['goalOpenedSeq'], 'goalOpenedSeq')
  const charter = decodeJspaceCharter(value['charter'])
  return { seq, sessionId, goal, core, checked, open, next, goalOpenedSeq, charter }
}

/**
 * Decode a `jspace/closed` payload. Throws on shape failure.
 * @param value - event data.
 * @returns the tombstone.
 */
export function decodeJspaceClosed(value: unknown): JspaceClosed {
  if (!isRecord(value)) throw new Error('jspace closed must be a record')
  return {
    seq: positiveInt(value['seq'], 'seq'),
    sessionId: requiredLine(value['sessionId'], 'sessionId'),
  }
}

/**
 * Decode a `jspace/shipped` payload. Throws on shape failure.
 * @param value - event data.
 * @returns the stamp.
 */
export function decodeJspaceShipped(value: unknown): JspaceShipped {
  if (!isRecord(value)) throw new Error('jspace shipped must be a record')
  return {
    sessionId: requiredLine(value['sessionId'], 'sessionId'),
    goal: requiredLine(value['goal'], 'goal'),
    goalOpenedSeq: sessionEventSeq(value['goalOpenedSeq'], 'goalOpenedSeq'),
  }
}

/**
 * Apply one decoded native card.
 * @param state - accumulator.
 * @param card - native card.
 */
function applyNativeCard(state: FoldState, card: JspaceCard): void {
  if (card.seq <= state.lastSeq) {
    state.fault = `jspace seq ${String(card.seq)} regresses last ${String(state.lastSeq)}`
    return
  }
  state.card = card
  state.closed = false
  state.lastSeq = card.seq
  state.nativeStarted = true
  state.seenChecked = new Set(card.checked.map(line => line.n))
  if (state.settled !== undefined && state.settled.goalOpenedSeq !== card.goalOpenedSeq) {
    state.settled = undefined
  }
}

/**
 * Apply one decoded native close.
 * @param state - accumulator.
 * @param closed - tombstone.
 */
function applyNativeClosed(state: FoldState, closed: JspaceClosed): void {
  if (closed.seq <= state.lastSeq) {
    state.fault = `jspace seq ${String(closed.seq)} regresses last ${String(state.lastSeq)}`
    return
  }
  state.card = null
  state.closed = true
  state.lastSeq = closed.seq
  state.nativeStarted = true
  state.seenChecked = new Set()
  state.settled = undefined
}

/**
 * Apply one session event. Shape failures become faults, not throws.
 * @param state - accumulator.
 * @param event - next event.
 * @param ownerSessionId - session whose native card this fold owns.
 */
export function applyJspaceEvent(
  state: FoldState,
  event: SessionEvent,
  ownerSessionId: string,
): void {
  if (event.type !== 'jspace/card' && event.type !== 'jspace/closed' && event.type !== 'jspace/shipped') {
    return
  }
  try {
    if (event.type === 'jspace/shipped') {
      const stamp = decodeJspaceShipped(event.data)
      if (stamp.sessionId !== ownerSessionId) return
      if (state.card === null || stamp.goalOpenedSeq !== state.card.goalOpenedSeq) return
      state.settled = { goal: stamp.goal, goalOpenedSeq: stamp.goalOpenedSeq, seq: event.seq }
      return
    }
    if (event.type === 'jspace/card') {
      const card = decodeJspaceCard(event.data)
      if (card.sessionId !== ownerSessionId) {
        if (state.nativeStarted) {
          state.fault = 'jspace cross-session write after native origin'
          return
        }
        state.inherited = card
        state.inheritedClosed = false
        return
      }
      applyNativeCard(state, card)
      return
    }
    const closed = decodeJspaceClosed(event.data)
    if (closed.sessionId !== ownerSessionId) {
      if (state.nativeStarted) {
        state.fault = 'jspace cross-session write after native origin'
        return
      }
      state.inherited = null
      state.inheritedClosed = true
      return
    }
    applyNativeClosed(state, closed)
  } catch (error) {
    /* v8 ignore next -- decode throws Error */
    const message = error instanceof Error ? error.message : String(error)
    state.fault = message
  }
}

/**
 * Fold jspace state from a session log.
 * @param events - events in sequence order.
 * @param ownerSessionId - session that owns native writes.
 * @returns the projection plus any inherited parent card.
 */
export function foldJspace(
  events: readonly SessionEvent[],
  ownerSessionId: string,
): JspaceFold {
  const state = emptyJspaceFoldState()
  for (const event of events) applyJspaceEvent(state, event, ownerSessionId)
  return {
    card: state.card,
    closed: state.closed,
    inherited: state.inheritedClosed ? null : state.inherited,
    ...state.settled === undefined ? {} : { settled: state.settled },
    ...state.fault === undefined ? {} : { fault: state.fault },
  }
}

/** Last Checked lines reprinted when the prompt Consumer omits an override. */
export const DEFAULT_CHECKED_REPRINT_LIMIT = 5

/** Last Open questions reprinted when the prompt Consumer omits an override. */
export const DEFAULT_OPEN_REPRINT_LIMIT = 5

/**
 * Reprint caps applied only when rendering. The durable card snapshot is
 * unchanged. Callers supply positive integers; the prompt Consumer's Config
 * schema rejects zero and negative values at load.
 */
export interface JspaceCardReprint {
  /** Last Checked lines to print. */
  readonly checkedReprintLimit: number
  /** Last Open questions to print. */
  readonly openReprintLimit: number
}

/**
 * One elision line placed immediately before a truncated Checked section.
 * @param elided - count of earlier Checked lines omitted from the reprint.
 * @returns the elision line.
 */
export function formatJspaceCheckedElision(elided: number): string {
  return `(${String(elided)} earlier Checked lines elided; they remain in the session log and are searchable with the session-query tools)`
}

/**
 * One elision line placed immediately before a truncated Open section.
 * @param elided - count of earlier Open questions omitted from the reprint.
 * @returns the elision line.
 */
export function formatJspaceOpenElision(elided: number): string {
  return `(${String(elided)} earlier Open questions elided; they remain in the session log and are searchable with the session-query tools)`
}

/**
 * Render the card the prompt Consumer reprints. Labels are harness-authored
 * framing and must not come from event content. Checked and Open print the
 * last N / last M items; earlier items stay on the durable snapshot.
 * @param card - native open card.
 * @param reprint - last-N / last-M reprint caps.
 * @returns the section body, with one elision line per truncated section.
 */
export function formatJspaceCard(card: JspaceCard, reprint: JspaceCardReprint): string {
  const core = card.core.length === 0 ? '(none)' : card.core.join('; ')
  const checkedShown = card.checked.slice(-reprint.checkedReprintLimit)
  const checkedElided = card.checked.length - checkedShown.length
  const checked = checkedShown.length === 0
    ? '(none)'
    : checkedShown.map(line => `✓${String(line.n)} ${line.check} — ${line.by}`).join('; ')
  const openShown = card.open.slice(-reprint.openReprintLimit)
  const openElided = card.open.length - openShown.length
  const open = openShown.length === 0
    ? '(none)'
    : openShown.map(line => line.settles === undefined ? line.question : `${line.question} [${line.settles}]`).join('; ')
  const lines = [
    `Goal:      ${card.goal}`,
    `Core:      ${core}`,
  ]
  if (card.charter.length > 0) {
    lines.push(`Charter:    ${card.charter.map(formatCharterEntrySummary).join('; ')}`)
  }
  if (checkedElided > 0) lines.push(formatJspaceCheckedElision(checkedElided))
  lines.push(`Checked:   ${checked}`)
  if (openElided > 0) lines.push(formatJspaceOpenElision(openElided))
  lines.push(`Open:      ${open}`, `Next:      ${card.next}`)
  return lines.join('\n')
}

/**
 * Default English coverage terms: verification-method words a `by` claim uses.
 * Whole-word matching keeps compounds like `test_http_app_target.py` from
 * matching `test`.
 */
export const DEFAULT_COVERAGE_TERMS = [
  'coverage',
  'covered',
  'covering',
  'verifier',
  'verify',
  'verifies',
  'verified',
  'test',
  'tested',
  'tests',
  'unit',
  'checked',
  'check',
  'checks',
  'cases',
  'suite',
  'including',
  'scan',
  'scanned',
  'grep',
  'grepped',
  'read',
  'reads',
  'diff',
  'diffed',
] as const

/** One-line availability notice while enabled and no card is open. */
export const JSPACE_AVAILABLE_LINE
  = 'J-Space is available. Open a card for multi-stage or multi-file work.'

/** Stock Goal for `always-open` and bare `/j-space on`. */
export const JSPACE_ALWAYS_OPEN_GOAL = 'J-Space is on'

/** Stock Next for `always-open` and bare `/j-space on`. */
export const JSPACE_ALWAYS_OPEN_NEXT = 'State the first action'

/**
 * Whether `by` contains a configured coverage term.
 * @param by - checkpoint coverage claim.
 * @param extraTerms - optional extra literals from Config.
 * @returns true when a term is present.
 */
export function matchesCoverageTerms(by: string, extraTerms?: readonly string[]): boolean {
  const terms = extraTerms === undefined
    ? DEFAULT_COVERAGE_TERMS
    : [...DEFAULT_COVERAGE_TERMS, ...extraTerms]
  return terms.some(term => matchesCoverageTerm(by, term))
}

/**
 * Match one coverage term as a whole word, including CJK extra terms.
 * @param by - checkpoint coverage claim.
 * @param term - literal term.
 * @returns true when the term stands alone.
 */
function matchesCoverageTerm(by: string, term: string): boolean {
  const trimmed = term.trim()
  if (trimmed.length === 0) return false
  if (/[A-Za-z0-9]/.test(trimmed)) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu').test(by)
  }
  return by.toLowerCase().includes(trimmed.toLowerCase())
}
