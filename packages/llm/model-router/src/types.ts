/**
 * Pure types of the model-routing domain: the routing vocabulary, the two
 * logged session events, and the ONE home of the `modelRouting` projection-key
 * declaration. Free of runtime imports, so
 * both the host namespace (`./types`) and the client namespace (`./client`)
 * project exactly this content with zero duplication.
 *
 * @module @shres-code/shres-code-model-router/types
 */

import type { HostedTool, LlmThinkingMode, ModelModality, ReasoningEffortId, TokenUsage } from '@shres-code/shres-code-llm'
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
  /**
   * Tasks this candidate can handle, included with its model identity in every
   * judgment question. Required, at most 160 characters.
   */
  description: string
}

/**
 * How a strong route that routing may start from is billed, which fixes what
 * routing away from it saves: `quota` for a subscription or credit plan,
 * `dollars` for a metered key, `latency` for a route chosen for speed.
 */
export type ModelRoutingObjective = 'quota' | 'dollars' | 'latency'

/** One strong route that routing may start from, as configuration states it. */
export interface ModelRoutingRouteFromConfig {
  /** Registered provider route of the strong model. */
  provider: string
  /** Provider-owned model id of the strong model. */
  model: string
  /** How this strong route is billed. Required. */
  objective: ModelRoutingObjective
  /**
   * Allow per-turn entry from a `quota` route, as `dollars` and `latency`
   * routes enter. Without it a quota route starts a downgrade only at a cold
   * point of its prompt cache and returns at the next one; set it for bench
   * arms that measure per-turn entry.
   */
  allowEveryTurn?: boolean
}

/** Match fields one child-route policy may constrain. An empty object is a catch-all. */
export interface ModelRoutingChildPolicyMatchConfig {
  /** Delegation consumer kind. */
  kind?: 'subagent' | 'workflow'
  /** Exact tool-facing agent type, such as `explore`. */
  agentType?: string
}

/** One ordered child-route rule, as configuration states it. */
export interface ModelRoutingChildPolicyConfig {
  /** Match constraints; empty is a catch-all and is allowed only as the last rule. */
  match: ModelRoutingChildPolicyMatchConfig
  /** Pool candidate id this rule selects. */
  candidate: string
  /** When true, ask the selected engine keep-current vs this candidate. Defaults to false. */
  judge?: boolean
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
  description: string
}

/**
 * The gate thresholds one judgment engine is operated at, as configuration
 * states them. Thresholds do not transfer between engines, so a point applies
 * only to the engine it names.
 */
export interface ModelRoutingOperatingPointConfig {
  /** Registry id of the engine this point applies to. */
  engine: string
  /** Route confidence at or above which a candidate may be selected. */
  downgradeThreshold: number
  /** Required top-two probability margin (`top1 - top2`) for a selection. */
  downgradeMargin: number
  /** Id of the preregistration whose replay set these thresholds; absence marks them uncalibrated. */
  calibratedBy?: string
  /**
   * Allow gating on an engine whose descriptor declares `verbalized`
   * calibration. Without it such an engine is refused as `engine-uncalibrated`.
   */
  acceptVerbalized?: boolean
}

/**
 * How the router gates one engine's answers (`routingCalibration`):
 * `refused` — verbalized probabilities no operating point accepts, so the
 * router never asks it and keeps the strong model; `calibrated` — its
 * operating point, set by the preregistration `by`; `point` — an
 * uncalibrated operating point; `global` — the uncalibrated global thresholds.
 */
export type ModelRoutingCalibration =
  | { kind: 'refused' }
  | { kind: 'calibrated'; by: string }
  | { kind: 'point' }
  | { kind: 'global' }

/** One resolved operating point. */
export interface ModelRoutingOperatingPoint {
  /** Registry id of the engine this point applies to. */
  readonly engine: string
  /** Route-confidence floor. */
  readonly downgradeThreshold: number
  /** Top-two margin floor. */
  readonly downgradeMargin: number
  /** Id of the preregistration whose replay set these thresholds, when one did. */
  readonly calibratedBy?: string
  /** Whether a `verbalized` engine may gate. */
  readonly acceptVerbalized: boolean
}

/**
 * The thresholds in force when a consult judged a route answer, as the
 * decision records them, so a later configuration change does not
 * reinterpret the log.
 */
export interface ModelRoutingThresholds {
  /** Route-confidence floor applied. */
  downgradeThreshold: number
  /** Top-two margin floor applied. */
  downgradeMargin: number
  /** Difficulty at or above which no streak is entered; present when the consult asked the difficulty question. */
  entryScoreCeiling?: number
  /** Difficulty at or above which a held streak escalates; present when the consult asked the difficulty question. */
  escalateBackScoreThreshold?: number
  /** Whether the confidence and margin floors came from the engine's operating point or the global defaults. */
  source: 'operating-point' | 'global'
  /** Id of the preregistration whose replay set the operating point; absent means uncalibrated. */
  calibratedBy?: string
}

