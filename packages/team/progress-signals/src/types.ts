/**
 * Pure vocabulary of the progress-signal folds: the trigger identifiers, one
 * resolved trigger row, one trigger verdict, the numbers-first progress facts,
 * and one trailing tool-window entry. Free of runtime factories.
 *
 * @module @shres-code/shres-code-progress-signals/types
 */

/**
 * A stuck signal a session's log can satisfy. A closed union; consumers switch
 * on it and end in `assertNever`.
 */
export type EscalationTrigger =
  | 'errorBurst'
  | 'attemptCount'
  | 'repeatRunLength'
  | 'stepBudgetExhausted'
  | 'turnFailureStreak'

/** One resolved trigger row: whether the trigger may fire and the count it fires at. */
export interface ResolvedEscalationTrigger {
  /** Whether this trigger may fire. */
  readonly enabled: boolean
  /** The trigger's own firing count, in the trigger's own unit. */
  readonly threshold: number
}

/** Every resolved trigger row, keyed by trigger. Each consumer resolves and validates its own table. */
export type ResolvedEscalationTriggers = Readonly<Record<EscalationTrigger, ResolvedEscalationTrigger>>

/** One trigger's verdict at a fold point. */
export interface EscalationTriggerOutcome {
  /** The trigger this verdict is about. */
  readonly trigger: EscalationTrigger
  /** Whether the trigger is satisfied at the fold point. */
  readonly fired: boolean
  /** Session event seq the trigger fired at; absent when it did not fire. */
  readonly triggerSeq?: number
}

/**
 * Numbers-first progress facts about one session: how its tool calls
 * resolved, the identical-call chain in force, the epoch's distinct failed
 * approaches, and completed steps since the progress floor. The facts are
 * counts only; no excerpt of tool text is part of them.
 */
export interface ProgressFacts {
  /** Tool-sourced results that succeeded, excluding sandbox denials and charter probes. */
  readonly ok: number
  /** Tool-sourced results that failed, excluding sandbox denials and charter probes. */
  readonly fail: number
  /** Length of the identical-call chain in force at the fold point. */
  readonly repeatRunLength: number
  /** Distinct failed approaches since the epoch's progress floor. */
  readonly attemptCount: number
  /** Completed steps since the epoch's progress floor. */
  readonly stepsSinceCheckpoint: number
}

/** One trailing tool call paired with the result that answered it. */
export interface ToolWindowEntry {
  /** `tool/call` event seq. */
  readonly seq: number
  /** Tool name. */
  readonly name: string
  /** True when the result was not an error. */
  readonly ok: boolean
  /** The call's raw `arguments` string, exactly as the model produced it. */
  readonly arguments: string
  /** Joined model-facing text of the result. */
  readonly text: string
}
