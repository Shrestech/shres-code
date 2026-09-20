/**
 * Pure types of the model-routing domain: the routing vocabulary, the two
 * logged session events, and the ONE home of the `modelRouting` projection-key
 * declaration. Free of the host-side service, tools, and judgment imports, so
 * both the host namespace (`./types`) and the client namespace (`./client`)
 * project exactly this content with zero duplication.
 *
 * @module @shres-code/shres-code-model-router/types
 */

import type { ReasoningEffortId } from '@shres-code/shres-code-llm'

/**
 * One allowlisted downgrade candidate as configuration states it: plain
 * strings, because a composition file carries no brands. Resolution brands the
 * effort into {@link ModelRoutingCandidate}.
 */
export interface ModelRoutingCandidateConfig {
  /** Stable id a decision records, for logs and configuration surfaces. */
  id: string
  /** Registered provider route this candidate runs on. */
  provider: string
  /** Provider-owned model id this candidate runs. */
  model: string
  /** Adapter-owned reasoning effort this candidate runs at, when it names one. */
  reasoningEffort?: string
  /** Why this candidate is allowlisted, for configuration surfaces. */
  description?: string
}

/** One resolved allowlisted downgrade candidate. */
export interface ModelRoutingCandidate {
  /** Stable id a decision records, for logs and configuration surfaces. */
  id: string
  /** Registered provider route this candidate runs on. */
  provider: string
  /** Provider-owned model id this candidate runs. */
  model: string
  /**
   * Adapter-owned reasoning effort this candidate runs at. Absent leaves the
   * candidate on the routed provider/model's own default, which is what keeps
   * one allowlist entry usable across routes with different effort vocabularies.
   */
  reasoningEffort?: ReasoningEffortId
  /** Why this candidate is allowlisted, for configuration surfaces. */
  description?: string
}

/**
 * The exact route one decision downgraded to. Always an allowlisted candidate:
 * the allowlist is the enforcement point, so routing can never select the
 * manual route and never anything stronger.
 */
export interface ModelRoutingSelection {
  /** Allowlist id this selection came from. */
  candidateId: string
  /** Registered provider route to run. */
  provider: string
  /** Provider-owned model id to run. */
  model: string
  /** Adapter-owned reasoning effort to run, when the candidate names one. */
  reasoningEffort?: ReasoningEffortId
}

/** What one routing consult resolved for a turn. */
export type ModelRoutingOutcome = 'downgraded' | 'kept-strong' | 'skipped' | 'error'

/**
 * Why a consult resolved that way. Each kept-strong class is its own reason
 * because the classes fail differently: an absent engine is a composition gap,
 * a low-confidence route is a judgment the operator may tune, and a broken
 * streak records what ended it.
 */
export type ModelRoutingReason =
  /** An allowlisted candidate passed the gate (or re-affirmed a held streak). */
  | 'gate-passed'
  /** The gate failed while the streak is below its amortization horizon. */
  | 'sticky-hold'
  /** No judgment engine is composed. */
  | 'engine-absent'
  /** A judgment engine is composed and the deployment turned it off. */
  | 'engine-disabled'
  /** The engine could not be reached, refused the ask, or did not answer in time. */
  | 'engine-unavailable'
  /** The engine answered with a body this provider could not use. */
  | 'invalid-answer'
  /** No candidates are configured, so nothing may be downgraded to. */
  | 'no-candidates'
  /** The judgment chose a route the allowlist does not contain. */
  | 'unknown-candidate'
  /** The route's confidence is below `downgradeThreshold`. */
  | 'low-confidence'
  /** The route's top-two margin is below `downgradeMargin`. */
  | 'thin-margin'
  /** The chosen candidate is the route already in force. */
  | 'candidate-equals-base'
  /** The turn failed the gate after the streak reached its horizon. */
  | 'gate-failed'
  /** The difficulty answer reached `escalateBack.scoreThreshold`. */
  | 'escalated'
  /** The manual provider/model changed away from the streak's entry route. */
  | 'manual-deviation'
  /** Durable route failures reached `maxRouteErrors`. */
  | 'route-errors'
  /** Routing is off, so this turn was not judged. */
  | 'mode-off'
  /** The judgment call itself failed and `onUnavailable` is `error`. */
  | 'judgment-error'

/** Why a downgraded streak ended. */
export type ModelRoutingBreakReason =
  | 'gate-failed'
  | 'escalated'
  | 'manual-deviation'
  | 'mode-off'
  | 'route-errors'

/** The manual route a streak was entered on, as the decision records it. */
export interface ModelRoutingEntryBaseView {
  /** Registered provider route in force when the streak was entered. */
  provider: string
  /** Provider-owned model id in force when the streak was entered. */
  model: string
  /**
   * Adapter-owned reasoning effort in force when the streak was entered.
   * Recorded so a reader can report the complete manual selection the streak
   * descends beneath: the consumed header stops carrying the manual effort once
   * routing rewrites it. The manual-deviation comparison stays provider/model
   * only.
   */
  reasoningEffort?: string
}

/** The sticky-fold facts one decision records about the streak it belongs to. */
export interface ModelRoutingStickyView {
  /** Whether a downgraded streak is in force after this decision. */
  active: boolean
  /** Turns elapsed since the streak was entered; 0 while strong. */
  turnsElapsed: number
  /** Turn the streak was entered; absent while strong. */
  enteredTurn?: number
  /** Why the streak ended, when this decision ended one. */
  brokenBy?: ModelRoutingBreakReason
  /**
   * Manual route the streak was entered on, present while it is active. The
   * consult records it because the manual route is only in the log while the
   * state is strong — a streak entered on the very first turn has no preceding
   * `request/header` to derive it from — and without it a manual switch could
   * not end that streak.
   */
  entryBase?: ModelRoutingEntryBaseView
}

