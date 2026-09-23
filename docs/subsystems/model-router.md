# Model Routing

`ctx.modelRouting` ([shres-model-router](../../packages/llm/model-router)) decides which model runs one turn. The manual or default selection is always the strong model, and the configured `candidates` list is a downgrade allowlist — the enforcement point of the whole decision — so a consult selects a member of that list or nothing at all, never the manual route and never anything stronger. A downgrade is then held as a streak across consecutive turns, because a model transition costs a prefix re-prefill at production context sizes and a one-turn downgrade cannot repay it. Both the mode in force and the streak are folded from the session log, so resume, fork, compaction, and a process restart continue a held streak exactly as the live consult left it. The package ships in no default bundle; the [design note](../../.agents/notes/proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md) owns the rationale for the asymmetric allowlist and for the streak horizon.

Source: [`packages/llm/model-router/src/index.ts`](../../packages/llm/model-router/src/index.ts)

## The consult

`installModelSelection` ([shres-agent](../../packages/core/agent/src/model-selection.ts)) asks the optional service through its `ModelRoutingConsult` interface after the manual selection rewrote the request: a resolved route replaces provider, model, and reasoning effort, and `undefined` leaves the manual route in force. The initial request is judged once. While a downgrade is held, each later new step gets a fresh route and difficulty judgment over the latest surface with full capability assessment; a retry at the same step reuses that step's decision only while its complete candidate inputs are unchanged, after rechecking manual selection, allowlist membership, and capabilities. A manual, `kept-strong`, or `error` decision keeps the manual route for the rest of that turn, subject to the existing mode on/off override. The consult writes no prompt, no tool, and no request of its own; its only durable output is the decision event below.

The latest explicit `agent/model-selection` event is the manual selection authority, even when no request header exists or its provider/model/effort matches a routed header byte for byte. Resume and fork therefore recover manual intent before consulting the router's sticky base or a logged request header. Routing policy is unchanged: the consult may select only an eligible configured candidate for the current request, and the manual selection remains the fallback when the consult returns no route.

## Candidate eligibility and fitted state

Before asking the judgment engine, the router prepares every configured candidate through the registered LLM runtime. A candidate must accept the requested reasoning effort, preserve the manual route's declared context window and hosted-tool requirements, and support image input when the request contains an image. Unknown capability facts are excluded conservatively. These checks establish request compatibility; they do not establish that a candidate is cheaper, accurate, available remotely, or suitable for the task.

The router builds complete state alternatives from one live session surface snapshot. The first retains the configured context window, then older whole entries are removed progressively; the final alternative retains the current entry alone. `state.maxFitCandidates` bounds the alternatives offered, including that final current-entry alternative, and rejects values below `2`. No alternative is sliced mid-entry.

When `ctx.judgment.fitting` is available, the router sends the ordered alternatives and exact route/difficulty questions to its atomic fit-and-ask operation. The provider redacts and measures each candidate with one pinned tokenizer and model, then judges the first complete candidate that fits. The resulting decision records `judgmentInput` with the selected redacted text, selected index, token counts, applied limits, and manifest hash. If no candidate fits, the router records `judgmentRejection`, keeps the manual route with `judgment-input-too-large`, and performs no model inference. A provider without fitting receives the first bounded state and owns its input sizing.

```ts type-equiv
/** Stable result of one candidate capability check. */
type ModelRoutingCandidateEligibilityReason =
  | 'eligible'
  | 'base-unavailable'
  | 'base-context-unknown'
  | 'candidate-unavailable'
  | 'candidate-invalid'
  | 'difficulty-effort-invalid'
  | 'image-capability-unknown'
  | 'image-incompatible'
  | 'context-unknown'
  | 'context-too-small'
  | 'max-tokens-exceeds-context'
  | 'hosted-tools-incompatible'
```

```ts type-equiv
/** Detached, JSON-safe facts recorded for one configured candidate. */
interface ModelRoutingCandidateAssessment {
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
```

```ts type-equiv
/** Detached facts the helper used as the manual route's capability floor. */
interface ModelRoutingCandidateRequirements {
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
```

