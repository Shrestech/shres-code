# Model Routing

`ctx.modelRouting` ([shres-model-router](../../packages/llm/model-router)) decides which model runs one turn. The manual or default selection is always the strong model, and the configured `candidates` list is a downgrade allowlist — the enforcement point of the whole decision — so a consult selects a member of that list or nothing at all, never the manual route and never anything stronger. A downgrade is then held as a streak across consecutive turns, because a model transition costs a prefix re-prefill at production context sizes and a one-turn downgrade cannot repay it. Both the mode in force and the streak are folded from the session log, so resume, fork, compaction, and a process restart continue a held streak exactly as the live consult left it. The package ships in no default bundle; the [design note](../../.agents/notes/proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md) owns the rationale for the asymmetric allowlist and for the streak horizon.

Source: [`packages/llm/model-router/src/index.ts`](../../packages/llm/model-router/src/index.ts)

## The consult

`installModelSelection` ([shres-agent](../../packages/core/agent/src/model-selection.ts)) asks the optional service through its `ModelRoutingConsult` interface after the manual selection rewrote the request: a resolved route replaces provider, model, and reasoning effort, and `undefined` leaves the manual route in force. One decision is taken per turn and reused by later steps and by same-turn request retries. The consult writes no prompt, no tool, and no request of its own; its only durable output is the decision event below.

## Outcomes and the downgrade gate

```ts type-equiv
/** What one routing consult resolved for a turn. */
type ModelRoutingOutcome = 'downgraded' | 'kept-strong' | 'skipped' | 'error'
```

`downgraded` means an allowlisted candidate is selected for the turn; `kept-strong` that the manual route stands; `skipped` that a decision already taken was dropped because the mode went off under the turn; and `error` that the judgment call failed while `onUnavailable` is `error`. A downgrade needs both gate axes to pass: the route answer's `confidence` at or above `downgradeThreshold`, and its top-two probability margin (`top1 - top2`) at or above `downgradeMargin`. The documented operating points are `>= 0.8` and `>= 0.1`, above the ±0.06 run-to-run wobble measured on a rented classifier's borderline answers. A choice the allowlist does not contain is refused rather than trusted, and a candidate equal to the route already in force is not a downgrade at all.

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
```

Each kept-strong class is its own reason because the classes fail differently: an absent or disabled judgment engine is a composition decision, a low confidence or a thin margin is a judgment an operator tunes with the two thresholds, and `gate-failed`, `escalated`, `manual-deviation`, `mode-off`, and `route-errors` record which exit ended a held streak. `sticky-hold` is the one reason that keeps a downgrade without a fresh pass: the gate failed while the streak is still below its horizon.

```ts type-equiv
/**
 * One logged routing decision for one turn. Log-only and append-only: the
 * decision is written after the consult resolved the turn, so the consumed
 * `request/header` that follows it carries the route it selected.
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

One decision is logged per judged turn as `model-routing/decision`, log-only and append-only: it is written after the consult resolved the turn, so the `request/header` that follows it carries the route it selected and the consumed route is reconstructable from the log. `stateHash` and `stateSeqs` record the state the judgment read, so a rerun over the same state is recognizable; neither gates a decision. `selection` is present for a downgraded outcome only, `route`/`difficulty`/`engine`/`model`/`latencyMs` record what the engine answered and how long it took, and `hint` is advisory — it appears while the manual route stands and never changes it.

## The sticky streak

A held downgrade survives a failed gate until `minTurnsDowngraded` turns have elapsed; the documented horizon is 5, and `0` disables stickiness so every turn is judged on its own. While a streak is held the turn is still judged and the difficulty question is mandatory, so a turn that turns hard ends the streak immediately at any elapsed count once `difficulty.score` reaches `escalateBack.scoreThreshold` (documented 4). The streak also ends immediately when the manual provider or model differs from the route it was entered on — only those two fields are compared, so an unrelated header change such as a plan-mode toggle cannot break a streak — when `model-routing/mode` flips off, and when the durable route-failure streak reaches `maxRouteErrors` (documented 2).

```ts type-equiv
/** Why a downgraded streak ended. */
type ModelRoutingBreakReason =
  | 'gate-failed'
  | 'escalated'
  | 'manual-deviation'
  | 'mode-off'
  | 'route-errors'
