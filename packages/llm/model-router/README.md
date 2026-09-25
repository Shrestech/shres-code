# @shres-code/shres-code-model-router

The router chooses between keeping the manual/default model and using a configured candidate. The deployment owns the **downgrade allowlist**: it must establish which candidates are cheaper and capable enough for its tasks. Confidence and probability-margin thresholds limit entry into a downgrade, and a pure fold over the session log holds the selected candidate across turns to reduce model transitions.

`ctx.modelRouting` consults `ctx.judgment`, records committed deployment mode, explicit user mode, and routing decisions as log-only session events, folds its state from the log, registers the `/route` command and the `modelRouting` and `modelRoutingStats` projections, serves the `modelRouting` Remote namespace, and installs the `model-router` settings namespace. It ships in no default bundle: nothing happens until a deployment composes it.

## Config

Every field is validated at plugin load (and again for a settings write), and unknown keys fail by name.

| Key | Default | Effect |
|---|---|---|
| `initialMode` | required | `on`\|\|`off`: deployment mode for live sessions without an explicit user choice. |
| `candidates` | `[]` | The one shared pool of downgrade candidates: `{ id, provider, model, reasoningEffort?, description }`. Ids are unique, non-empty, and not the reserved `keep-current`. `description` is required and at most 160 characters: every description is sent in every judgment question. An empty pool logs `no-candidates`. A held candidate removed from the pool ends its streak with `unknown-candidate`. |
| `routeFrom` | `[]` | Fail-closed allowlist of strong routes routing may start from: `{ provider, model, objective, allowEveryTurn? }`, matched on provider and model. `objective` is required: `quota` (subscription or credit plan), `dollars` (metered key), or `latency`. A route may be listed once. `latency` requires `judgmentDeadlineMs` of at most 200. Under the per-turn entry policy a `quota` route requires `allowEveryTurn: true`. An unlisted manual route keeps its model with `base-unlisted` and no judgment call. Must be non-empty unless `initialMode` is `off`. |
| `downgradeThreshold` | required | Route-answer confidence at or above which a candidate may be selected. |
| `downgradeMargin` | required | Required `top1 - top2` probability margin. Both axes are required: a confident-but-close answer is not a downgrade. |
| `routeInstructions` | required | The choice question text asked about the conversation state. |
| `difficultyInstructions` | — | The difficulty question text. Required while `hold.minSteps > 0`, `hardHint`, or `difficultyToEffort` is set. Every fresh step consult asks it when configured; a same-step retry reuses that step's judgment only while its complete candidate inputs are unchanged, after revalidation. |
| `difficultyLevels` | five-level rubric | Ordered descriptions, lowest first. Scores are weighted zero-based indices: five levels span `0..4`. All thresholds must fit the configured scale. |
| `hold.minSteps` | `20` | Model steps a downgrade is held before a failed gate or a different candidate may end it. Every `step/start` while the streak holds counts, including later steps of the entering turn. `0` disables stickiness (every step judged on its own). Must not exceed `hold.maxSteps`. |
| `hold.maxSteps` | `40` | Model steps after which the next consult returns to the manual model with `hold-cap`, without a judgment call. |
| `difficulty.entryScoreCeiling` | `2` | Difficulty at or above which a streak is not entered (`difficulty-too-high`). Must not exceed `escalateBack.scoreThreshold`; the default is not lowered to fit a lower threshold or a shorter rubric. |
| `escalateBack.scoreThreshold` | `3` | Difficulty at or above which a held streak returns to the manual model (`escalated`). A score between the entry ceiling and this threshold holds a streak but does not enter one. With the default rubric, `3` is “hard”. |
| `reentryCooldownTurns` | `2` | Turns after the turn whose `escalated`, `current-preferred`, or `route-failed` decision ended a streak that keep the manual model without a judgment call, logged as `reentry-cooldown`. `0` disables the cooldown. |
| `maxRouteErrors` | `2` | Consecutive candidate failures that require a manual-model recovery turn: terminal failures of a held route, or `route-failed` decisions for one candidate across streaks. Each held decision records its effective limit. |
| `onUnavailable` | `fallback` | `fallback` keeps the manual route and logs the class; `error` logs the `error` outcome instead. A held streak within its hold tolerance keeps its candidate under either policy. |
| `judgmentDeadlineMs` | `1500` | Milliseconds one judgment call may take. The call runs under the turn's signal combined with this deadline; expiry records `engine-unavailable` with `engineFailure.code: DEADLINE`, and an answer arriving later is not used. A positive integer of at most `30000`. |
| `judgmentFailures.holdTolerance` | `2` | Consecutive failed judgment calls a held streak survives, keeping its candidate with `judgment-failure-held`; the next failure ends it. `0` ends a held streak at the first failure. |
| `judgmentFailures.breakerThreshold` | `3` | Consecutive failed judgment calls that open the breaker. Only an answered call resets the count, so after the breaker closes one more failure opens it again. |
| `judgmentFailures.breakerOpenTurns` | `5` | Turns after the latest failure during which an open breaker keeps the manual route with `breaker-open` and no judgment call. `0` disables the breaker. |
| `inTurnFallback` | `manual` | `manual` retries a failed downgraded request's step on the manual route after every other recovery listener declined, logging `route-failed`; `off` leaves the failure terminal. |
| `difficultyToEffort` | — | `{ scoreThreshold, reasoningEffort }`: a candidate entering a streak on a step at or above the threshold runs at this effort. Entry requires a score below `difficulty.entryScoreCeiling`, so the threshold must be below the ceiling; load fails by name otherwise. The streak keeps its entry effort; a later effort change is a candidate change. |
| `hardHint.scoreThreshold` | — | While the manual route stands, a difficulty score at or above this adds the `consider-stronger` hint to the decision. |
| `state.contextTurns` | `2` | Prior user messages included in the judged state, before the current turn's. |
| `state.maxChars` | `12000` | Hard cap on the complete JSON state, including omission markers; whole entries are admitted newest first. |
| `state.maxFitCandidates` | `8` | Maximum complete state alternatives offered to a tokenizer-aware judgment provider; it must be an integer of at least `2`. |
| `tier` | `fast` | Judgment tier each call runs at. |

