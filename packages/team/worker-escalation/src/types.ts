/**
 * Pure vocabulary of the worker difficulty ladder: the trigger identifiers,
 * the logged decision payload, and the bounded worker digest. Free of runtime
 * factories.
 *
 * @module @shres-code/shres-code-worker-escalation/types
 */

/**
 * Why the ladder engaged on a worker session. A closed union; consumers switch
 * on it and end in `assertNever`.
 */
export type EscalationTrigger =
  | 'errorBurst'
  | 'attemptCount'
  | 'repeatRunLength'
  | 'stepBudgetExhausted'
  | 'turnFailureStreak'

/** What the ladder resolved for one firing trigger. */
export type EscalationChoice =
  /** The worker is told nothing yet; the decision is the log record. */
  | 'continue'
  /** The worker reports itself blocked to the Lead and stops escalating. */
  | 'report-blocked'

/**
 * Which escalation engine answered. Stage 0 is engine-free, so `'absent'` is
 * the only class it writes; a stage that consults a composed judgment engine
 * adds that engine's class here.
 */
export type EscalationEngineClass = 'absent'

/**
 * The aging fold facts one decision records: how many continue resolutions
 * this goal epoch has taken, counting the decision that carries them.
 */
export interface EscalationAging {
  /** Continue resolutions on this goal epoch, including this decision when it chose `continue`. */
  readonly continues: number
  /** Session event seq of the newest continue resolution; absent before the first. */
  readonly lastContinueSeq?: number
}

/**
 * One logged ladder decision: the trigger that woke the ladder, the event that
 * satisfied it, and what the ladder resolved. Stage 3 records its adoption as
 * a separate event; nothing about the decision is executed beyond the
 * `report-blocked` report.
 */
export interface EscalationDecision {
  /** Trigger that fired. */
  readonly trigger: EscalationTrigger
  /** Session event seq of the event satisfying that trigger; the invariant's event pointer. */
  readonly triggerSeq: number
  /** What the ladder resolved. */
  readonly choice: EscalationChoice
  /** Engine class that answered; `'absent'` while no engine is composed. */
  readonly engine: EscalationEngineClass
  /** Aging state this decision records for its goal epoch. */
  readonly aging: EscalationAging
}

/** One trigger's verdict at a fold point. */
export interface EscalationTriggerOutcome {
  /** The trigger this verdict is about. */
  readonly trigger: EscalationTrigger
  /** Whether the trigger is satisfied at the fold point. */
  readonly fired: boolean
  /** Session event seq the trigger fired at; absent when it did not fire. */
  readonly triggerSeq?: number
}

/** One trailing tool signal in the worker digest. */
export interface WorkerEscalationToolSignal {
  /** Worker-session `tool/call` seq this signal came from. */
  readonly seq: number
  /** Tool name. */
  readonly name: string
  /** True when the tool result was not an error. */
  readonly ok: boolean
  /** Bounded path, command, or argument excerpt. */
  readonly argsExcerpt?: string
  /** Bounded error excerpt, present only for failures. */
  readonly errorExcerpt?: string
}

/**
 * Bounded fold of a worker session used to tell the Lead what the worker was
 * doing when it stopped. Reconstructable from the worker's own log alone.
 */
export interface WorkerEscalationDigest {
  /** Worker session id the seqs and tool window belong to. */
  readonly sessionId: string
  /**
   * The Lead's assignment: the first delivered team message's text, bounded;
   * empty when the worker carries none. Human user messages are not an anchor
   * here — a delegated worker has no human in its conversation.
   */
  readonly assignment: string
  /** Later team mail, oldest-first and bounded; the assignment is never in this list. */
  readonly mail: readonly string[]
  /** Count of team messages the retention cap dropped. */
  readonly elidedMail: number
  /** The latest logged card's charter, one bounded line per entry; empty when the card carries none. */
  readonly charter: readonly string[]
  /** Trailing tool signals, oldest-first, capped by `maxDigestTools`. */
  readonly recentTools: readonly WorkerEscalationToolSignal[]
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
     * One worker-escalation ladder decision. Log-only and append-only: the
     * decision records what the ladder resolved for a firing trigger, never a
     * model-visible message of its own. Writers pass `{ ignorable: true }`.
     * @param trigger - trigger that fired.
     * @param triggerSeq - session event seq of the event satisfying it.
     * @param choice - continue, or report blocked to the Lead.
     * @param engine - engine class that answered; `'absent'` while none is composed.
     * @param aging - aging fold state this decision records for its goal epoch.
     */
    'escalation/decision': EscalationDecision
  }
}