```

```ts type-equiv
/** The sticky-fold facts one decision records about the streak it belongs to. */
interface ModelRoutingStickyView {
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
```

Every decision records the streak facts as of itself: `active` after it, `turnsElapsed` since the streak was entered (0 while strong), `enteredTurn` while one is in force, `brokenBy` when this decision ended one, and `entryBase`, which the record carries because the manual route is only in the log while the state is strong — a streak entered on the very first turn has no preceding `request/header` to read it from.

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
   * Manual provider/model in force when the streak was entered, read from the
   * last `request/header` before the entering decision. Absent while strong.
   * This is the route a manual switch is compared against, and only its
   * provider/model fields count — an unrelated header change (a plan-mode
   * toggle rewriting `header.system`) must not end a streak.
   */
  readonly entryBase?: ModelRoutingEntryBaseView
  /** Why the streak ended, when the fold passed its end. */
  readonly brokenBy?: ModelRoutingBreakReason
}
```

`stickyState(events, config, end?)` folds that state from `model-routing/decision`, `model-routing/mode`, `turn/start`, `request/header`, and `turn/end`. Decisions are replayed rather than re-derived, so the fold is a pure function of the log: nothing survives in live memory, a restart or a fork inherits a held streak exactly as the consult left it, and a bench replays a run. The only in-memory routing state is the intra-turn pin, which reuses one decision for the later steps and retries of the same turn.

## Settings and the `/route` command

The plugin installs the `model-router` settings section, whose schema is its composition config, so every routing field is a validated deployment setting rather than a constant inside the plugin. The section is re-resolved per read behind a live source thunk; a stored section the resolver rejects is refused where it is written, naming the offending key, and a section that drifts beyond the schema while the process runs keeps the last good facts and logs once.

```ts type-equiv
/** Composition config of the model router; also the `model-router` settings section. */
interface ModelRouterConfig {
  /** Whether routing starts in force. Required: a stored mode is an explicit deployment choice. */
  initialMode: ModelRoutingInitialMode
  /**
   * Downgrade allowlist. Routing may select a member of this list or nothing —
   * never the manual route and never anything stronger — so an empty list
   * leaves every turn on the manual route with `no-candidates` logged.
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
   * The difficulty question text. Required at load while
   * `minTurnsDowngraded > 0`: a held downgrade re-judges every turn and needs
   * the difficulty answer to escalate back immediately.
   */
  difficultyInstructions?: string
  /** Ordered difficulty-level descriptions for the score question, lowest first. Defaults to a five-level rubric. */
  difficultyLevels?: string[]
  /** Escalate-back operating point. */
  escalateBack?: ModelRoutingEscalateBackConfig
  /** Durable route-failure streak at which a held downgrade escalates back immediately. Defaults to 2. */
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

`/route` reports the mode in force and any held streak, `/route on` and `/route off` switch it, and any other argument prints the usage line. Between turns the switch is appended immediately as the log-only `model-routing/mode` event; during an open turn it waits for the next accepted in-turn pre-step, like every other logged mode in this harness, and the command reports `committed`, `queued`, `cancelled`, or `noop`.

The `modelRouting` projection folds the `/route` records, the committed mode, the last decision, and the sticky state into one wire value, so a UI renders the toggle, the hint line, and the held route without reading the log. Capability absence — model-router not composed — is the projection key's absence rather than an empty value.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmodelrouting--modelroutingcontroller"></a>

### `ctx.modelRouting` — `ModelRoutingController`

`ctx.modelRouting`: owns the logged routing mode, the per-turn decision, and the consult `installModelSelection` reaches. No live mirror of the mode is kept — the log is the state — and beyond its two routing events it writes nothing: no prompt, no tool, and no request of its own.

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
 * The mode in force on one session: the last logged `model-routing/mode`
 * wins, and a log with none starts from the configured `initialMode`.
 * @param session - the session to read.
 * @param end - fold the first `end` events; defaults to the whole log.
 * @returns whether routing is active.
 */
modeOf(session: Session, end: number = session.events.length): boolean

/**
 * Switch routing on or off. Between turns the change is appended
 * immediately; during an open turn it waits for the next accepted in-turn
 * pre-step, like every other logged mode in this harness.
 * @param agent - the agent to switch.
 * @param active - whether routing should be active.
 * @returns what happened: `committed`, `queued`, `cancelled`, or `noop`.
 */
set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'

/**
 * Resolve the route one turn should run. Called by
 * `installModelSelection` after the manual selection rewrote the request: a
 * non-undefined result replaces provider/model/effort, and `undefined` leaves
 * the manual route in force.
 *
 * One decision per turn: later steps of the same turn and same-turn request
 * retries reuse the pinned decision instead of judging again.
 * @param agent - the agent whose turn is being prepared.
 * @param turn - the turn number, as the loop dispatched it.
 * @param _step - the step number within that turn; underscore-prefixed because
 *   the pin is keyed by turn, so the decision is taken once and later steps
 *   reuse it.
 * @param base - the route the manual selection left in force.
 * @param signal - the request's cancellation signal.
 * @returns the route to run, or `undefined` to keep the manual route.
 */
async resolveRequest( agent: Agent, turn: number, _step: number, base: ModelSelection, signal: AbortSignal, ): Promise<ModelSelection | undefined>
```

Types: [Agent](core.md) · [ModelSelection](core.md) · [Session](session.md)

Source: [`packages/llm/model-router/src/index.ts:232`](../../packages/llm/model-router/src/index.ts)
<!-- END GENERATED cordis-surface -->