## Composition

```yaml
- name: '@shres-code/shres-code-model-router'
  config:
    initialMode: 'off'
    candidates:
      - id: cheap
        provider: deepseek
        model: deepseek-v4-flash
        description: a small, well-scoped change in familiar code
    downgradeThreshold: 0.8
    downgradeMargin: 0.1
    routeInstructions: >-
      Which route should handle this turn's work? Choose the cheapest route that
      is still a safe fit, or the strongest route when the turn is ambiguous.
    difficultyInstructions: >-
      How hard is this turn for the model handling it?
```

The operating points in that snippet are the documented ones: `>= 0.8` confidence and `>= 0.1` margin sit above the ±0.06 run-to-run wobble measured on borderline classifier answers. `initialMode: 'off'` is the safe starting point — a deployment turns routing on through the `/route` command or a settings write, and an initially off run without explicit routing commands writes no routing events, which is what makes it byte-identical to a composition without this package.

Deployment mode changes are recorded as `model-routing/configuration`; explicit `/route on|off` choices are recorded as `model-routing/mode`. A user choice remains authoritative across settings updates, including a choice equal to the current mode. Changed values wait for the next accepted pre-step during an open turn. Cold sessions retain their recorded mode until resumed under a live router. Projections read only these durable facts, so startup, settings changes, and replay display the mode that execution uses.

## Asymmetric policy

The choice question always includes `keep-current` plus every eligible allowlisted candidate. A candidate naming the manual provider/model is never eligible, at any reasoning effort: eligibility records it as `equals-base` before any metadata lookup, an allowlist holding only such candidates resolves `candidate-equals-base` without a judgment call, and an answer that names one is read as `keep-current`. Each option names its provider/model and explicit reasoning effort; candidate descriptions supply deployment-specific capability guidance. Selecting `keep-current` retains the manual model immediately, including during a sticky streak. A high difficulty answer also keeps the manual model before any confidence or margin check. Missing required answers keep the manual model.

