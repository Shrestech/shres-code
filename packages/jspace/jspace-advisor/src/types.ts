/**
 * Pure types of the jspace background advisor: the logged advice event, the
 * advisory digest, and the trigger vocabulary. Free of runtime factories.
 *
 * @module @shres-code/shres-code-jspace-advisor/types
 */

import type { SessionId } from '@shres-code/shres-code-session'

/**
 * Why a proactive review ran. A closed union; consumers switch on it and end
 * in `assertNever`.
 */
export type AdvisorTrigger =
  | 'charter-fail'
  | 'error-burst'
  | 'goal-epoch'
  | 'ship-attempt'
  | 'drift-check'

/** One reviewer-produced verdict surfaced for the main session. */
export interface JspaceAdvisorAdvice {
  /** Session that authored the advice; filters forked logs from resurrecting it. */
  readonly sessionId: string
  /** The reviewer child that produced the advice. */
  readonly childId: SessionId
  /** Why the review ran. */
  readonly trigger: AdvisorTrigger
  /** Session event seq of the triggering event; the invariant's event pointer. */
  readonly triggerSeq: number
  /** Whether the reviewer judges the session to be serving the user's goal. */
  readonly verdict: 'on-track' | 'drift'
  /** Bounded reviewer advice text. */
  readonly advice: string
  /** Concrete redirect back to the user's goal; present only on drift when the reviewer gave one. */
  readonly redirect?: string
  /** Session event seq the review folded against. */
  readonly seq: number
}

/** One trailing tool signal in the advisory digest. */
export interface JspaceAdvisorToolSignal {
  /** Tool name. */
  readonly name: string
  /** True when the tool result was not an error. */
  readonly ok: boolean
  /** Bounded error excerpt, present only for failures. */
  readonly errorExcerpt?: string
}

/** Bounded fold of a parent session used to seed one reviewer run. */
export interface JspaceAdvisorDigest {
  /** Rendered open card — the session's own claim — or `null` when none is open. */
  readonly card: string | null
  /**
   * Every source-'user' message, oldest-first and bounded. This is the goal
   * ground truth: the first message (the session's goal statement) is always
   * retained, and `elidedUserMessages` counts what the total cap dropped.
   */
  readonly userMessages: readonly string[]
  /** Count of user messages the history cap dropped between the first and the retained suffix. */
  readonly elidedUserMessages: number
  /** Trailing tool signals, oldest-first, capped by `maxDigestTools`. */
  readonly recentTools: readonly JspaceAdvisorToolSignal[]
  /** Completed step count at fold time. */
  readonly steps: number
  /** Session event seq the fold read through. */
  readonly seq: number
  /** Item cap applied to `recentTools`. */
  readonly maxTools: number
  /** Character cap applied to the complete render. */
  readonly maxChars: number
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Reviewer verdict surfaced for the main session. Log-only. Writers pass
     * `{ ignorable: true }`.
     * @param sessionId - session that authored the advice.
     * @param childId - the reviewer child that produced it.
     * @param trigger - why the review ran.
     * @param triggerSeq - session event seq of the triggering event.
     * @param verdict - whether the session is serving the user's goal.
     * @param advice - bounded reviewer advice text.
     * @param redirect - concrete redirect back to the user's goal, on drift.
     * @param seq - session event seq the review folded against.
     */
    'jspace/advisor': JspaceAdvisorAdvice
  }
}
