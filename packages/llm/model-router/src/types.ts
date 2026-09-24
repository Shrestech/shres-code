/**
 * Pure types of the model-routing domain: the routing vocabulary, the two
 * logged session events, and the ONE home of the `modelRouting` projection-key
 * declaration. Free of runtime imports, so
 * both the host namespace (`./types`) and the client namespace (`./client`)
 * project exactly this content with zero duplication.
 *
 * @module @shres-code/shres-code-model-router/types
 */

import type { HostedTool, ModelModality, ReasoningEffortId } from '@shres-code/shres-code-llm'
import type {
  JudgmentErrorCode, JudgmentQuestion, JudgmentTokenFit, JudgmentTokenLimitReason, JudgmentTokenLimits,
} from '@shres-code/shres-code-judgment'

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
  /** Tasks this candidate can handle, included with its model identity in the judgment question. */
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
  /** Tasks this candidate can handle, included with its model identity in the judgment question. */
  description?: string
}

/**
 * Stable result of one candidate check. `equals-base` marks a candidate naming
 * the manual provider/model at any effort; every other reason is a capability
 * result.
 */
export type ModelRoutingCandidateEligibilityReason =
  | 'eligible'
  | 'base-unavailable'
  | 'base-context-unknown'
  | 'equals-base'
  | 'candidate-unavailable'
  | 'candidate-invalid'
  | 'difficulty-effort-invalid'
  | 'image-capability-unknown'
  | 'image-incompatible'
  | 'context-unknown'
  | 'context-too-small'
  | 'max-tokens-exceeds-context'
  | 'hosted-tools-incompatible'

/** Detached, JSON-safe facts recorded for one configured candidate. */
export interface ModelRoutingCandidateAssessment {
  /** Configuration id used to identify the candidate. */
  readonly id: string
  /** Provider route checked. */
  readonly provider: string
  /** Exact model id checked. */
  readonly model: string
  /** Effective candidate effort, when the provider exposes or accepts one. */
  readonly reasoningEffort?: string
  /** Configured difficulty-lift effort checked for this candidate. */
  readonly difficultyReasoningEffort?: string
  /** Candidate input modalities, when the provider declares them. */
  readonly inputModalities?: readonly ModelModality[]
  /** Candidate context window, when the provider declares it. */
  readonly contextWindow?: number
  /** Candidate hosted tools, when the provider declares them. */
  readonly hostedTools?: readonly HostedTool[]
  /** Effective maximum output tokens, when known. */
  readonly effectiveMaxTokens?: number
  /** Stable eligibility result. */
  readonly reason: ModelRoutingCandidateEligibilityReason
}

/** Detached facts the helper used as the manual route's capability floor. */
export interface ModelRoutingCandidateRequirements {
  /** Whether the request contains an image at any nested content depth. */
  readonly requiresImage: boolean
  /** Manual provider route, when its metadata resolved. */
  readonly provider?: string
  /** Manual exact model id, when its metadata resolved. */
  readonly model?: string
  /** Manual context window, when its metadata declares one. */
  readonly contextWindow?: number
  /** Manual hosted-tool floor, when its metadata declares one. */
  readonly hostedTools?: readonly HostedTool[]
}

/** Candidate list and detached capability assessments for one routing request. */
export interface ModelRoutingCandidateEligibility {
  /** Detached manual-route requirements applied to each candidate. */
  readonly requirements: ModelRoutingCandidateRequirements
  /** The exact configured candidate list supplied by the caller. */
  readonly candidates: readonly ModelRoutingCandidate[]
  /** Candidates that passed every conservative capability check. */
  readonly eligibleCandidates: readonly ModelRoutingCandidate[]
  /** One detached assessment per configured candidate, in configuration order. */
  readonly assessments: readonly ModelRoutingCandidateAssessment[]
}