/** One resolved strong route that routing may start from. */
export interface ModelRoutingRouteFrom {
  /** Registered provider route of the strong model. */
  readonly provider: string
  /** Provider-owned model id of the strong model. */
  readonly model: string
  /** How this strong route is billed. */
  readonly objective: ModelRoutingObjective
  /** Whether a `quota` route enters per turn instead of only at cold points. */
  readonly allowEveryTurn: boolean
}

/** One resolved child-route rule. */
export interface ModelRoutingChildPolicy {
  /** Match constraints; empty is a catch-all. */
  readonly match: {
    readonly kind?: 'subagent' | 'workflow'
    readonly agentType?: string
  }
  /** Pool candidate id this rule selects. */
  readonly candidate: string
  /** Whether the rule asks the selected engine. */
  readonly judge: boolean
}

/**
 * Stable result of one candidate check. `equals-base` marks a candidate naming
 * the manual provider/model at any effort; `thinking-mode-incompatible` marks
 * every other candidate while the manual route runs budget thinking, because a
 * return after a routed segment would run it without thinking; every other
 * reason is a capability result.
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
  | 'thinking-mode-incompatible'

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
  /** Candidate prompt-cache lifetime in milliseconds, when the provider declares one. */
  readonly promptCacheTtlMs?: number
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
  /** Manual route's thinking mode, when its metadata declares one. */
  readonly thinkingMode?: LlmThinkingMode
  /** Manual model's prompt-cache lifetime in milliseconds, when its metadata declares one. */
  readonly promptCacheTtlMs?: number
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
  /** The manual route is not listed in `routeFrom`, so routing never starts from it and no judgment runs. */
  | 'base-unlisted'
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
  /**
   * The selected engine declares `verbalized` calibration and no operating
   * point accepts it, so it is not asked and the manual route stands.
   */
  | 'engine-uncalibrated'
  /**
   * The manual route runs budget thinking with reasoning enabled, so every
   * other candidate is excluded and no judgment runs: returning to it after a
   * routed segment would run the manual model without thinking.
   */
  | 'thinking-mode-incompatible'
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
  /**
   * The manual route is a `quota` route and its prompt-cache prefix is still
   * warm, so no switch is attempted and no judgment runs this turn.
   */
  | 'warm-prefix'
  /**
   * The manual route's prompt cache went cold after the held quota streak
   * reached `hold.minSteps`, so the streak returns to it without judgment.
   */
  | 'cold-point-return'

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
  | 'base-unlisted'
  | 'cold-point-return'

/**
 * Why the manual route's prompt-cache prefix counts as cold at a consult,
 * first match wins: its model never answered in this unseeded session, a
 * compaction followed its last answer, the manual model changed since that
 * answer, its cache lifetime is zero, or the time since that answer's step
 * started exceeds the lifetime.
 */
export type ModelRoutingColdPointKind = 'session-start' | 'post-compaction' | 'manual-switch' | 'no-cache' | 'idle'

/** One cold point of the manual route's prompt cache, as a decision records it. */
export interface ModelRoutingColdPoint {
  /** Which rule found the prefix cold. */
  kind: ModelRoutingColdPointKind
  /** Cache lifetime the rules used, in milliseconds. */
  ttlMs: number
  /** `adapter` when the manual model's metadata declared the lifetime, `fallback` for `coldPoints.unknownTtlMs`. */
  ttlSource: 'adapter' | 'fallback'
  /** Milliseconds from the start of the manual model's last answering step to this step's start, when it answered. */
  idleMs?: number
  /** Seq of the manual model's last `assistant/message`, when it answered. */
  lastBaseSeq?: number
  /** Seq of the `compaction/end` that followed that message, for `post-compaction`. */
  compactionSeq?: number
}

/** One model's prompt-cache lifetime, as a decision records it. */
export interface ModelRoutingCacheTtlView {
  /** Registered provider route of the model. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Cache lifetime in milliseconds. */
  readonly ttlMs: number
  /** `adapter` when the model's metadata declared it, `fallback` for `coldPoints.unknownTtlMs`. */
  readonly source: 'adapter' | 'fallback'
}

/**
 * The prompt-cache lifetimes one consult used. `base` always names the manual
 * route; `candidates` names each configured candidate whose metadata declared
 * a lifetime.
 */
