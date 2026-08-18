/**
 * Pure types of the J-Space card: the one home of the `jspace`
 * projection key and the durable payload vocabulary, free of host imports.
 *
 * @module @shres-code/shres-code-jspace/types
 */

/** One append-only Checked line. The tool cannot prove the verifier ran. */
export interface JspaceCheckedLine {
  /** Positive number, never reused on this card. */
  readonly n: number
  /** What was claimed checked. */
  readonly check: string
  /** Named verifier and coverage claim. */
  readonly by: string
  /** Optional session `callId` that exists in the log. Cost-raiser only. */
  readonly evidence?: string
}

/** One unsettled question. */
export interface JspaceOpenLine {
  /** The question still open. */
  readonly question: string
  /** What would settle it, when known. */
  readonly settles?: string
}

/** Whole-card snapshot carried by `jspace/card`. */
export interface JspaceCard {
  /** Card sequence; the fold takes the highest native `seq`. */
  readonly seq: number
  /** Session that authored this snapshot. */
  readonly sessionId: string
  /** What done means. */
  readonly goal: string
  /** At most two live items. */
  readonly core: readonly string[]
  /** Append-only checked lines. */
  readonly checked: readonly JspaceCheckedLine[]
  /** Unsettled questions. */
  readonly open: readonly JspaceOpenLine[]
  /** Single next action. Never empty while the card is open. */
  readonly next: string
  /** Session event seq of the mutation that last set `goal`. */
  readonly goalOpenedSeq: number
}

/** Tombstone carried by `jspace/closed`. */
export interface JspaceClosed {
  /** Card sequence of the close. */
  readonly seq: number
  /** Session that authored the close. */
  readonly sessionId: string
}

/** Folded projection served to the dock and Settings snapshot. */
export interface JspaceProjection {
  /** Current native card, or null when none is open. */
  readonly card: JspaceCard | null
  /** True after a native close with no later native card. */
  readonly closed: boolean
  /** Framing or seq fault, when the fold kept the last good snapshot. */
  readonly fault?: string
}

/** Read-only console payload for Settings. */
export interface JspaceSnapshot {
  /** Session cwd when known. */
  readonly cwd: string | null
  /** Whether a native card is open. */
  readonly open: boolean
  /** True after a native close with no later card. */
  readonly closed: boolean
  /** Checked-line count on the current card, or last card before close. */
  readonly checkpoints: number
  /** Fold fault, when the last good snapshot was kept. */
  readonly fault?: string
}

/** Live seat status. */
export interface JspaceStatus {
  /** True only while Settings `enabled` is true. */
  readonly active: boolean
  /** Why the seat is active or not. */
  readonly reason: 'active' | 'disabled'
}

declare module '@shres-code/shres-code-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's native J-Space card, or `null` before the first open
     * and after a close tombstone. Inherited parent-seed events are not this
     * value; copy-on-fork writes a native snapshot first.
     */
    jspace: JspaceProjection
  }
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Whole J-Space card. Log-only. Writers pass `{ ignorable: true }`.
     * @param seq - monotonic card sequence for this session.
     * @param sessionId - writing session id.
     * @param goal - done-means line.
     * @param core - at most two live items.
     * @param checked - append-only checked lines.
     * @param open - unsettled questions.
     * @param next - single next action.
     * @param goalOpenedSeq - session event seq that last set `goal`.
     */
    'jspace/card': JspaceCard
    /**
     * J-Space close tombstone. Log-only. Writers pass `{ ignorable: true }`.
     * @param seq - monotonic card sequence for this session.
     * @param sessionId - writing session id.
     */
    'jspace/closed': JspaceClosed
  }
}
