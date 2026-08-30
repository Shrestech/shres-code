/**
 * Pure types of the jspace background advisor: the logged advice event, the
 * advisory digest, and the trigger vocabulary. Free of runtime factories.
 *
 * @module @shres-code/shres-code-jspace-advisor/types
 */

import type { SessionId } from '@shres-code/shres-code-session'

/**
 * Why a proactive review ran. A closed union; the fold switches on it and ends
 * in `assertNever`.
 */
export type AdvisorTrigger =
  | 'charter-fail'
  | 'error-burst'
  | 'goal-epoch'
  | 'ship-attempt'

/** One reviewer-produced piece of advice surfaced for the main session. */
export interface JspaceAdvisorAdvice {
  /** Session that authored the advice; filters forked logs from resurrecting it. */
  readonly sessionId: string
  /** The reviewer child that produced the advice. */
  readonly childId: SessionId
  /** Why the review ran. */
  readonly trigger: AdvisorTrigger
  /** Bounded reviewer advice text. */
  readonly advice: string
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

/** Bounded fold of a parent session used to seed or adjust the reviewer child. */
export interface JspaceAdvisorDigest {
  /** Rendered open card, or `null` when none is open. */
  readonly card: string | null
  /** Trailing tool signals, oldest-first, capped by `maxDigestTools`. */
  readonly recentTools: readonly JspaceAdvisorToolSignal[]
  /** Latest human user text, bounded. */
  readonly userIntent: string
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
     * Reviewer advice surfaced for the main session. Log-only. Writers pass
     * `{ ignorable: true }`.
     * @param sessionId - session that authored the advice.
     * @param childId - the reviewer child that produced it.
     * @param trigger - why the review ran.
     * @param advice - bounded reviewer advice text.
     * @param seq - session event seq the review folded against.
     */
    'jspace/advisor': JspaceAdvisorAdvice
  }
}