/** The route answer one judgment call returned for the turn. */
export interface ModelRoutingRouteAnswer {
  /** Highest-probability candidate id. */
  choice: string
  /** Confidence of that answer, 0 to 1. */
  confidence: number
  /** Probability per candidate id, as the engine reported it. */
  probabilities: Record<string, number>
}

/** The difficulty answer one judgment call returned for the turn. */
export interface ModelRoutingDifficultyAnswer {
  /** Probability-weighted difficulty score. */
  score: number
  /** Confidence of that answer, 0 to 1. */
  confidence: number
}

/**
 * One logged routing decision for one turn. Log-only and append-only: the
 * decision is written after the consult resolved the turn, so the consumed
 * `request/header` that follows it carries the route it selected.
 */
export interface ModelRoutingDecision {
  /** What the consult resolved. */
  outcome: ModelRoutingOutcome
  /** Why it resolved that way. */
  reason: ModelRoutingReason
  /**
   * Hash of the state the judgment read. Recorded so a rerun with the same
   * state is recognizable, never to gate a decision.
   */
  stateHash: string
  /** Surface seqs the state was assembled from, in order. */
  stateSeqs: number[]
  /** Route to run; present for a downgraded outcome only. */
  selection?: ModelRoutingSelection
  /** The judgment's route answer, when a judgment call produced one. */
  route?: ModelRoutingRouteAnswer
  /** The judgment's difficulty answer, when the turn asked for one. */
  difficulty?: ModelRoutingDifficultyAnswer
  /** Advisory hint for the UI while the manual route stands. */
  hint?: 'consider-stronger'
  /** Sticky-fold facts after this decision. */
  sticky: ModelRoutingStickyView
  /** Engine that answered the judgment call, when one was made. */
  engine?: string
  /** Exact model that answered, when a judgment call was made. */
  model?: string
  /** Duration of the judgment call in milliseconds, when one was made. */
  latencyMs?: number
}

/**
 * One selection as a projection reports it: plain strings, because the wire
 * carries no brands. In-process facts use {@link ModelRoutingSelection}.
 */
export interface ModelRoutingSelectionView {
  /** Allowlist id this selection came from. */
  candidateId: string
  /** Registered provider route the streak holds. */
  provider: string
  /** Provider-owned model id the streak holds. */
  model: string
  /** Adapter-owned reasoning effort, when the candidate names one. */
  reasoningEffort?: string
}

/** The last decision a projection reports, reduced to what a UI renders. */
export interface ModelRoutingLastDecision {
  /** Last logged outcome. */
  outcome: ModelRoutingOutcome
  /** Allowlisted route last selected, if any. */
  selection?: ModelRoutingSelectionView
  /** Confidence of the last route answer, if any. */
  confidence?: number
  /** Last resolved reason. */
  reason: ModelRoutingReason
  /** Advisory hint from the last decision, if any. */
  hint?: 'consider-stronger'
}

/** The sticky state a UI renders: `auto: <model>, turn 3 of >=5` (PR5). */
export interface ModelRoutingStickyViewForUi {
  /** Whether a downgraded streak is in force. */
  active: boolean
  /** Turns elapsed since the streak was entered. */
  turnsElapsed: number
  /** Route the streak holds, when active. */
  selection?: ModelRoutingSelectionView
}

/**
 * The `modelRouting` projection's wire value. `active` is the logged mode in
 * force (the last `model-routing/mode`, inactive before the first) and
 * `pending` reports a logged `/route` selection not yet recorded by a mode
 * event. Capability absence (model-router not composed) is the key's absence.
 */
export interface ModelRoutingProjection {
  /** Whether routing is in force. */
  active: boolean
  /** Whether a logged `/route` selection still awaits its mode commit. */
  pending: boolean
  /** Last logged decision, when the log holds one. */
  last?: ModelRoutingLastDecision
  /** Sticky state folded from the decisions and the mode. */
  sticky?: ModelRoutingStickyViewForUi
  /**
   * Manual route the last downgraded streak was entered on, retained after that
   * streak broke: the selection a routing-idle session restores. It is the
   * fold's entry base rather than the session's current selection, so it
   * survives the manual pick of a downgrade candidate — the dead-end state
   * whose every decision reports `candidate-equals-base`. Absent until one
   * streak has been entered.
   */
  lastStrong?: ModelRoutingEntryBaseView
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Whether model routing is in force from this point on: log-only,
     * non-surface, whole-value replace. The last `model-routing/mode` wins; a
     * log with none folds to inactive through {@link foldModelRouting}.
     */
    'model-routing/mode': { active: boolean }
    /**
     * One turn's routing decision: log-only, append-only, and written after the
     * consult resolved the turn, so the `request/header` that follows it
     * records the route it selected.
     */
    'model-routing/decision': ModelRoutingDecision
  }
}

declare module '@shres-code/shres-code-session-projection/types' {
  interface SessionProjectionMap {
    /** Routing mode, outstanding `/route` selection, last decision, and sticky state. */
    modelRouting: ModelRoutingProjection
  }
}