export interface ModelRoutingDecisionCache {
  /** The manual route's lifetime. */
  readonly base: ModelRoutingCacheTtlView
  /** Lifetimes of configured candidates whose metadata declared one. */
  readonly candidates?: readonly { readonly id: string; readonly ttlMs: number; readonly source: 'adapter' | 'fallback' }[]
}

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
  /** Engine that answered the judgment call, as the provider named it, when one answered. */
  engine?: string
  /** Exact model that answered, when a judgment call was made. */
  model?: string
  /**
   * Duration of the judgment call in milliseconds, when one was made: the
   * engine's own figure for an answer, and the router's wall-clock measure from
   * the ask to its failure for a failed call.
   */
  latencyMs?: number
  /**
   * Registry id of the engine the judgment call was routed to, as the
   * dispatcher stamped it on the answer or the failure; absent when a
   * single-engine implementation served `ctx.judgment`.
   */
  engineId?: string
  /**
   * Token usage of the judgment call's own model request, exactly as the
   * engine reported it, so {@link TokenUsage}'s presence contract holds; absent
   * when the engine reported none.
   */
  judgeUsage?: TokenUsage
  /**
   * Duration of the candidate capability assessment in milliseconds, when this
   * decision ran one: it sits on the request's critical path with the call.
   */
  eligibilityMs?: number
  /**
   * Characters of state the router handed to the engine for the judgment call:
   * the one state of a plain ask, or every alternative a fitted ask offered.
   * `judgmentInput.state` records the exact text a fitted answer used.
   */
  inputChars?: number
  /** The failed downgraded request a `route-failed` decision retries on the manual route. */
  failure?: ModelRoutingFailure
  /** Seq of the failed attempt's last `assistant/chunk`, when the attempt logged one. */
  failedChunkSeq?: number
  /** Why the judgment call failed, when it failed with a known code or missed its deadline. */
  engineFailure?: ModelRoutingEngineFailure
  /** Billing objective of the `routeFrom` entry the manual route matched, when it matched one. */
  objective?: ModelRoutingObjective
  /** The thresholds in force for the route and difficulty answers, when a judgment call answered. */
  thresholds?: ModelRoutingThresholds
  /**
   * The cold point a consult under the quota cold-point policy found for the
   * manual route, or `null` when its prefix was warm; absent when the consult
   * evaluated none. Replay reads this record and never re-evaluates the clock.
   */
  coldPoint?: ModelRoutingColdPoint | null
  /**
   * Set on decisions a shadow-mode consult logged: the judgment ran and the
   * decision describes what live routing would have done, and no request was
   * rewritten. Only `on` routes, so absence reads as a live decision and logs
   * written before shadow keep their meaning.
   */
  shadow?: true
  /**
   * The prompt-cache lifetimes the consult used, when it evaluated a cold
   * point or judged: the manual route's, and each candidate's declared
   * lifetime. Statistics fold these into the per-model lifetimes that
   * idle-expiry causes use.
   */
  cache?: ModelRoutingDecisionCache
}