```ts type-equiv
/** Candidate list and detached capability assessments for one routing request. */
interface ModelRoutingCandidateEligibility {
  /** Detached manual-route requirements applied to each candidate. */
  readonly requirements: ModelRoutingCandidateRequirements
  /** The exact configured candidate list supplied by the caller. */
  readonly candidates: readonly ModelRoutingCandidate[]
  /** Candidates that passed every conservative capability check. */
  readonly eligibleCandidates: readonly ModelRoutingCandidate[]
  /** One detached assessment per configured candidate, in configuration order. */
  readonly assessments: readonly ModelRoutingCandidateAssessment[]
}
```

## Outcomes and the downgrade gate

```ts type-equiv
/** What one routing consult resolved for a turn. */
type ModelRoutingOutcome = 'downgraded' | 'kept-strong' | 'skipped' | 'error'
```

`downgraded` means an allowlisted candidate is selected for the judged request step; `kept-strong` that the manual route stands; `skipped` that a decision already taken was dropped because the mode went off under the turn; and `error` that the judgment call failed while `onUnavailable` is `error`. A downgrade needs both gate axes to pass: the route answer's `confidence` at or above `downgradeThreshold`, and its top-two probability margin (`top1 - top2`) at or above `downgradeMargin`. The documented operating points are `>= 0.8` and `>= 0.1`, above the ±0.06 run-to-run wobble measured on a rented classifier's borderline answers. A choice the allowlist does not contain is refused rather than trusted, and a candidate equal to the route already in force is not a downgrade at all.

## Why a turn resolved that way

```ts type-equiv
/**
 * Why a consult resolved that way. Each kept-strong class is its own reason
 * because the classes fail differently: an absent engine is a composition gap,
 * a low-confidence route is a judgment the operator may tune, and a broken
 * streak records what ended it.
 */
type ModelRoutingReason =
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
  /** The chosen candidate is the route already in force. */
  | 'candidate-equals-base'
  /** The judgment selected the current model instead of any downgrade candidate. */
  | 'current-preferred'
  /** The difficulty answer prevents entry into a downgraded streak. */
  | 'difficulty-too-high'
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
```

Each kept-strong class is its own reason because the classes fail differently: an absent or disabled judgment engine is a composition decision, a low confidence or a thin margin is a judgment an operator tunes with the two thresholds, and `gate-failed`, `escalated`, `manual-deviation`, `mode-off`, and `route-errors` record which exit ended a held streak. `sticky-hold` is the one reason that keeps a downgrade without a fresh pass: the gate failed while the streak is still below its horizon.

```ts type-equiv
/**
 * One logged routing outcome. The initial judgment and any later manual or
 * capability exit precede the request header that consumes their selection.
 * Decisions are log-only and append-only.
 */
interface ModelRoutingDecision {
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
}
```

One decision is logged per fresh judged request step as `model-routing/decision`, log-only and append-only: it is written after the consult resolved the step, so the `request/header` that follows it carries the route it selected and the consumed route is reconstructable from the log. `stateHash` and `stateSeqs` record the state the judgment read, so a rerun over the same state is recognizable; neither gates a decision. `selection` is present for a downgraded outcome only, `route`/`difficulty`/`engine`/`model`/`latencyMs` record what the engine answered and how long it took, and `hint` is advisory — it appears while the manual route stands and never changes it.

## The sticky streak

A held downgrade survives a failed gate until `minTurnsDowngraded` turns have elapsed; the documented horizon is 5, and `0` disables stickiness so every turn is judged on its own. While a streak is held, every new step is judged against the latest surface with fresh route and difficulty answers and full capability assessment. A same-step retry reuses its step's decision only while its complete candidate inputs are unchanged, after rechecking manual selection, allowlist membership, and capabilities. A turn that turns hard ends the streak immediately at any elapsed count once `difficulty.score` reaches `escalateBack.scoreThreshold` (documented 4). The streak also ends immediately when the manual provider or model differs from the route it was entered on — only those two fields are compared, so an unrelated header change such as a plan-mode toggle cannot break a streak — when `model-routing/mode` flips off, and when the durable route-failure streak reaches `maxRouteErrors` (documented 2). A manual, `kept-strong`, or `error` decision keeps the manual route for the rest of that turn, subject to the existing mode on/off override. The horizon counts turns, not steps.