A manual route whose metadata declares `thinkingMode: 'budget'` and whose effective effort enables reasoning excludes every other candidate as `thinking-mode-incompatible`, and the consult resolves `thinking-mode-incompatible` without a judgment call: Anthropic keeps thinking across a tool-use continuation only from the signed thinking of earlier assistant turns, which a routed segment does not carry, so a return to a budget-thinking route would run without thinking. Adaptive-thinking routes, which is every `claude-session` model, are unaffected. The `modelRouting` projection's `returnThinking` reports whether the first assistant reply after the last streak a decision ended carried a reasoning block, which is the observed check for adaptive routes. It has limits: only a decision that ends a streak arms it, so a streak ended by switching routing off or by the route-errors recovery leaves it unchanged, and `absent` also covers a manual route that never reasons. It is projection-only, and nothing reads it yet.

`routeFrom` bounds where routing may start and the pool bounds where it may go; together they do not order candidates by cost or strength, so a pool model can be a lateral or upward move from some listed route, and neither establishes judgment accuracy. Every decision resolved against a listed route records that route's `objective`; the router enforces no prices. Exact provider metadata and call preparation must accept each candidate's route and reasoning settings. Image-bearing requests require declared image support. A candidate must preserve the manual model's declared context capacity and hosted tools; unknown context capacity prevents a downgrade. This conservative capacity comparison does not prove token fit across different tokenizers.

The router builds complete state alternatives from the same live surface snapshot. It starts with the full retained context and progressively removes the oldest whole entries, keeping the current entry in the final alternative. `state.maxFitCandidates` bounds the offered list, including that final current-entry alternative. When the judgment provider exposes atomic fitting, it redacts and measures these alternatives with one pinned tokenizer and model, then judges the first fitting alternative. Exact fit does not establish route quality: candidate descriptions, capability checks, confidence, margin, task completion, and adversarial regressions remain separate concerns.

The decision records the exact candidate eligibility facts and question list. A fitted answer records `judgmentInput` with the selected redacted state, selected index, token counts, applied limits, and manifest hash. When every complete alternative exceeds capacity, the router records `judgmentRejection`, keeps the manual route with `judgment-input-too-large`, and performs no judgment inference. A provider without `fitting` uses the bounded first state and leaves token sizing to the provider.

Every fallback resolves to the manual route with a logged reason:

| Class | Reason |
|---|---|
| No judgment engine composed | `engine-absent` |
| Engine composed, deployment turned it off | `engine-disabled` |
| Engine unreachable, refused, or past `judgmentDeadlineMs` | `engine-unavailable` |
| Engine answered with an unusable body | `invalid-answer` |
| Manual route not listed in `routeFrom` | `base-unlisted` |
| No candidates configured | `no-candidates` |
| Generation runtime unavailable for capability checks | `model-unavailable` |
| No eligible candidate, or held candidate loses required capabilities | `candidate-ineligible` |
| Complete current message exceeds the state budget | `state-too-large` |
| No complete state and question batch fits the pinned tokenizer | `judgment-input-too-large` |
| Chosen route is not on the allowlist | `unknown-candidate` |
| Confidence below the floor | `low-confidence` |
| Top-two margin below the floor | `thin-margin` |
| Every configured candidate is the manual provider/model, at any effort | `candidate-equals-base` |
| The manual route declares `budget` thinking and its effort enables reasoning | `thinking-mode-incompatible` |
| Judge selects `keep-current` or names a candidate that is the manual provider/model | `current-preferred` |
| Difficulty at or above the entry ceiling prevents a downgrade | `difficulty-too-high` |
| Downgraded request failed and no other recovery listener retried it | `route-failed` |
| A held streak reached `hold.maxSteps` | `hold-cap` |
| A quality exit ended a streak within the last `reentryCooldownTurns` turns | `reentry-cooldown` |
| Consecutive failed judgment calls opened the breaker | `breaker-open` |

Cancellation propagates without appending or pinning a decision, including when a judgment resolves after its request was cancelled. A later retry judges the request again.

