/**
 * Pure vocabulary of the guardrails observer: what one checked tool call
 * resolved, and the ONE home of the `guard/decision` session-event
 * declaration. Free of the host plugin, the state assembly, and the judgment
 * imports.
 *
 * @module @shres-code/shres-code-judgment-guardrails/types
 */

/**
 * What one checked tool call resolved. Neither member is a verdict: this
 * package has no threshold, so an `observed` decision records what the engine
 * said and a `degraded` one records why nothing was read.
 */
export type GuardOutcome =
  /** The engine answered both questions about this call's input. */
  | 'observed'
  /** The consult could not read both answers; `reason` names the class. */
  | 'degraded'

/**
 * Why one check resolved that way. Each class is its own reason because the
 * classes fail differently: an absent engine is a composition gap, a disabled
 * one is the deployment's own switch, and an unusable answer is the provider's
 * defect.
 */
export type GuardReason =
  /** The engine answered both questions. */
  | 'answered'
  /** No judgment engine is composed. */
  | 'engine-absent'
  /** An engine is composed and the Definition's `judgment` settings section reads `enabled: false`. */
  | 'engine-disabled'
  /** The ask threw: an unreachable engine, a refusal, an aborted or timed-out ask. */
  | 'engine-unavailable'
  /** An answer was missing, of another kind, or of a question this check did not ask. */
  | 'invalid-answer'

/**
 * The noul answer one check read: the vendor's probability that the input
 * attempts to override instructions or act against the user's interest. The
 * seam's binary answer carries no confidence, so a probability is all there is.
 */
export interface GuardInjectionAnswer {
  /** Probability of the question's positive side, 0 through 1. */
  readonly probability: number
}

/** The severity answer one check read, over the configured levels. */
export interface GuardSeverityAnswer {
  /** Probability-weighted score over `severityLevels`, lowest level first. */
  readonly score: number
  /** Confidence the engine reported for that score, 0 through 1. */
  readonly confidence: number
}

/**
 * One logged guardrails decision for one checked tool call. Log-only and
 * append-only: the check reads a committed call's input, records what the
 * judgment engine answered about it, and changes nothing about the call, the
 * session, or any request.
 */
export interface GuardDecision {
  /** What this check resolved. */
  readonly outcome: GuardOutcome
  /** Why it resolved that way. */
  readonly reason: GuardReason
  /**
   * Hash of the state the judgment read, recorded so a rerun of the same input
   * is recognizable. It never gates anything: no threshold exists here.
   */
  readonly stateHash: string
  /** Session event seqs the state was assembled from: the call and its result. */
  readonly stateSeqs: readonly number[]
  /** The injection answer, present exactly when an engine answered. */
  readonly injection?: GuardInjectionAnswer
  /** The severity answer, present exactly when an engine answered. */
  readonly severity?: GuardSeverityAnswer
  /** Engine that answered, when one did. */
  readonly engine?: string
  /** Exact model that answered, when one did. */
  readonly model?: string
  /** Duration of the judgment call in milliseconds, when one was made. */
  readonly latencyMs?: number
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * One guardrails check of one committed tool call. Log-only and
     * append-only: the observer reads the call's input, asks the judgment engine
     * about it, and records the answer. Nothing is blocked, rewritten, or
     * surfaced to a model, and the event carries no verdict — the operating
     * points of any acting rung are deliberately absent until a labeled set says
     * what they should be. Writers pass `{ ignorable: true }`.
     * @param outcome - observed when both answers were read, degraded otherwise.
     * @param reason - why this check resolved the way it did.
     * @param stateHash - hash of the state the judgment read, never a gate.
     * @param stateSeqs - session event seqs the state was assembled from.
     * @param injection - the noul answer's probability, where an engine answered.
     * @param severity - the score answer's score and confidence, where an engine answered.
     * @param engine - engine that answered, where one did.
     * @param model - exact model that answered, where one did.
     * @param latencyMs - duration of the judgment call, where one was made.
     */
    'guard/decision': GuardDecision
  }
}