These judgments use the latest bounded surface and establish routing mechanics only; they do not establish real-model task quality, completion, or security.

The same-step pin compares an exact serialized key of the raw candidate inputs before provider fitting or redaction. Compaction can therefore replace the context and force a fresh judgment within the same turn and step; the redacted fitted state's `stateHash` is not the retry key.

```ts type-equiv
/** Why a downgraded streak ended. */
type ModelRoutingBreakReason =
  | 'gate-failed'
  | 'current-preferred'
  | 'unknown-candidate'
  | 'candidate-ineligible'
  | 'escalated'
  | 'manual-deviation'
  | 'mode-off'
  | 'route-errors'
```

```ts type-equiv
/** The sticky-fold facts one active decision records about its streak. */
interface ModelRoutingActiveStickyView {
  /** A downgraded streak is in force after this decision. */
  active: true
  /** Turns elapsed since the streak was entered. */
  turnsElapsed: number
  /** Turn the streak was entered; absent only for malformed external records. */
  enteredTurn?: number
  /**
   * Manual route the streak was entered on. The consult records it because the
   * manual route is only in the log while the state is strong.
   */
  entryBase?: ModelRoutingEntryBaseView
  /** The route-error threshold that governs future durable failures in this streak. */
  routeErrorLimit: number
}
```

```ts type-equiv
/** The sticky-fold facts one inactive decision records. */
interface ModelRoutingInactiveStickyView {
  /** No downgraded streak is in force after this decision. */
  active: false
  /** Zero while strong. */
  turnsElapsed: number
  /** Why the streak ended, when this decision ended one. */
  brokenBy?: ModelRoutingBreakReason
  /**
   * Manual route to use while recovering from a route-error break. Ordinary
   * inactive decisions may carry this only when they preserve that durable
   * recovery record.
   */
  entryBase?: ModelRoutingEntryBaseView
}
```

```ts type-equiv
/** The discriminated sticky facts written into every routing decision. */
type ModelRoutingStickyView = ModelRoutingActiveStickyView | ModelRoutingInactiveStickyView
```

Every decision records the discriminated sticky facts as of itself. Active records retain the selected route, entry turn, entry base, and recorded route-error limit; inactive records identify the break and may retain the manual base while recovery is pending. A settings change supplies a new limit to the next decision and never reinterprets earlier failures.

```ts type-equiv
/** The sticky downgrade state as of a fold point. */
interface ModelRoutingStickyState {
  /** Whether a downgraded streak is in force. */
  readonly active: boolean
  /** Turns elapsed since the streak was entered; 0 while strong. */
  readonly turnsElapsed: number
  /** Turn the streak was entered; absent while strong. */
  readonly enteredTurn?: number
  /** Allowlisted route the streak holds; absent while strong. */
  readonly candidate?: ModelRoutingSelection
  /**
   * Manual route in force when the streak was entered, or the manual route
   * being checked during a pending route-error recovery. Omitted otherwise.
   */
  readonly entryBase?: ModelRoutingEntryBaseView
  /** Why the streak ended, when the fold passed its end. */
  readonly brokenBy?: ModelRoutingBreakReason
  /** The recorded route-error threshold while a streak is active. */
  readonly routeErrorLimit?: number
  /** Whether the next matching strong turn must complete before routing resumes. */
  readonly needsStrongTurn?: true
  /** Turn whose matching manual request is the recovery proof. */
  readonly recoveryTurn?: number
}
```

`stickyState(events, end?)` folds that state from `model-routing/decision`, `model-routing/mode`, `model-routing/configuration`, `turn/start`, `request/header`, and `turn/end`. Decisions are replayed rather than re-derived, so the fold is a pure function of the log: nothing survives in live memory, a restart or a fork inherits a held streak exactly as the consult left it, and a bench replays a run. The controller also retains pending mode changes and a current-step judgment pin. Uncommitted changes do not alter replay.

## Settings and the `/route` command

The plugin installs the `model-router` settings section, whose schema is its composition config, so every routing field is a validated deployment setting rather than a constant inside the plugin. The section is re-resolved per read behind a live source thunk; a stored section the resolver rejects is refused where it is written, naming the offending key, and a section that drifts beyond the schema while the process runs keeps the last good facts and logs once.