/**
 * The exact allowlisted route selected by one decision. The deployment owns
 * the candidate's capability and cost assessment.
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
  /** The engine could not be reached, refused the ask, or did not answer within `judgmentDeadlineMs`. */
  | 'engine-unavailable'
  /** A held streak kept its candidate through a failed judgment call within `judgmentFailures.holdTolerance`. */
  | 'judgment-failure-held'
  /** Consecutive failed judgment calls opened the breaker, so no judgment runs. */
  | 'breaker-open'
  /** The engine answered with a body this provider could not use. */
  | 'invalid-answer'
  /** No candidates are configured, so nothing may be downgraded to. */
  | 'no-candidates'
  /** No generation runtime is available to validate candidate routes. */
  | 'model-unavailable'
  /** Candidate capabilities cannot preserve the current request's requirements. */
  | 'candidate-ineligible'
  /** The complete current user message exceeds the routing state budget. */
  | 'state-too-large'
  /** The complete judgment input exceeds a transport or pinned tokenizer limit. */
  | 'judgment-input-too-large'
  /** The judgment chose a route the allowlist does not contain. */
  | 'unknown-candidate'
  /** The route's confidence is below `downgradeThreshold`. */
  | 'low-confidence'
  /** The route's top-two margin is below `downgradeMargin`. */
  | 'thin-margin'
  /** Every configured candidate is the manual provider/model, so no downgrade exists and no judgment runs. */
  | 'candidate-equals-base'
  /** The judgment selected the current model instead of any downgrade candidate. */
  | 'current-preferred'
  /** The difficulty answer prevents entry into a downgraded streak. */
  | 'difficulty-too-high'
  /** The turn failed the gate after the streak reached its horizon. */
  | 'gate-failed'
  /** The held streak reached `hold.maxSteps`, so the manual route returns without judgment. */
  | 'hold-cap'
  /** A quality exit ended a streak within `reentryCooldownTurns`, so no judgment runs. */
  | 'reentry-cooldown'
  /** The difficulty answer reached `escalateBack.scoreThreshold`. */
  | 'escalated'
  /** The manual provider/model changed away from the streak's entry route. */
  | 'manual-deviation'
  /** Durable route failures reached `maxRouteErrors`. */
  | 'route-errors'
  /** The downgraded request failed, and the step retries on the manual route. */
  | 'route-failed'
  /** Routing is off, so this turn was not judged. */
  | 'mode-off'
  /** The judgment call itself failed and `onUnavailable` is `error`. */
  | 'judgment-error'

/** Why a downgraded streak ended. */
export type ModelRoutingBreakReason =
  | 'gate-failed'
  | 'current-preferred'
  | 'unknown-candidate'
  | 'candidate-ineligible'
  | 'escalated'
  | 'manual-deviation'
  | 'mode-off'
  | 'route-errors'
  | 'route-failed'
  | 'hold-cap'

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

/** The sticky-fold facts one active decision records about its streak. */
export interface ModelRoutingActiveStickyView {
  /** A downgraded streak is in force after this decision. */
  active: true
  /**
   * Model steps logged since the streak was entered, counting every
   * `step/start` after the entering decision; 0 on the entering step.
   */
  stepsElapsed: number
  /** Turn the streak was entered; absent only for malformed external records. */
  enteredTurn?: number
  /** Step of {@link enteredTurn} the streak was entered on; absent only for records that predate it. */
  enteredStep?: number
  /**
   * Manual route the streak was entered on. The consult records it because the
   * manual route is only in the log while the state is strong.
   */
  entryBase?: ModelRoutingEntryBaseView
  /** The route-error threshold that governs future durable failures in this streak. */
  routeErrorLimit: number
}

/** The sticky-fold facts one inactive decision records. */
export interface ModelRoutingInactiveStickyView {
  /** No downgraded streak is in force after this decision. */
  active: false
  /** Zero while strong. */
  stepsElapsed: number
  /** Why the streak ended, when this decision ended one. */
  brokenBy?: ModelRoutingBreakReason
  /**
   * Manual route to use while recovering from a route-error break. Ordinary
   * inactive decisions may carry this only when they preserve that durable
   * recovery record.
   */
  entryBase?: ModelRoutingEntryBaseView
}

/** The discriminated sticky facts written into every routing decision. */
export type ModelRoutingStickyView = ModelRoutingActiveStickyView | ModelRoutingInactiveStickyView

/** The route answer one judgment call returned for the step. */
export interface ModelRoutingRouteAnswer {
  /** Chosen candidate id or the reserved `keep-current` option. */
  choice: string
  /** Confidence of that answer, 0 to 1. */
  confidence: number
  /** Probability per route option, including `keep-current`, as the engine reported it. */
  probabilities: Record<string, number>
}