A failed judgment call — `engine-unavailable`, `invalid-answer`, or `judgment-error` — records the engine's error code, or `DEADLINE`, in `engineFailure` when one is known. While a streak holds, the first `judgmentFailures.holdTolerance` consecutive failures keep its candidate as a `downgraded` / `judgment-failure-held` decision instead of ending it. The fold counts consecutive failed calls and the turn of the latest; an answered call clears the count. Once the count reaches `judgmentFailures.breakerThreshold`, consults within `judgmentFailures.breakerOpenTurns` turns of the latest failure record `breaker-open` without a judgment call. `state-too-large` and `judgment-input-too-large` describe the input rather than the engine, so they neither count nor hold a streak.

The `route-failed` fallback runs in the `agent/request-error` waterfall. The router calls `next()` first, so a downstream recovery listener such as llm-retry keeps transient retries of the candidate in any listener order. Only when nothing downstream retries, the failure is not a cancellation, and the failed request is the step this router downgraded does it log `route-failed`, re-pin the step to the manual route recorded as the streak's entry base, and return `retry`. The step's retry then runs on the manual model without another judgment, and the turn completes there. A failure of that manual retry is terminal. [The subsystem page](../../../docs/subsystems/model-router.md#in-turn-fallback) owns the full condition.

## Sticky fold

A model transition costs a prefix re-prefill at production context sizes (a 250–624K re-prefill, against a per-turn saving of cents), so a downgrade has to persist many steps to net positive. The streak is the hysteresis layer:

- The manual route is **STRONG**. A request whose difficulty is below `difficulty.entryScoreCeiling` and whose candidate answer passes both confidence and margin thresholds enters **DOWNGRADED(candidate, enteredTurn, enteredStep, entryBase)**.
- While DOWNGRADED, every new step is judged against the latest surface with a fresh route and difficulty answer and a full capability assessment. A retry at the same step reuses that step's decision only while its complete candidate inputs are unchanged, after rechecking manual selection, `routeFrom` and pool membership, and capabilities. The held selection's reasoning effort is fixed at entry: later steps that re-affirm the candidate keep it, whatever their difficulty answers. A different candidate, or the held candidate at an effort the current configuration no longer offers, cannot replace the held selection before the horizon, and a difficulty score in the band between the entry ceiling and the exit threshold never lets it replace the held selection. After the horizon, an accepted candidate change below the band starts a new streak with its own entry turn and step. A candidate removed from the allowlist cannot remain held.
- DOWNGRADED returns to STRONG when the gate fails after the horizon (`gate-failed`), or immediately when the judge selects `keep-current` or names a candidate that is the manual provider/model (`current-preferred`), difficulty reaches the threshold (`escalated`), the manual provider/model changes (`manual-deviation`), the manual route is removed from `routeFrom` (`base-unlisted`), candidate capabilities no longer satisfy the request (`candidate-ineligible`), routing turns off (`mode-off`), a downgraded request fails and its step retries on the manual route (`route-failed`), durable route failures reach `maxRouteErrors` (`route-errors`), or the streak reaches `hold.maxSteps` (`hold-cap`, without a judgment call). A manual, `kept-strong`, or `error` decision keeps the manual route for the rest of that turn. A committed mode-off still releases the turn's pin and records `skipped`; a later mode-on can begin a fresh decision under the existing mode semantics.
- An `escalated`, `current-preferred`, or `route-failed` exit starts the re-entry cooldown: the next `reentryCooldownTurns` turns keep the manual model with `reentry-cooldown` and no judgment call. The fold derives it from the ending decision's turn. Other exits start no cooldown.

The horizon and the cap count model steps, not turns. Fresh step judgments use the bounded latest surface, so these mechanics do not establish real-model routing quality, task completion, or security.

The same-step pin compares an exact serialized key of the raw candidate inputs before provider fitting or redaction. Compaction can therefore replace the context and force a fresh judgment within the same turn and step; the redacted fitted state's `stateHash` is not the retry key.

The streak is a **pure fold** (`stickyState(events)`) over routing decisions, committed mode changes, request headers, and turn and step events. Full-log replay and the session projection share its transition function. Every active decision records `routeErrorLimit`; settings changes reach the next decision and never reinterpret earlier failures. Active records without a valid limit are rejected. Terminal failure counts reset when the streak ends or its selected route changes. `route-failed` decisions count against their candidate across the streaks they end, and that count resets on a completed turn on the candidate, on a different candidate's failure, or at a route-error break. `hold.minSteps: 0` makes routing non-sticky.

Reaching the recorded failure limit requires a manual-model recovery turn before another downgrade. The controller records `route-errors` without asking the judge. Recovery clears only after a matching manual request header and a completed or failed recovery turn; cancellation, interruption, or a decision without the matching header leaves recovery pending across resume. A manual selection change within the recovery turn updates the recorded route. Switching routing off does not erase pending recovery.

Only the **provider/model comparison** counts when the manual route is compared with `entryBase`: an unrelated change to another part of the request header — a plan-mode toggle rewriting `header.system` — must not end a streak.

While a streak holds, the consumed `request/header` carries the candidate, so a reader that reports the session's model selection asks `stickySelection(agent)` before trusting that header. The answer is the route the streak was entered on, reasoning effort included, folded by the same `stickyState` the consult reads: a resumed, forked, or reconnected session reports the manual route rather than the router's own rewrite, and the manual route stays authoritative for what it owns — assembly, the request when no router resolves one, and the base the next consult compares against.

After a streak ends, the last header can still contain the routed candidate. The router retains the manual base from the decision that produced that header until a later manual header replaces it. Provider-applied effort defaults do not count as a manual effort change. A decision logged after the last header cannot erase its base before the next request is recorded.

An explicit manual selection is recorded as `agent/model-selection` before request routing. That durable event remains authoritative when no request header exists or when the selected provider/model/effort is byte-identical to a routed header, so resume and fork recover manual intent. The router still applies its configured downgrade policy to the current request and returns to that manual base when the route ends.

## Command and projection

`/route` reports the mode and any held streak, `/route on` and `/route off` switch it. Between turns the switch is appended immediately; during an open turn it waits for the next accepted pre-step, exactly like plan mode. The `modelRouting` projection folds the command record, the mode commit, the last decision, the sticky state, and the last entered streak base into one wire value (`{ active, pending, last?, sticky?, lastStrong? }`) so a UI renders the routing mode, and restores a session whose own selection is the routing target, without reading the log itself. The routed model, its confidence, and the streak position render in the trajectory, which folds the decisions themselves.

Only messages with `source.kind: user` define the current request and prior-turn window. Plugin context remains optional evidence even when it is logged as `user/message` after the user request. Provider `INPUT_TOO_LARGE` failures keep the manual route with `judgment-input-too-large`; the configured request byte cap must accommodate the complete serialized alternatives and questions.

## Routing statistics and Remote reads

The `modelRoutingStats` projection is a pure fold of one session's log (`src/stats.ts`) into the Routing view's statistics: decision and step counts; reason (grouped as switched, judge-no, fail-closed, and engine), kept-strong, and streak-exit histograms; streak lengths; per-consult best-candidate confidence and top-two margin; a judge latency histogram with 1-2-5 millisecond buckets up to 30 s, whose percentiles are exact to one bucket; per-model steps, calls, and input token classes; cold prefills by first-matching cause; tokens moved to candidates and re-written on the return to the manual route; judge asks and state characters per engine; the judge's reported token usage; the distinct thresholds answered consults applied; a step timeline with routing marks; and the most recent decisions. A decision's optional judgment-call facts are used when present: `engineId` names the engine on answers and failures (else the answering provider's name); `inputChars` makes state characters exact (else the recorded judgment input's length, else `stateProjection.maxChars` as an upper bound); a failed ask's `latencyMs` joins the latency histogram, and `eligibilityMs` is added to an ask's latency; `judgeUsage` sums into the judge's tokens; and a warm-up, whose `engineFailure.engineState` shows the engine was still becoming ready, counts apart from failed judgments and sends nothing. `engine-uncalibrated` groups as fail-closed. A decision is positioned at the latest `step/start`, a call is an `assistant/message` carrying `usage`, a step is attributed to the model of its last call, and a call is candidate-served when the latest decision in its turn downgraded to its provider and model. Input tokens follow the `TokenUsage` presence contract, so a call without cache counts contributes its whole prompt as unreported input. The log records no prompt-cache lifetime, so idle expiry uses 300 s and the value reports `coldTtl.fallback: true`. The value retains the most recent 500 consult values, 200 decisions, and 400 timeline marks and timeline decisions; a log with more than 400 steps shows one timeline point per turn. The unit state is plain JSON, so the persisted projection cache restores it.

`ctx.modelRouting` is also the `modelRouting` Remote namespace. `modelRouting/gate` returns the gate configuration in force now (thresholds, judgment deadline, difficulty band, hold, and the per-consult state character cap `stateMaxChars`): the thresholds a drill-down compares a decision with when the decision recorded none, and the difficulty band, which no decision records. `modelRouting/decision` takes a session and the `seq` of one of its `model-routing/decision` events and returns that decision verbatim with its turn, step, and the current gate configuration; a `seq` that names no decision fails the call.

## Model Experience

### Routed model selection

#### What the model sees

Nothing this package writes. It registers no prompt section, tool, or message: its decision changes which provider/model/effort the loop dispatches the turn to, and the request text is whatever the session already assembled. A downgraded turn is the same conversation served by a different route. The system prompt is assembled for the manual route before the consult runs, so a persona interpolating `{{model}}` would tell a routed candidate it is the manual model. The shipped personas name no model, and the package's invariant companion rejects a routed request whose system prompt contains the manual model id.

#### Token effect

A downgrade changes the rate a turn's tokens are billed at, not the text of the request; the routed turn's input is tokenized by the candidate's provider, so prompt caching, cache reads, and output pricing follow that route. Route changes are the one thing this package adds to the token picture, and the streak exists to amortize their cost.

#### KV Cache effect

A route change is a cache transition: the first request after a downgrade re-prefills the context under the new route. `hold.minSteps` defaults to 20 because a return to a manual route whose five-minute cache expired breaks even after about 20 steps at a 200k-token prefix, and `hold.maxSteps` defaults to 40, about the steps that fit that cache lifetime, so a capped return usually finds the manual prefix still warm. Within a streak the route is stable, so the candidate's own prefix reuse continues; an immediate escalate-back is the deliberate exception, because a hard turn is worth the re-prefill. A `route-failed` retry is a transition back to the manual route within the step: it reuses the manual route's cached prefix only if that cache is still warm, and the failed candidate attempt's input is billed as the provider bills a failed request.

### Judgment call

#### What the model sees

When a judgment engine is composed and the mode is on, the router sends a JSON array of conversation entries with `seq`, `role`, `source`, and `content`. The last `state.contextTurns + 1` user-message nodes establish the window; intervening assistant messages, tool calls, tool results, and logged injected context remain available. Surface replacements are respected. Reasoning text and provider replay metadata are excluded; images and unsupported blocks have explicit markers. The complete current user message must fit `state.maxChars` or the manual model is retained. Earlier whole entries are admitted newest first and rendered chronologically; an `omitted` count identifies missing context. No text is sliced mid-message. When the provider supports fitting, the router supplies the bounded complete alternatives described above and the provider selects the first one that fits its pinned limits. The configured route question offers `keep-current` and only capability-eligible candidates. The difficulty question is included whenever `difficultyInstructions` is configured. Decisions record renderer version, bounds, included/omitted event sequences, capability assessments, exact questions, and either the selected fitted input or the capacity rejection. The judging engine's own Model Experience is documented in its provider package.

#### Token effect

The judgment call is its own small request: the state text plus the question text is its input, and its answers replace generated text. Nothing here adds input to the routed conversation turn.

#### KV Cache effect

The judgment call is an independent request that neither reads nor extends the conversation's prefix. It runs against the engine's model, so it does not touch the conversation route's cache at all.

## Known Limitations and Deferred Work

- **Idle expiry assumes a 5-minute cache lifetime** — `modelRoutingStats` is a pure fold of the log, and no request event records the prompt-cache retention in force; model info declares `promptCacheTtlMs`, but the fold does not read model info. A cold call is therefore classified as `idle-expiry` against 300 s, the value reports `coldTtl.fallback: true`, and the Routing view labels the lifetime as assumed. A request event that recorded the effective retention would let the fold use it.
- **A pool `provider` the llm runtime does not register is accepted on write** — load and settings writes validate every `routeFrom` and pool field by name, but not route registration: an unregistered candidate is excluded at runtime as `candidate-unavailable`. The write-time rejection lands with the routing card's pool editor, on the settings `validate(value, cause)` seam and `SettingsFieldError`, and it runs on writes only, checking only the fields a write changes.
- **Foreign reasoning becomes plain text on a return** — a routed candidate's reasoning is not a signed Anthropic thinking block, so a return to an Anthropic route reads the routed segment without its reasoning; `returnThinking` reports whether the manual model resumed thinking, and the opt-in `llm-claude-session` foreign-return probe checks that it does.
- **Prompt admission is not blocked** — routing runs after the user message has been committed to the session log, so a downgrade cannot change whether that message was admitted. Blocking or reshaping admission on a judgment is deferred: it would make the request path wait on the engine before durability.
- **No identical-prompt cache** — when a fresh judgment is needed, the same state text is judged again; nothing here memoizes a decision by `stateHash`. The hash is recorded so a rerun is recognizable, and a cache would need a policy for how long a judgment stays valid.
- **A restart mid-turn loses the step pin** — the intra-turn pin lives in memory (`WeakMap`), so a process that restarts between attempts can judge the current request again. The durable fold keeps the streak, not the pin.
- **The failure trigger names exactly what it counts, and what it misses** — the escalate-back-on-errors trigger counts `route-failed` decisions for one candidate across streaks, each one a downgraded request the in-turn fallback retried on the manual model, and consecutive `turn/end` reasons of kind `error` whose code is neither `ABORTED` nor `UNKNOWN`: a provider-side failure that ended a turn, which the loop records with the `LlmError` facts verbatim. Three other durable carriers exist and are deliberately not counted, because each one means something other than "the route failed this turn": `llm/retry` events record an attempt the recovery layer scheduled to retry, and a retry that succeeds is not a route failure; the terminal error `assistant/chunk` finish chunk records the same failure but is prunable history; and a turn ending `aborted` records no failure at all. The trigger degrades loudly, not silently, in these cases: a failure a recovery listener absorbs without scheduling a retry — canonically `compaction-basic`'s context-window recovery, whose code is outside the retry layer's default set — leaves no `turn/end` error, so the streak does not advance; a throw the harness flattens to `UNKNOWN` is not attributable to a route; a crash-orphaned turn closes as `interrupted`; and auxiliary calls such as session titling never log a failure at all.
- **Step-scoped judgment** — the initial request and every later new step in a downgraded turn receive a fresh route and difficulty judgment over the latest bounded surface, with full capability assessment. A same-step retry reuses its step's decision only while its complete candidate inputs are unchanged, after rechecking manual selection, `routeFrom` and pool membership, and capabilities. A manual, `kept-strong`, or `error` decision keeps the manual route for the rest of that turn, subject to the existing mode on/off override. Compaction can change the raw candidate-input key and force a fresh judgment within the same step; the redacted fitted state's `stateHash` is not compared for this purpose.
- **Token accounting** — `state.maxChars` bounds serialized characters, not judgment tokens. A fitting provider measures complete alternatives with its own pinned tokenizer and may reject all of them, which triggers `judgment-input-too-large` and manual fallback without inference. A provider without fitting receives the first bounded state and owns its input-size behavior. Candidate context windows are compared conservatively because the LLM service has no shared exact tokenizer; shorter candidate windows remain excluded even when a particular request might fit.
- **The manual-model guard is a substring match** — the invariant companion rejects a routed `request/header` whose system prompt contains the manual model id anywhere, so a prompt that quotes that id for another reason, such as workspace instructions naming it, is rejected too. The check runs only where the invariant registry is composed; the shipped bundles do not compose it.
- **The deadline bounds the answer, not the wait** — the judgment call receives a signal that aborts at `judgmentDeadlineMs`, and an answer arriving after it is discarded as `DEADLINE`. An engine that ignores its signal still holds the consult until it settles; the shipped engines pass the signal to their requests.
- **Capability metadata** — successful route preparation proves acceptance by the registered adapter, not remote model availability or task quality. Image content is represented by markers in the text judgment; its visual difficulty is not assessed.