```ts type-equiv
/** The state window one judgment call reads. */
interface ModelRoutingStateConfig {
  /** Prior user messages of the conversation to include before the current turn's. Defaults to 2. */
  contextTurns?: number
  /** Hard cap on the assembled state text, in characters. Defaults to 12000. */
  maxChars?: number
  /** Maximum complete context alternatives offered to a tokenizer-aware provider. Defaults to 8. */
  maxFitCandidates?: number
}
```

```ts type-equiv
/** Composition config of the model router; also the `model-router` settings section. */
interface ModelRouterConfig {
  /** Deployment mode for sessions without an explicit user choice. Changes commit between requests. */
  initialMode: ModelRoutingInitialMode
  /**
   * Downgrade allowlist whose relative capability and cost the deployment owns.
   * An empty list leaves every turn on the manual route with `no-candidates`.
   */
  candidates?: ModelRoutingCandidateConfig[]
  /** Route confidence at or above which a candidate may be selected. Required. */
  downgradeThreshold: number
  /** Required top-two probability margin (`top1 - top2`) for a selection. Required. */
  downgradeMargin: number
  /**
   * Turns a downgraded streak is held before a failed gate may end it. `0`
   * disables stickiness (each turn is judged on its own), which keeps the
   * non-sticky design reachable and falsifiable. Defaults to 5.
   */
  minTurnsDowngraded?: number
  /** The choice question text asked about the conversation state. Required. */
  routeInstructions: string
  /**
   * The difficulty question text. Required by stickiness, `hardHint`, and
   * `difficultyToEffort`. When configured, every consult asks it and checks
   * the difficulty limit before allowing a downgrade.
   */
  difficultyInstructions?: string
  /** Ordered score descriptions, lowest first; scores use zero-based indices. Defaults to a five-level rubric. */
  difficultyLevels?: string[]
  /** Escalate-back operating point. */
  escalateBack?: ModelRoutingEscalateBackConfig
  /**
   * Consecutive candidate failures that require a manual-model turn. Recorded
   * on each held decision; settings changes affect subsequent decisions.
   * Defaults to 2.
   */
  maxRouteErrors?: number
  /** What a failed judgment call does to the turn. Defaults to `fallback`. */
  onUnavailable?: ModelRoutingUnavailablePolicy
  /**
   * Optional effort lift for a selected route on a hard turn. Omitted — or
   * written as a valueless key, which the schema resolves to null — means not
   * configured; the group is never implied by a default.
   */
  difficultyToEffort?: ModelRoutingDifficultyToEffortConfig
  /**
   * Optional advisory hint while the manual route stands. Omitted — or a
   * valueless key — means not configured, so a deployment without it is not
   * asked for the difficulty question.
   */
  hardHint?: ModelRoutingHardHintConfig
  /** The state window each judgment call reads. */
  state?: ModelRoutingStateConfig
  /** Judgment tier each call runs at. Defaults to `fast`. */
  tier?: 'fast' | 'accurate'
}
```

`resolveConfig` re-judges what the declaration cannot express: presence, bounds, and cross-field requirements. `routeInstructions` and both thresholds are required; a candidate needs a non-empty id, provider, and model, and no two candidates may share an id; an unknown key fails by name; and `difficultyInstructions` is required while `minTurnsDowngraded` is above zero or `hardHint` is set, because a held downgrade re-judges every turn and the hint reads the difficulty answer. Whether a judgment engine is composed at all is the [judgment](judgment.md) settings section's concern, not this one's.

`/route` reports the mode in force and any held streak; `/route on` and `/route off` select a persistent user mode. A same-valued choice records user authority immediately. A changed value during an open turn waits for the next accepted pre-step; rejection or cancellation does not commit it. Deployment defaults use `model-routing/configuration` and stop affecting a session after its first explicit `model-routing/mode`. Cold sessions retain their log-derived mode until they acquire a live routing owner. Status and invalid commands never create a pending mode indication.

The `modelRouting` projection folds the `/route` records, the committed mode, the last decision, the sticky state, and the retained entry base of the last streak into one wire value, so a UI renders the routing mode and offers the restore of a session whose own selection is the routing target without reading the log. `lastStrong` is what makes that restore possible: the fold drops `entryBase` the moment a streak breaks, and a session stuck on `candidate-equals-base` has no active streak to read one from. Capability absence — model-router not composed — is the projection key's absence rather than an empty value.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmodelrouting--modelroutingcontroller"></a>

