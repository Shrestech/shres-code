/**
 * Pure vocabulary of the worker difficulty ladder: the logged decision payload
 * and the bounded worker digest. The trigger identifiers come from
 * `@shres-code/shres-code-progress-signals`, which owns the folds that fire
 * them. Free of runtime factories.
 *
 * @module @shres-code/shres-code-worker-escalation/types
 */

import type { EscalationTrigger } from '@shres-code/shres-code-progress-signals'

/**
 * What one decision resolved: the ladder's own resolution, or the option the
 * Stage 1 ask chose where its answer passed the gate.
 */
export type EscalationChoice =
  /** The worker is told nothing yet; the decision is the log record. */
  | 'continue'
  /**
   * The ask chose needs-help and passed both gates. Stage 1 logs it and
   * executes nothing, so it is a continue resolution for `maxContinues`.
   */
  | 'needs-help'
  /** The worker reports itself blocked to the Lead and stops escalating. */
  | 'report-blocked'

/**
 * Which escalation engine answered one decision, or why no answer reached it.
 * `'ok'` is the only class an answer carries; the other four are the classes a
 * Stage 1 ask degrades through, and every one of them degrades to `continue`.
 */
export type EscalationEngineClass =
  /** The engine answered. */
  | 'ok'
  /** The engine could not be reached, refused the ask, or did not answer in time. */
  | 'unavailable'
  /** The engine answered with a body this ladder could not use. */
  | 'invalid-answer'
  /** No judgment engine is composed. */
  | 'absent'
  /** A judgment engine is composed and the deployment turned it off. */
  | 'disabled'

/**
 * Why the Stage 1 consult resolved one firing trigger. Each class is its own
 * reason because the classes fail differently: an absent engine is a
 * composition gap, a below-threshold answer is a judgment an operator tunes
 * against a labeled set, and an unusable answer is the engine's own defect.
 */
export type EscalationConsultReason =
  /** The answer named one of the question's own options and both gates passed. */
  | 'gate-passed'
  /** The answer's confidence is below the configured `confidence` gate. */
  | 'low-confidence'
  /** The answer's top-two probability margin is below the configured `margin` gate. */
  | 'thin-margin'
  /** No judgment engine is composed. */
  | 'engine-absent'
  /** A judgment engine is composed and the deployment turned it off. */
  | 'engine-disabled'
  /** The engine could not be reached, refused the ask, or did not answer in time. */
  | 'engine-unavailable'
  /** The answer was missing, of another kind, or named an option the question does not carry. */
  | 'invalid-answer'

/**
 * Why one decision resolved the way it did: the consult's own class, or the
 * rule the deterministic terminal resolved on.
 */
export type EscalationDecisionReason =
  | EscalationConsultReason
  /** The goal epoch reached `maxContinues`, so the ladder reported the worker blocked without consulting an engine. */
  | 'max-continues'

/**
 * The two options the ask-to-escalate offers the human. A closed union;
 * consumers switch on it and end in `assertNever`. Neither option is executed:
 * the chosen one is logged, and the report-blocked terminal stays the ladder's
 * one action.
 */
export type EscalationAskOption =
  /** The human chose to escalate this worker to the Lead now. */
  | 'escalate'
  /** The human chose to let this worker keep working. */
  | 'keep-working'

/**
 * Why the ask-to-escalate resolved one firing trigger the way it did. Each
 * class is its own reason because the classes fail differently: an absent seam
 * is a composition gap, a refused asker is the seam's own verdict that no session
 * this ladder could ask as has a human answerer, and an unusable answer is the
 * provider's defect.
 */
export type EscalationAskReason =
  /** The human chose one of the two options. */
  | 'answered'
  /** No user-questions service is composed. */
  | 'seam-absent'
  /** The session has no live Agent to ask on behalf of. */
  | 'agent-absent'
  /**
   * The seam refused the asker: the worker is owned by another live agent and no
   * live Team root was resolved to ask as, so no admitted session carries it.
   */
  | 'delegated-caller'
  /** The ask threw for any other reason: no provider, an aborted ask, or a provider failure. */
  | 'seam-unavailable'
  /** The answer named neither option, more than one, custom text, or a question this ladder did not ask. */
  | 'invalid-answer'

/**
 * What one ask-to-escalate resolved. Present on a decision only while
 * `askToEscalate` is on and the decision is not the terminal, which asks
 * nothing because it already reports to the Lead.
 */
export interface EscalationAskOutcome {
  /** Why the ask resolved this way. */
  readonly reason: EscalationAskReason
  /** The option the human chose; present exactly when `reason` is `answered`. */
  readonly option?: EscalationAskOption
}

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
 * `report-blocked` report, so a `needs-help` choice is a record and nothing more.
 */
export interface EscalationDecision {
  /** Trigger that fired. */
  readonly trigger: EscalationTrigger
  /** Session event seq of the event satisfying that trigger; the invariant's event pointer. */
  readonly triggerSeq: number
  /** What the ladder resolved, or the option the ask chose where its answer passed the gate. */
  readonly choice: EscalationChoice
  /**
   * Engine class that answered, or the class of the consult that could not
   * answer. Absent only for the deterministic terminal, whose `max-continues`
   * rule resolves before any consult runs.
   */
  readonly engine?: EscalationEngineClass
  /** Why this decision resolved the way it did. */
  readonly reason: EscalationDecisionReason
  /** Confidence the ask reported; present only where an engine answered. */
  readonly confidence?: number
  /** Top-two probability margin of the answer's distribution; present only where an engine answered. */
  readonly margin?: number
  /**
   * What the ask-to-escalate resolved. Present only while `askToEscalate` is
   * on and this decision is not the terminal; the chosen option is a record
   * and nothing is executed on it.
   */
  readonly ask?: EscalationAskOutcome
  /** Aging state this decision records for its goal epoch. */
  readonly aging: EscalationAging
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
     * @param choice - continue, the ask's needs-help option where its answer passed the gate, or report blocked to the Lead.
     * @param engine - engine class that answered or could not; absent for the deterministic terminal, which consults nothing.
     * @param reason - why this decision resolved the way it did.
     * @param confidence - confidence the ask reported, where an engine answered.
     * @param margin - top-two probability margin of the answer's distribution, where an engine answered.
     * @param ask - what the ask-to-escalate resolved, where `askToEscalate` is on and the decision is not the terminal.
     * @param aging - aging fold state this decision records for its goal epoch.
     */
    'escalation/decision': EscalationDecision
  }
}