/** The difficulty answer one judgment call returned for the step. */
export interface ModelRoutingDifficultyAnswer {
  /** Probability-weighted zero-based difficulty level index. */
  score: number
  /** Confidence of that answer, 0 to 1. */
  confidence: number
}

/**
 * One logged routing outcome. The initial judgment and any later manual or
 * capability exit precede the request header that consumes their selection.
 * Decisions are log-only and append-only.
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
  /** Renderer and bounds used when this decision assembled new judgment state. */
  stateProjection?: {
    /** Deterministic conversation renderer version. */
    renderer: 'conversation-v1'
    /** Prior user-message count admitted to the context window. */
    contextTurns: number
    /** Complete serialized state character budget. */
    maxChars: number
    /** Live surface messages omitted from the judgment state. */
    omittedSeqs: number[]
  }
  /** Exact capability facts and filtered options checked for this request, when available. */
  candidateEligibility?: ModelRoutingCandidateEligibility
  /** Exact questions supplied to the judgment engine, including the eligible route options. */
  judgmentQuestions?: readonly JudgmentQuestion[]
  /** Exact selected text after redaction, measured tokens, and artifact identity. */
  judgmentInput?: JudgmentTokenFit
  /** Capacity rejection without model inference. */
  judgmentRejection?: { limits: JudgmentTokenLimits; reason: JudgmentTokenLimitReason }
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
  /** The failed downgraded request a `route-failed` decision retries on the manual route. */
  failure?: ModelRoutingFailure
  /** Seq of the failed attempt's last `assistant/chunk`, when the attempt logged one. */
  failedChunkSeq?: number
  /** Why the judgment call failed, when it failed with a known code or missed its deadline. */
  engineFailure?: ModelRoutingEngineFailure
}

/** A failed judgment call as a decision records it. */
export interface ModelRoutingEngineFailure {
  /** The engine's error code, or `DEADLINE` when `judgmentDeadlineMs` expired before an answer. */
  code: JudgmentErrorCode | 'DEADLINE'
}

/** The downgraded request whose failure a `route-failed` decision records. */
export interface ModelRoutingFailure {
  /** Provider-neutral failure code the adapter reported. */
  code: string
  /** Registered provider route of the failed request. */
  provider: string
  /** Model id of the failed request. */
  model: string
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

/** The sticky state a UI renders. */
export interface ModelRoutingStickyViewForUi {
  /** Whether a downgraded streak is in force. */
  active: boolean
  /** Model steps logged since the streak was entered. */
  stepsElapsed: number
  /** Route the streak holds, when active. */
  selection?: ModelRoutingSelectionView
}

/**
 * The `modelRouting` projection's wire value. `active` is the logged mode in
 * force (the last mode or configuration event, inactive before either) and
 * `pending` reports a logged `/route on|off` selection not yet recorded by a mode
 * event. Capability absence (model-router not composed) is the key's absence.
 */
export interface ModelRoutingProjection {
  /** Whether routing is in force. */
  active: boolean
  /** Whether a logged `/route on|off` selection still awaits its mode commit. */
  pending: boolean
  /** Last logged decision, when the log holds one. */
  last?: ModelRoutingLastDecision
  /** Sticky state folded from the decisions and the mode. */
  sticky?: ModelRoutingStickyViewForUi
  /**
   * Manual route the last downgraded streak was entered on, retained after that
   * streak broke: the selection a routing-idle session restores. It is the
   * fold's entry base rather than the session's current selection, so it
   * survives the manual pick of the only downgrade candidate — the dead-end
   * state whose every decision reports `candidate-equals-base`. Absent until one
   * streak has been entered.
   */
  lastStrong?: ModelRoutingEntryBaseView
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Committed deployment mode for a live session without an explicit user
     * selection. Log-only, non-surface, whole-value replace. Changes during
     * an open turn commit at its next accepted pre-step.
     */
    'model-routing/configuration': { active: boolean }
    /**
     * Whether model routing is in force from this point on: log-only,
     * non-surface, whole-value replace. The last `model-routing/mode` wins; a
     * log with none folds to inactive through {@link foldModelRouting}.
     */
    'model-routing/mode': { active: boolean }
    /**
     * One request's routing decision: log-only, append-only, and written after
     * the consult resolved the route, so a changed `request/header` that follows it
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