### `ctx.modelRouting` — `ModelRoutingController`

`ctx.modelRouting`: owns the logged routing mode, routing decisions, and the consult `installModelSelection` reaches. No live mirror of the mode is kept — the log is the state — and its configuration, mode, and decision events write no prompt, tool, or model request.

```ts cordis-catalog
/**
 * The resolved configuration in force, re-resolved per read and memoized by
 * the raw snapshot's identity.
 *
 * There is no keep-last-good recovery here on purpose: a settings write this
 * resolver could not act on is refused by the `validate` hook below before it
 * commits, and the settings seam keeps a namespace's last good value when an
 * already-stored section fails to resolve — so a bad value reaches this method
 * only from a caller that bypassed both, and failing loud there is the honest
 * answer rather than masking a configuration the deployment did not write.
 * @returns the resolved configuration.
 */
config(): ResolvedModelRouterConfig

/**
 * Read the logged mode and any selection awaiting the next accepted pre-step.
 * @param agent - the agent to read.
 * @returns the mode in force plus a pending selection, when present.
 */
get(agent: Agent): { active: boolean; pending?: boolean }

/**
 * The mode in force on one session, derived from committed configuration
 * and user mode events. A log with neither starts off.
 * @param session - the session to read.
 * @param end - fold the first `end` events; defaults to the whole log.
 * @returns whether routing is active.
 */
modeOf(session: Session, end: number = session.events.length): boolean

/**
 * Switch routing on or off. Between turns the change is appended
 * immediately; a changed value during an open turn waits for the next
 * accepted pre-step. An explicit choice equal to the current value records
 * user authority immediately and prevents later settings from overriding it.
 * @param agent - the agent to switch.
 * @param active - whether routing should be active.
 * @returns what happened: `committed`, `queued`, `cancelled`, or `noop`.
 */
set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'

/**
 * Resolve the route one request should run. Called by
 * `installModelSelection` after the manual selection rewrote the request: a
 * non-undefined result replaces provider/model/effort, and `undefined` leaves
 * the manual route in force.
 *
 * Each new downgraded step reassesses the latest task evidence. Same-step
 * retries reuse the judgment only while its complete candidate inputs are
 * unchanged, and recheck manual authority, allowlist membership, and
 * capabilities. A manual-model decision lasts for the turn.
 * @param agent - the agent whose turn is being prepared.
 * @param turn - the turn number, as the loop dispatched it.
 * @param step - the step number within the turn; retries share its judgment.
 * @param base - the route the manual selection left in force.
 * @param signal - the request's cancellation signal.
 * @param request - frozen conversation content and the manually selected call configuration.
 * @returns the route to run, or `undefined` to keep the manual route.
 */
async resolveRequest( agent: Agent, turn: number, step: number, base: ModelSelection, signal: AbortSignal, request: ModelRoutingRequest, ): Promise<ModelSelection | undefined>

/**
 * Report the manual selection a held downgrade descends beneath.
 *
 * A held streak rewrites the consumed `request/header` to the candidate, so
 * that header stops reporting the route the session is pointed at; a reader
 * asking for the session's selection asks this first. The answer is the same
 * fold the consult reads — no live mirror — and the effort is the one the
 * streak was entered on, because that is what the manual route still runs at.
 * When the streak has just ended, the last request header can still carry its
 * candidate. In that case the decision immediately before that header retains
 * the manual entry route until a later manual header replaces it. A decision
 * logged after the header is ignored because it may be a crash-orphaned turn.
 * @param agent - the agent whose selection is being read.
 * @returns the manual route behind an active streak or the last routed header
 *   awaiting replacement; `undefined` when the logged header is already manual.
 */
stickySelection(agent: Agent): ModelSelection | undefined
```

Types: [Agent](core.md) · [ModelRoutingRequest](core.md) · [ModelSelection](core.md) · [Session](session.md)

Source: [`packages/llm/model-router/src/index.ts:320`](../../packages/llm/model-router/src/index.ts)
<!-- END GENERATED cordis-surface -->