/** A failed judgment call as a decision records it. */
export interface ModelRoutingEngineFailure {
  /**
   * The engine's error code, whenever the failure arrived, or `DEADLINE` when
   * `judgmentDeadlineMs` expired first and the failure was a cancellation or
   * carried no code, or an answer arrived after it.
   */
  code: JudgmentErrorCode | 'DEADLINE'
  /**
   * The engine's registry state when it was becoming ready: before the call,
   * which the router then did not make, or when the call's failure arrived.
   * The fold does not count the decision as a failed judgment toward
   * `judgmentFailures.holdTolerance` or the breaker.
   */
  engineState?: 'starting' | 'not-installed'
  /**
   * `true` when the dispatcher refused the call before handing it to any
   * engine (`JudgmentError.refusedBeforeDispatch`), as it does for a selected
   * engine that is not composed or not `ready`: nothing was sent. Unlike a
   * warm-up, the fold counts it as a failed judgment toward
   * `judgmentFailures.holdTolerance` and the breaker, so a persistent
   * misconfiguration opens the breaker.
   */
  refusedBeforeDispatch?: true
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
 * The routing mode in force: `off` never judges, `on` judges and may rewrite a
 * request, and `shadow` judges and logs every decision but never rewrites one.
 */
export type ModelRoutingMode = 'off' | 'on' | 'shadow'

/**
 * One logged mode value, stored additively: `active: false` is off, and
 * `shadow: true`, valid only with `active: true`, is shadow. An active record
 * without `shadow` is on, so logs written before shadow existed read unchanged.
 */
export interface ModelRoutingModeRecord {
  /** Whether routing judges this session's requests. */
  active: boolean
  /** Judge and log without rewriting any request; valid only with `active: true`. */
  shadow?: true
}

/**
 * The `modelRouting` projection's wire value. `mode` is the logged mode in
 * force (the last mode or configuration event, off before either) and
 * `pending` reports a logged `/route on|off|shadow` selection not yet recorded
 * by a mode event. Capability absence (model-router not composed) is the key's
 * absence.
 */
export interface ModelRoutingProjection {
  /** The routing mode in force. */
  mode: ModelRoutingMode
  /** Whether routing judges requests: `mode` is `on` or `shadow`. */
  active: boolean
  /** Whether a logged `/route on|off|shadow` selection still awaits its mode commit. */
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
  /**
   * Whether the first `assistant/message` after the last streak a decision
   * ended — the return to the manual route — carried a reasoning block. Only a
   * decision that ends a streak arms it: a streak ended by a mode switch to off
   * or by the route-errors recovery leaves it unchanged. `absent` also covers
   * a manual route that never reasons. Absent until one such reply.
   */
  returnThinking?: 'present' | 'absent'
}

/**
 * The group a decision's reason belongs to, for the reason chart and the
 * verdict: the route switched or held, the judge kept the strong route, a
 * precondition kept it without a judgment, or the engine or route failed.
 */
export type ModelRoutingReasonGroup = 'switched' | 'judge-no' | 'fail-closed' | 'engine'

/**
 * Why a cold call's prefix was re-written, first match wins: a routed switch
 * onto a candidate, a routed return to the manual route, a manual model
 * switch, idle past the model's cache lifetime, the session's first call, the
 * first call after a compaction, or anything else on warm timing.
 */
export type ModelRoutingColdCause =
  | 'routed-switch'
  | 'routed-return'
  | 'manual-switch'
  | 'idle-expiry'
  | 'session-start'
  | 'post-compaction'
  | 'other'

/** Timeline marker kinds: a routed switch, a return, a manual switch, a failed route, or an idle gap past the cache lifetime. */
export type ModelRoutingTimelineMark = 'down' | 'return' | 'manual' | 'failed' | 'idle'

/**
 * One model that served calls in the session, with its token classes. Input
 * classes follow the usage presence contract: a call that reported cache
 * counts contributes `uncached` (its `inputTokens`), `cacheRead`, and
 * `cacheWrite`; a call that reported none contributes `unreported` (its
 * whole `inputTokens`).
 */
export interface ModelRoutingStatsModel {
  /** Provider route that served the calls. */
  provider: string
  /** Model id that served the calls. */
  model: string
  /** `strong` for the manual route, `candidate` for a pool candidate, `other` for earlier manual choices. */
  role: 'strong' | 'candidate' | 'other'
  /** Chart colour slot: the strong route, a pool series by pool order, or neutral beyond five. */
  colorSlot: 'strong' | 1 | 2 | 3 | 4 | 5 | 'other'
  /** Steps attributed to this model (the model of the step's last call). */
  steps: number
  /** Calls this model served. */
  calls: number
  /** Input tokens of cache-reporting calls that were neither read from nor written to cache. */
  uncached: number
  /** Input tokens of calls that reported no cache counts. */
  unreported: number
  /** Cache-read input tokens. */
  cacheRead: number
  /** Cache-write input tokens. */
  cacheWrite: number
  /** Output tokens. */
  output: number
  /** Calls that reported cache counts. */
  reportedCalls: number
}

/**
 * The `modelRoutingStats` projection's wire value: a pure fold of one
 * session's log into the Routing view's counts, histograms, timeline, and
 * recent decisions. Statistics follow the model-routing session view's stat
 * definitions. Router configuration (thresholds, deadline, difficulty band)
 * is not in the log, so it is not here; `modelRouting.gate()` reads it.
 */
export interface ModelRoutingStatsSnapshot {
  /** Decision and step counts. */
  counts: {
    /** All `model-routing/decision` events. */
    decisions: number
    /** Decisions whose judgment answered (`route` present). */
    consults: number
    /** Steps whose calls a downgraded decision's selection served. */
    downgradedSteps: number
    /** Distinct steps with at least one call. */
    steps: number
    /** Downgraded decisions entered from an inactive sticky state. */
    streaks: number
    /** `kept-strong` decisions. */
    keptStrong: number
    /** Decisions with reason `route-failed`. */
    routeFailed: number
    /**
     * Decisions with `engineFailure`, or reason `engine-unavailable` or
     * `invalid-answer`, except warm-ups.
     */
    judgeFailed: number
    /** Decisions whose `engineFailure.code` is `DEADLINE`. */
    deadlineHits: number
    /**
     * Decisions whose selected engine was still becoming ready
     * (`engineFailure.engineState`), so no judgment call was made.
     */
    warmUps: number
    /** Turns with at least one decision. */
    turnsWithDecisions: number
    /** Decisions a warm quota prefix skipped: reason `warm-prefix`, no judgment call. */
    warmSkipped: number
    /** Routed `model-routing/child-decision` events. */
    childRouted: number
    /** Child outcomes counted as failure. */
    childFailures: number
    /** Child outcomes counted as success. */
    childSuccesses: number
    /** Child outcomes counted as neutral. */
    childNeutral: number
  }
  /**
   * Child-route decisions and classified outcomes on this parent session.
   * Child tokens are not included; the workspace rollup sums `counts`.
   */
  children: {
    /** `model-routing/child-decision` events, routed or kept. */
    decided: number
    /** Decisions whose outcome is `routed`. */
    routed: number
    /** Decisions whose outcome is `kept`. */
    kept: number
    /** Child-decision reasons, largest first. */
    byReason: { reason: string; count: number }[]
    /** Routed selections, largest first. */
    byModel: { candidateId: string; count: number }[]
    /** Child outcomes counted as failure. */
    failures: number
  }
  /** Most recent child-decisions, newest first, at most 100. */
  recentChildren: {
    seq: number
    t: number
    outcome: 'routed' | 'kept'
    reason: string
    candidateId: string | null
    agentType: string | null
    shadow: boolean
    latencyMs: number | null
  }[]
  /** Reason histogram over all decisions, largest first. */
  reasons: { reason: string; group: ModelRoutingReasonGroup; count: number }[]
  /** Kept-strong reason histogram, largest first. */
  keptReasons: { reason: string; count: number }[]
  /** `sticky.brokenBy` histogram over decisions, largest first. */
  exits: { brokenBy: string; count: number }[]
  /** Streak lengths in steps, entry to exit (an open streak runs to the end of the log). */
  streakLengths: { median: number | null; max: number | null }
  /** Best-candidate confidence per consult. */
  confidence: {
    /** Per-consult values in log order, the most recent 500. */
    values: number[]
    /** Top-two probability margin per consult in log order, the most recent 500. */
    margins: number[]
    /** Largest value over every consult, or null without consults. */
    max: number | null
    /** Consults counted, including any beyond the retained values. */
    total: number
  }
  /**
   * Judge-call latency per ask (`latencyMs`), the duration
   * `judgmentDeadlineMs` bounds. Answered asks count, and failed asks whose
   * decision recorded a duration; a refusal before any request does not.
   * Bucket `i` counts latencies at most `bucketsMs[i]` and above the
   * previous bound; the last bound is 30 s. Percentiles are read from the
   * histogram, within one bucket.
   */
  latency: {
    bucketsMs: number[]
    counts: number[]
    /** Failed judgments (`counts.judgeFailed`). */
    failed: number
    p50: number | null
    p95: number | null
    /** Whether a failed ask's latency is in the histogram. */
    includesFailed: boolean
  }
  /**
   * Candidate eligibility assessment before a consult (`eligibilityMs`), in
   * the `latency.bucketsMs` buckets, over every decision that recorded it.
   */
  eligibility: {
    counts: number[]
    p50: number | null
    p95: number | null
  }
  /**
   * Time decisions added before their steps could start: each decision's
   * judge-call and eligibility durations as recorded, summed, and averaged over
   * the turns with decisions.
   */
  criticalPath: {
    totalMs: number
    /** `totalMs` over `counts.turnsWithDecisions`, or null without decisions. */
    perTurnMs: number | null
    /** Decisions with a timed judge call and no recorded eligibility duration, whose share excludes it. */
    judgeOnly: number
  }
  /**
   * Token usage the judge reported for its own model calls (`judgeUsage`):
   * the calls that reported it, the prompt tokens they processed, and their
   * output tokens.
   */
  judge: { calls: number; promptTokens: number; outputTokens: number }
  /**
   * Distinct gate thresholds answered consults recorded as applied, in
   * first-appearance order, with their consult counts. A consult whose
   * decision recorded none is not counted.
   */
  thresholds: {
    downgradeThreshold: number
    downgradeMargin: number
    source: 'operating-point' | 'global'
    /** Preregistration that set them, or null when they are uncalibrated. */
    calibratedBy: string | null
    consults: number
  }[]
  /** Models that served calls, strong first, then pool order, then first appearance. */
  models: ModelRoutingStatsModel[]
  /** Cold prefills by cause, every cause present, fixed order. */
  cold: { cause: ModelRoutingColdCause; count: number; tokens: number }[]
  /**
   * Cache lifetimes idle-expiry causes use: one entry per provider/model a
   * decision's `cache` described, latest value per model, and the fallback
   * for models no decision describes.
   */
  coldTtl: {
    perModel: { provider: string; model: string; ms: number; source: 'adapter' | 'fallback' }[]
    fallbackMs: number
  }
  /**
   * What shadow decisions say live routing would have done: their count, the
   * downgraded ones, and the streaks their downgraded decisions entered from
   * an inactive simulated state. Live decisions never enter these figures.
   */
  shadow: { decisions: number; downgraded: number; streaks: number }
  /** Share of calls with no reported cache counts, 0 to 1, or null without calls. */
  unreportedCallShare: number | null
  /** Strong-route tokens moved to candidates and re-written on return. */
  moved: {
    /** Input processed plus output over candidate-served calls. */
    tokensOffStrong: number
    /** Cache-write plus uncached input on the first strong call after each streak exit. */
    returnReprefill: number
    /** Billing objective of the matched `routeFrom` entry: the latest decision's, `mixed` when they differ. */
    objective: ModelRoutingObjective | 'mixed' | null
  }
  /**
   * Judge asks and state characters per engine: the registry id when the
   * decision recorded one (`engineId`, also on failed asks), else the name the
   * answering provider reported. `chars` is exact when every ask recorded its
   * input size (`inputChars`, or the exact judgment input); otherwise it sums
   * the upper bound `stateProjection.maxChars` for the rest, and `bound` is
   * `at-most`. An ask that failed or whose fit was rejected is also `at-most`,
   * since it cannot show whether the request left. A warm-up and an engine the
   * dispatcher reports unconfigured send nothing and are not counted.
   */
  egress: { engine: string; asks: number; chars: number; bound: 'exact' | 'at-most' }[]
  /**
   * Engines that answered, named as in `egress`, in first-appearance order,
   * with their decision counts.
   */
  engines: { name: string; decisions: number }[]
  /**
   * Step timeline for the model chart. `steps[i].model` indexes `models`;
   * marks and decisions point at a step index. More than 400 steps are
   * aggregated to at most 400 entries of one or more whole consecutive turns
   * each (majority model), from `turn` to `lastTurn`; an entry's `seq` and
   * `t` are its latest call's. A step's `lastTurn` is its `turn`.
   */
  timeline: {
    steps: { turn: number; step: number; lastTurn: number; model: number; seq: number; t: number }[]
    marks: { i: number; kind: ModelRoutingTimelineMark }[]
    decisions: {
      seq: number
      i: number
      outcome: ModelRoutingOutcome
      reason: string
      best: number | null
      /** Index into `engines`, or null when no engine answered. */
      engine: number | null
      /** Whether a shadow consult logged it: it describes what live would have done. */
      shadow: boolean
      /** Model id a shadow downgrade would have served, null otherwise. */
      wouldModel: string | null
    }[]
    aggregated: boolean
  }
  /** The most recent decisions, newest first, at most 200. */
  recent: {
    seq: number
    t: number
    turn: number
    step: number
    outcome: ModelRoutingOutcome
    reason: string
    best: number | null
    difficulty: number | null
    /** The engine, named as in `egress`, or null when the decision names none. */
    engine: string | null
    latencyMs: number | null
  }[]
}

/**
 * The router's gate configuration in force now. A judged decision records the
 * thresholds it applied; this is the configuration a view compares a decision
 * with when it recorded none, and the one the next consult is gated by. Floors
 * are uncalibrated unless an operating point names the preregistration that
 * set them.
 */
export interface ModelRoutingGateView {
  /** Route-confidence floor for an engine without an operating point. */
  downgradeThreshold: number
  /** Top-two margin floor for an engine without an operating point. */
  downgradeMargin: number
  /** Per-engine floors, which replace the two above for the engine each names. */
  operatingPoints: ModelRoutingOperatingPoint[]
  /** How the router gates each engine the registry describes now, by registry id. */
  engines: { engine: string; calibration: ModelRoutingCalibration }[]
  /** Deadline of one judgment call, in milliseconds. */
  judgmentDeadlineMs: number
  /** Difficulty at or above which a streak is not entered. */
  entryScoreCeiling: number
  /** Difficulty at or above which a held streak escalates back. */
  escalateBackScoreThreshold: number
  /** Difficulty levels, lowest first; the score scale is 0 to `levels.length - 1`. */
  difficultyLevels: string[]
  /** Streak horizon and cap, in model steps. */
  hold: { minSteps: number; maxSteps: number }
  /** Hard cap, in characters, on the conversation state one consult sends to the judge. */
  stateMaxChars: number
}

/** One `routeFrom` entry as the pool status reports it. */
export interface ModelRoutingPoolBase {
  /** Provider route of the strong model. */
  provider: string
  /** Provider-owned model id of the strong model. */
  model: string
  /** How this strong route is billed. */
  objective: ModelRoutingObjective
  /** Whether per-turn entry from a `quota` route is allowed. */
  allowEveryTurn: boolean
  /** Whether the llm runtime registers the provider route now. */
  registered: boolean
  /** The model's declared context window, in tokens, when its adapter states one. */
  contextWindow?: number
}

/** How the router's eligibility check judges one pool model from one `routeFrom` base. */
export interface ModelRoutingPoolEligibility {
  /** Provider route of the base. */
  provider: string
  /** Model id of the base. */
  model: string
  /**
   * The router's eligibility result for this pair, before any conversation:
   * the result a turn without images gets.
   */
  reason: ModelRoutingCandidateEligibilityReason
}

/** One pool model as the pool status reports it. */
export interface ModelRoutingPoolCandidate {
  /** Configuration id, as the route question names it. */
  id: string
  /** Provider route of the pool model. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** The configured effort, when one is set. */
  reasoningEffort?: string
  /** The configured description. */
  description: string
  /** Whether the llm runtime registers the provider route now. */
  registered: boolean
  /** The model's declared context window, in tokens, when its adapter states one. */
  contextWindow?: number
  /** Declared input modalities, when the adapter states them. */
  inputModalities?: string[]
  /** Efforts the model's route offers, in adapter order, when it exposes reasoning control. */
  efforts?: string[]
  /** Whether the route's usage reports prompt-cache counts, when the adapter declares it. */
  cacheUsage?: 'reported' | 'unreported'
  /** Whether the same provider and model is also a `routeFrom` entry. */
  alsoRouteFrom: boolean
  /** The eligibility result from each `routeFrom` base, in `routeFrom` order. */
  eligibility: ModelRoutingPoolEligibility[]
}

/**
 * The configured pool and `routeFrom` allowlist, each model with the facts its
 * adapter declares and the router's eligibility result for every
 * (base, pool model) pair. JSON only; computed from the configuration in
 * force and the llm runtime's registrations when read.
 */
export interface ModelRoutingPoolStatus {
  /** The `routeFrom` entries, in configuration order. */
  routeFrom: ModelRoutingPoolBase[]
  /** The pool, in configuration order. */
  candidates: ModelRoutingPoolCandidate[]
}

/** One logged decision with the position and config a drill-down renders. */
export interface ModelRoutingDecisionDetail {
  /** Seq of the `model-routing/decision` event. */
  seq: number
  /** Event time, epoch milliseconds. */
  time: number
  /** Turn the decision was logged in. */
  turn: number
  /** Step the decision was logged in. */
  step: number
  /** The logged decision, verbatim. */
  decision: ModelRoutingDecision
  /** Configuration in force now. */
  gate: ModelRoutingGateView
}

/**
 * The window of a workspace statistics read: a session is in it when its
 * latest decision falls within the last 24 hours, the last 7 days, or ever.
 */
export type ModelRoutingStatsRange = '24h' | '7d' | 'all'

/** A `modelRouting/stats` request: one workspace's sessions over one window. */
export interface ModelRoutingStatsRequest {
  /** Registry id of the workspace whose sessions are rolled up. */
  workspaceId: string
  range: ModelRoutingStatsRange
}

/** One session's row in the workspace statistics. */
export interface ModelRoutingWorkspaceSession {
  sessionId: string
  /** Time of the session's latest decision, epoch milliseconds. */
  lastDecisionAt: number
  /** The session's decisions. */
  decisions: number
  /** The session's steps with a call. */
  steps: number
  /** Of those, steps a pool model served. */
  downgradedSteps: number
}

/**
 * Routing statistics across one workspace's sessions, rolled up from each
 * session's `modelRoutingStats` value. A session counts whole: its totals
 * are included when its latest decision falls in the range, not only the
 * decisions within it.
 */
export interface ModelRoutingWorkspaceStats {
  workspaceId: string
  range: ModelRoutingStatsRange
  /** When the host rolled these up, epoch milliseconds. */
  computedAt: number
  sessions: {
    /** Unarchived sessions the workspace accounts. */
    members: number
    /**
     * Members whose statistics were read: live for an attached session, else
     * the persisted projection cache's value on the current unit version.
     * The rest have none until they are opened.
     */
    summarized: number
    /** Summarized sessions whose latest decision falls in the range. */
    inRange: number
    /** In-range sessions rolled up, most recent decision first. */
    included: number
    /** Whether more sessions were in range than the cap includes. */
    capped: boolean
  }
  /** Summed counts of the included sessions. */
  counts: ModelRoutingStatsSnapshot['counts']
  /** Decision reasons across the included sessions, largest count first, then by reason. */
  reasons: ModelRoutingStatsSnapshot['reasons']
  /** Cold prefills after routed switches and routed returns across the included sessions. */
  routedSwitches: { count: number; tokens: number }
  /** The included sessions, most recent decision first. */
  rows: ModelRoutingWorkspaceSession[]
}

/** One child's routing decision, recorded on the parent before the child exists. */
export interface ModelRoutingChildDecision {
  /** Whether a pool candidate was returned to the waterfall. */
  outcome: 'routed' | 'kept'
  /** Why the child was routed or kept. */
  reason:
    | 'child-policy'
    | 'child-judged'
    | 'base-unlisted'
    | 'candidate-equals-base'
    | 'child-route-errors'
    | 'input-too-large'
    | 'engine-absent'
    | 'engine-uncalibrated'
    | 'engine-unavailable'
    | 'invalid-answer'
    | 'low-confidence'
    | 'thin-margin'
  /** Dispatch identity minted by resolveChildRoute. */
  routeRequestId: string
  /** Delegation consumer kind. */
  childKind: 'subagent' | 'workflow'
  /** Tool-facing agent type, when a tool delegates. */
  agentType?: string
  /** Index of the matching childPolicies rule. */
  policyIndex: number
  /** Inherited parent route. */
  inherited: { provider?: string; model?: string }
  /** Routed pool selection. */
  selection?: { candidateId: string; provider: string; model: string }
  /** Child-route never applies pool reasoningEffort. */
  effortApplied: false
  /** Character length of the child's task text. */
  promptChars: number
  /** Exact task text handed to a plain judgment ask. */
  judgmentState?: string
  /** Exact questions supplied to the child-route judgment engine. */
  judgmentQuestions?: readonly JudgmentQuestion[]
  /** Exact selected task text and tokenizer facts from a fitted ask. */
  judgmentInput?: JudgmentTokenFit
  /** Capacity rejection without model inference. */
  judgmentRejection?: { limits: JudgmentTokenLimits; reason: JudgmentTokenLimitReason }
  /** The judgment's route answer, when a judgment call produced one. */
  route?: ModelRoutingRouteAnswer
  /** Characters handed to the engine; zero records a pre-dispatch input refusal. */
  inputChars?: number
  /** Judgment engine identity, when a rule judged. */
  engine?: string
  engineId?: string
  model?: string
  latencyMs?: number
  /** Token usage of the child-route judgment call, when the engine reported it. */
  judgeUsage?: TokenUsage
  /** Why the child-route judgment call failed, when it failed. */
  engineFailure?: ModelRoutingEngineFailure
  /** Thresholds in force for the child-route judgment. */
  thresholds?: ModelRoutingThresholds
  /** Whether this consult only recorded what live would do. */
  shadow?: true
  /** Parent routeFrom objective, when the base is listed. */
  objective?: ModelRoutingObjective
}

/** How one child accounting turn counts toward the per-candidate breaker. */
export type ModelRoutingChildCountedAs = 'failure' | 'success' | 'neutral'

/** One classified child-turn outcome on the parent log. */
export interface ModelRoutingChildOutcome {
  /** Dispatch identity joining this outcome to a routed child-decision. */
  routeRequestId: string
  /** Pool candidate the decision selected. */
  candidateId: string
  /** Durable child session id. */
  childSessionId: string
  /** Accounting turn number on the child log. */
  childTurn: number
  /** Route in force for that turn. */
  route: { provider: string; model: string }
  /** Child turn/end kind. */
  turnEnd: string
  /** LlmError code when the turn ended in error. */
  failureCode?: string
  /** Breaker classification. */
  countedAs: ModelRoutingChildCountedAs
  /** Live Activation run id, when known. */
  runId?: string
  /** Set when this outcome was appended after a parent restart. */
  reconciled?: true
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Committed deployment mode for a live session without an explicit user
     * selection. Log-only, non-surface, whole-value replace. Changes during
     * an open turn commit at its next accepted pre-step.
     */
    'model-routing/configuration': ModelRoutingModeRecord
    /**
     * The routing mode in force from this point on: log-only, non-surface,
     * whole-value replace. The last `model-routing/mode` wins; a log with none
     * folds to off through {@link foldModelRouting}.
     */
    'model-routing/mode': ModelRoutingModeRecord
    /**
     * One request's routing decision: log-only, append-only, and written after
     * the consult resolved the route, so a changed `request/header` that follows it
     * records the route it selected.
     */
    'model-routing/decision': ModelRoutingDecision
    /**
     * One child's routing decision at spawn: log-only, append-only, written on
     * the parent session before the child exists. Not ignorable.
     */
    'model-routing/child-decision': ModelRoutingChildDecision
    /**
     * One accounting turn's classified outcome for a routed child: log-only,
     * append-only, on the parent session. Not ignorable.
     */
    'model-routing/child-outcome': ModelRoutingChildOutcome
  }
}

declare module '@shres-code/shres-code-session-projection/types' {
  interface SessionProjectionMap {
    /** Routing mode, outstanding `/route` selection, last decision, and sticky state. */
    modelRouting: ModelRoutingProjection
    /** Routing counts, histograms, timeline, and recent decisions for the Routing view. */
    modelRoutingStats: ModelRoutingStatsSnapshot
  }
}
