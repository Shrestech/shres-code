# Agent Note: Routing correctness after the live review

Status: implemented

## Problem

A session running this branch with the router on recorded 17 decisions and no downgrade. Its logs, together with a review of the router against them, exposed correctness defects that the deterministic fixtures had not reached.

The manual route could appear on its own allowlist. With `zai/glm-5.3` as the manual route and a `mid-glm` candidate naming the same model, the judge chose `mid-glm` in 3 of 6 decisions. The duplicate split the probability that belonged to `keep-current` and lowered the reported confidence. Inside a held streak the defect changed the route: an answer naming the duplicate failed the gate as `candidate-equals-base`, and `sticky-hold` then kept the cheap candidate although the judge had chosen the manual model. A candidate on the manual model at another reasoning effort passed the gate as a downgrade, although it changes no model and, on providers that render effort into the cached request, only re-prefills the conversation.

Routed requests also misidentified their model. The shipped personas rendered `You are a coding agent powered by the {{model}} model`, and `{{model}}` resolves to the manual model when the system prompt is assembled, once per turn and before routing rewrites the request configuration. A routed DeepSeek or Kimi request was therefore told that it was the manual model.

A failed candidate request failed the user's turn. The router registered no `agent/request-error` listener, so a candidate failure that llm-retry did not retry ended the turn with an error, although the manual model could have served it. The route-error breaker counted such failures only while a streak was active, after the turn was already lost.

The allowlist carried no cost or strength order relative to the manual route. Any manual pick could start routing, including a model chosen because a subscription covers it, and any candidate could be selected from any base, so a candidate listed for one strong route could be a lateral or upward move from another.

A streak had no hysteresis. One difficulty threshold both entered and ended a streak, so a score near it could enter a streak on one step and escalate on the next. An `escalated` or `current-preferred` exit could be followed by a fresh entry on the next turn, paying two route transitions for one judgment. The horizon counted turns: every step of the entering turn held at `turnsElapsed` 0, so a downgrade held for the whole turn however many steps it ran, and a long turn outlived the manual route's cached prefix while a failed gate could not end it.

A failed judgment call also ended a held streak. Every engine failure resolved through the same strong exit, so one slow or refused call returned a held streak to the manual route and paid a transition for a transient fault. Nothing bounded the call's duration, and nothing stopped a consult from asking an engine that had failed on every recent turn; the live session's slowest call took 924 ms.

Compaction summarized on the routed candidate. compaction-basic resolved its summarization target from the latest request header, which during a streak carries the candidate, so the durable summary every later manual-route turn reads was written by the cheaper model.

A return to the manual route could lose thinking. Anthropic keeps thinking across a tool-use continuation only from the signed thinking blocks of earlier assistant turns. A routed segment carries none, so a return to a route that thinks on a fixed budget runs that turn without thinking, and nothing in the log said whether a return had thought.

Effort also moved inside a streak. The `difficultyToEffort` lift was recomputed from every step's difficulty answer, so a held candidate switched between its own effort and the lifted effort as the answers varied, while the streak comparison looked only at the candidate id. Anthropic invalidates cached message blocks when the request's effort changes, so each switch re-prefilled the conversation, and the fold, which compares effort, reset the route-failure count on changes the decision recorded as a continued streak.

## Decision

### The manual route is never a candidate

Candidate eligibility compares each configured candidate with the manual call configuration before any metadata lookup. A candidate naming the manual provider and model, at any reasoning effort, is recorded as `equals-base` and is not eligible. The route question is built from the eligible candidates, so the judgment is never offered the manual model under a candidate id.

When every configured candidate is `equals-base`, the consult resolves `candidate-equals-base` without a judgment call. That reason keeps its meaning for the routing chip: routing is on and can change nothing, because the session already runs the only downgrade target. When eligibility leaves no candidate for any other mix of reasons, the consult resolves `candidate-ineligible`; the recorded assessments distinguish `equals-base` from capability failures.

An answer that names an `equals-base` candidate chose an option the question did not offer. The consult reads it as `keep-current` and records `current-preferred`, which ends a held streak before the gate and the `sticky-hold` check run. The gate compares the answer only with eligible candidates, so every candidate it selects changes the model.

The route question otherwise keeps the rules of the [current-model choice note](2026-09-22-routing-choice-and-difficulty.md): `keep-current` is always offered first, and each option names its provider, model, and explicit effort.

### Effort is fixed for a streak

The `difficultyToEffort` lift applies only when a candidate enters a streak. A later passing answer for the held candidate returns the held selection, with its entry effort, while that effort is still one the candidate can enter at under the current configuration: the candidate's configured effort or the lift. A configuration change that makes the held effort unreachable produces a fresh entry selection.

Whether a decision continues the streak compares the complete selection, candidate id and effort, with the same comparison the fold uses. An effort change is therefore a candidate change: below `hold.minSteps` the held selection stands as `sticky-hold`, and after the horizon the new effort enters a new streak with its own entry turn and step. The held selection in every active decision, and the fold's held candidate, already record the effort, so no separate sticky field carries it.

### Routed requests do not name the manual model

The headless and Web bundle personas and the `code`, `standard`, and `cordis` agent presets no longer interpolate `{{model}}`; the `model` and `provider` prompt variables remain available to other templates. The model-router keyless snapshot compositions use personas that name no model as well.

The model-router invariant companion rejects, before publication, a `request/header` that follows a downgraded decision in the same turn and whose system prompt contains that decision's manual model id, `sticky.entryBase.model`, with `routed request names the manual model`. A route-error recovery request runs the manual route and is exempt. The comparison is a substring match on the model id, and it runs wherever the invariant registry is composed; the shipped bundles do not compose it.

### A failed downgraded request retries on the manual route

The router registers an `agent/request-error` listener while it is composed. The listener calls `next()` first, so llm-retry keeps ownership of transient retries in any listener order: a `retry` from downstream is returned unchanged, and the candidate's retry reuses the step's downgraded pin. When nothing downstream retries, `inTurnFallback` is `manual` (the default), the failure is not a cancellation, and the failed request is the step this router downgraded, the router:

- appends a `kept-strong` / `route-failed` decision that records the failed request in `failure` and the attempt's last `assistant/chunk` in `failedChunkSeq`;
- re-pins the step to that decision, keeping the manual route recorded as the streak's entry base;
- returns `retry`.

The retried request resolves the manual route without another judgment. When the caller's manual base is the failed header's route, which happens for an agent without an installed session selection, the pin supplies the recorded manual route. The decision precedes the retried request's header. The invariant companion rejects a `route-failed` decision that does not directly follow the same step's downgraded decision for the failed provider, and a later header in that turn that runs the failed route. A failure of the manual retry is terminal. `inTurnFallback: off` keeps failures terminal for a deployment that wants them visible.

The breaker counts `route-failed` decisions for one candidate across the streaks they end, in a new fold field. Reaching `maxRouteErrors` is a route-error break with the existing manual recovery turn. A completed turn on the candidate, another candidate's failure, or a route-error break resets the count. Terminal failures of a held route still count while the streak is active.

### Routing starts only from listed strong routes, into one shared pool

`candidates` is the one shared, owner-edited pool of downgrade targets. Each entry needs a `description` of at most 160 characters, because every description is sent in every judgment question, and ids stay unique, non-empty, and distinct from `keep-current`. `routeFrom` is a fail-closed allowlist of the strong routes routing may start from, matched on provider and model, each with a required `objective`: `quota` for a subscription or credit plan, `dollars` for a metered key, and `latency` for a route chosen for speed. The objective describes how the strong route is billed, so it lives on the route rather than on the deployment, which can mix both kinds.

A consult whose manual route is not listed records `kept-strong` / `base-unlisted` without assessing a candidate or asking the judgment engine. A held streak whose route is removed from the list ends the same way, with `brokenBy: 'base-unlisted'`, and a held candidate removed from the pool ends its streak with `unknown-candidate`. Every decision resolved against a listed route records the route's `objective`, so a later edit cannot reinterpret history. Load and settings writes refuse, by name, a route listed twice, an unknown objective, a `latency` route with `judgmentDeadlineMs` above 200, a `quota` route without `allowEveryTurn: true` under the per-turn entry policy, and an empty `routeFrom` unless `initialMode` is `off`.

The routing chip reports `base-unlisted` as an idle state with its own warning, beside the existing `candidate-equals-base` idle state, because manually picking a pool model now resolves `base-unlisted` unless that model is also listed in `routeFrom`.

### Streaks enter below a band, hold by steps, and cool down after a quality exit

Entry and exit use separate difficulty thresholds. A streak is entered only when the score is below `difficulty.entryScoreCeiling` (default 2, below "involved" on the five-level rubric), and a held streak ends at `escalateBack.scoreThreshold` (default 3). A score in between holds the streak and never lets a different candidate replace the held selection, because that replacement is an entry. Load fails by name when the ceiling exceeds the exit threshold; its default is not lowered to fit a lower threshold or a shorter rubric.

The horizon counts model steps. The fold counts every `step/start` logged while a streak holds, including later steps of the entering turn, and restarts the count when a decision changes the held selection; the entering decision records `enteredStep` beside `enteredTurn`, and every decision records `stepsElapsed` in place of `turnsElapsed`. `hold.minSteps` (default 20) is the horizon below which a failed gate or a different candidate holds the selection: a return to a manual route whose five-minute cache expired breaks even after about 20.5 steps at a 200k-token prefix. `hold.maxSteps` (default 40) caps every hold: once that many steps have elapsed, the next consult records `hold-cap` and returns to the manual route without a judgment call, while the manual route's cache, about 38 steps of 7.8 s, is usually still warm. The evidence is in the [redesign plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md). `minTurnsDowngraded` is removed, and a composition that still sets it fails load with the unknown-key error.

An `escalated`, `current-preferred`, or `route-failed` exit starts the re-entry cooldown. The fold records the turn of the decision that ended the streak, and the next `reentryCooldownTurns` turns (default 2) record `reentry-cooldown` and keep the manual route without a judgment call; `0` disables it. Other exits start no cooldown: `hold-cap`, `gate-failed`, a manual, capability, or mode change, and a route-error break, which has its own recovery turn. The accumulator carries the step count and the cooldown turn, so the projection's state version changes and a stored accumulator without them is rebuilt.

### Judgment calls have a deadline, a hold tolerance, and a breaker

Each judgment call runs under the turn's signal combined with `AbortSignal.timeout(judgmentDeadlineMs)` (default 1500, at most 30000). A deadline expiry that is not a turn cancellation records `engine-unavailable` with the new decision field `engineFailure: { code: 'DEADLINE' }`, and an answer that arrives after the deadline is discarded; a turn cancellation still propagates without a decision. Other failed calls record the engine's `JudgmentError` code in `engineFailure`.

While a streak holds, the first `judgmentFailures.holdTolerance` (default 2) consecutive failed calls keep its candidate as a `downgraded` / `judgment-failure-held` decision; the next failure ends the streak with the `onUnavailable` outcome. The fold counts consecutive failed calls with the turn of the latest and clears the count on a decision carrying a route answer. At `judgmentFailures.breakerThreshold` (default 3) the breaker opens: consults within `judgmentFailures.breakerOpenTurns` (default 5) turns of the latest failure record `breaker-open` without a judgment call. Because only an answered call clears the count, the first call after the window reopens the breaker if it fails. `state-too-large` and `judgment-input-too-large` describe the input rather than the engine, so they still end a held streak at once and are not counted. The projection's state version is 8.

### Compaction summarizes on the manual route

compaction-basic gains `summarizationRoute: 'manual' | 'request'`, default `manual`, at the top level and in each exact-target policy, and compaction-jev restates it in its schema. With no summarization pair configured, `manual` summarizes on the route a composed `ctx.modelRouting` reports through `stickySelection`, the entry route of a held streak, and falls back to the latest request header without a router or a streak; `request` keeps the latest header. A configured pair still wins, and compaction-jev's draft and escalation paths inherit the rule through the base summarizer. The summarization call envelope already records its provider and model, so the choice is logged.

### Budget-thinking manual routes are not routed from

`LlmModelInfo` gains `thinkingMode: 'adaptive' | 'budget' | 'none'`, validated by the LLM runtime on listing and exact resolution (`INVALID_CATALOG`, `INVALID_MODEL_THINKING_MODE`). llm-pi-ai declares it for anthropic-messages models from the same fact its request builder reads: `adaptive` for a model whose compat sets `forceAdaptiveThinking`, `budget` for any other reasoning model, `none` for a non-reasoning one; other protocols declare nothing. While the manual route declares `budget` and its prepared effort enables reasoning, eligibility excludes every other candidate as `thinking-mode-incompatible` before any lookup, and the consult resolves `thinking-mode-incompatible` without a judgment call; a held streak whose manual route becomes budget-thinking ends as `candidate-ineligible`. claude-session ships only adaptive models, so the rule is dormant there.

The `modelRouting` projection reports `returnThinking: 'present' | 'absent'` for the first `assistant/message` after the last ended streak, derived from its content blocks, which is the observed check for adaptive routes; no event is added. The opt-in `llm-claude-session` probe `tests/foreign-return.e2e.ts` (`SHRES_E2E_CLAUDE_FOREIGN_RETURN=1` and a Claude login) continues a DeepSeek-shaped tool-call segment on `claude-opus-5-5` with reasoning enabled and checks that the request is accepted and the reply thinks. It spends subscription quota and was not run for this change.

## Alternatives considered

**Omit the duplicate from the question only.** An engine answer naming it would reach the gate as an unknown candidate, and `sticky-hold` treats every gate failure below the horizon as a reason to keep the held cheap route. The answer has to be read as the current model before the gate.

**Delete the `candidate-equals-base` reason.** The routing chip reports its idle state from that reason and offers the restore of the last strong route. The state still exists when the manual pick is the only candidate, and it is now detected without a judgment call.

**Recompute the effort lift at every step.** The lift answers "is this turn hard enough to need more reasoning", but per-step difficulty answers vary on the same task, and every change of effort re-prefills an Anthropic conversation. Fixing the effort at entry trades a possibly lower effort on a later harder step for a stable cache; a step that turns hard enough reaches the escalation threshold and returns to the manual route instead.

**Record the entry effort in a new sticky field.** The held selection already records the effort in every active decision, and the fold carries it as the held candidate. A second field would duplicate one durable fact that replay must then keep consistent.

**Decide the route before the system prompt is assembled.** Assembly runs once per turn and routing decides per step, so a later step that changes route would still carry a prompt naming the earlier model, and moving the consult ahead of assembly is an agent-loop change.

**Rewrite the system prompt for each routed request.** The `agent/request` waterfall grants the consult authority over the request configuration only. A per-request prompt rewrite would be a model-visible input with no session event of its own, and it would change the cached prefix on every route change.

**Recover before llm-retry.** A listener that converts a failure before calling `next()` would replace every transient retry of the candidate with a switch to the manual model, even for a rate limit the candidate would have served on its next attempt, and its behavior would depend on listener order.

**Judge the retried request again.** The failed step already has a decision; asking the engine again could select the failed candidate a second time, and it adds judgment latency to a recovery path.

**Count in-turn fallbacks only while a streak is active.** Each `route-failed` decision ends its streak, so a candidate that fails on every entry would never reach `maxRouteErrors`, and every turn would pay one failed candidate attempt before its manual retry.

**Keep same-model effort candidates as downgrades.** A different effort on the same model is not a model downgrade. On Anthropic routes an effort change invalidates the cached message blocks, so it costs a full re-prefill without the price difference a cheaper model provides.

**Keep `minTurnsDowngraded` as an alias for the step horizon.** A turn and a step are different units, so any mapping between them would silently change a deployment's hold; before the first release the unknown-key error names the removed key instead.

**Count held decisions instead of `step/start` events.** A decision carries no step number, and a same-step retry that is judged again logs a second decision for one step. The loop's `step/start` is the authoritative step boundary, and the fold already reads turn events the same way.

**Lower the entry ceiling's default to a lower exit threshold.** The router already refuses to clamp `escalateBack` to a short rubric; a clamped ceiling would hide the band collapsing to nothing, so a deployment that lowers the exit threshold states its entry ceiling.

**Start a cooldown after `hold-cap`.** The cap returns to the manual route while its cache is warm; that exit says nothing about the candidate's fitness, so the next turn is judged as usual.

**Race the judgment call against the deadline.** A race would return on time even from an engine that ignores its signal, but it would leave that call running with no owner. The shipped engines pass the signal to their requests, so the signal bounds them and the late answer is discarded.

**Record the breaker thresholds on each decision.** The failure count and its turn are log facts; the thresholds come from the configuration in force at each consult, the same way the re-entry cooldown reads its window. A settings change then applies to the next consult without rewriting how earlier decisions are read.

**Reset the failure count when the breaker closes.** A closed breaker that needs a full threshold of new failures before reopening sends that many calls to an engine that has not recovered; the half-open trial sends one.

**Strip or rewrite the routed segment before a return.** Removing the routed turns would drop model-visible history the log records, and rewriting them as Anthropic turns would invent thinking the candidate never produced; excluding routing from a budget-thinking route keeps the log and the request consistent.

**Summarize on the candidate by default.** The candidate's prefix is the one the last request warmed, but the summary is durable and model-visible to every later manual-route turn, and the plan's cold-point policy treats a compaction as a point where routing returns to the manual route anyway, so the cache advantage does not outweigh the quality risk.

**Per-base candidate lists.** A list per strong route states an order the pool cannot, but the owner edits one pool from the routing card, and a candidate that is a downgrade from one route is kept out of the others only by duplicating the pool per route. Starting routing only from listed routes, plus the `equals-base` rule and the capability floors, protects what a per-base list protected except the lateral-move case, which the owner accepts and the card surfaces as a warning.

**One deployment-wide objective.** A deployment can route from a subscription route and a metered route at once, and a single objective would mislabel one of them.

## Consequences

An allowlist cannot express a same-model effort downgrade; a deployment that wants a lower effort changes the manual selection. A session whose manual pick is its only candidate skips the judgment call on every turn. The allowlist still carries no cost or strength ordering relative to the manual route, so a candidate naming a different model can be lateral or stronger; per-base candidate lists are proposed in the [routing proposal](../../proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md).

`eligibility.spec.ts` pins the `equals-base` classification, including a same-model candidate at another effort, and the absence of a metadata lookup for it. `controller.spec.ts` pins the omitted question option, the judgment-free `candidate-equals-base` resolution, the `candidate-ineligible` resolution for a mixed allowlist, and the held-streak exit through `current-preferred`. The keyless `model-router-keep-current` snapshot configures a base-equal candidate and records its `equals-base` assessment in the logged decision. `controller.spec.ts` also pins an effort lift fixed at entry in both directions, and a configured effort change that is held below the horizon and enters as a new streak after it, with and without a lift configured.

`controller.spec.ts` pins the in-turn fallback through the real `agent/request-error` waterfall: a converted failure with its exact decision, the manual retry without a second judgment, deference to a downstream retry, `inTurnFallback: off`, cancellation, requests this router did not route, and a callback captured or entered after the plugin fiber is disposed. `folds.spec.ts` pins the count across streaks and its resets. `provider-composition.spec.ts` boots both real judgment providers through the Loader and completes a turn on the manual model after a 500 from the candidate. It also composes llm-retry with a one-retry normal policy on the DeepSeek route, with the llm-retry entry before and after the router: a `SERVER` failure is retried on the candidate with one judgment and no `route-failed` decision, an `AUTH` failure falls back through `route-failed`, and a `SERVER` failure that exhausts its retry falls back after it. The two entry placements produce the same waterfall order, with the router's listener first, so these cases pin behaviour under both composition orders but do not test llm-retry running ahead of the router; the router's order independence rests on calling `next()` before it falls back, by construction. The keyless `model-router-fallback` snapshot records two converted failures and the route-error recovery turn they trigger. Compositions that test terminal candidate failures, including the keyless `model-router-on` snapshot and its recovery arm, set `inTurnFallback: off`. The trajectory view labels a `route-failed` decision as a visible streak exit rather than a quiet kept-strong marker, which `routing.client.spec.ts` pins.

Every held decision now records steps rather than turns, and the per-turn entry policy is the only one: a cold-point entry policy (plan §4.1) would hold until the next cold point bounded by `hold.maxSteps`, and `hold.minSteps` would apply to the per-turn policy alone. Load rejects a `difficultyToEffort` threshold at or above the entry ceiling by name, because entry requires a lower score and such a lift could never apply. The keyless model-router compositions dropped their unreachable lift at 4; their fixtures lose only the `difficultyReasoningEffort` field that each candidate assessment records for a configured lift. The `route-on` and `route-shield` bench arms and the routing tier pin `hold`, `difficulty.entryScoreCeiling`, and `reentryCooldownTurns` explicitly, and the preregistration records the replacement of its frozen `minTurnsDowngraded: 5`.

`config.spec.ts` pins the new defaults, their bounds, the ceiling above the exit threshold, and the removed key. `folds.spec.ts` pins `stepsElapsed` advancing within the entry turn, its restart on a candidate change, the `hold-cap` break with no cooldown, and the cooldown turn taken from the ending decision. `controller.spec.ts` pins a score in the band that holds but does not enter, including a refused candidate change past the horizon, `hold-cap` without a judgment call inside the entering turn, and the cooldown turns with and without it disabled. The keyless `model-router-cooldown` snapshot escalates on tool evidence and records `reentry-cooldown` on the next turn, and `model-router-cap` records `hold-cap` on the step after entry. The keyless fixtures now answer difficulty 1, below the entry ceiling, and `model-router-fallback` sets `reentryCooldownTurns: 0` so its second fallback still reaches the error limit.

`controller.spec.ts` pins a deadline expiry recorded as `DEADLINE` with the turn kept, a late answer discarded, the recorded engine code, a held streak surviving its hold tolerance and ending at the next failure, the breaker opening, staying closed to asks, reopening on a failed trial, and closing on an answer, a turn cancellation during the ask that propagates without a decision, and `judgment-input-too-large` ending a held streak at once. `folds.spec.ts` pins which decisions count as failed calls and which leave the count alone. The keyless snapshots are unchanged by this part, because their scripted engine never fails; the trajectory labels `judgment-failure-held` as a held downgrade and `breaker-open` as a quiet marker, which `routing.client.spec.ts` pins.

Every composition that turns routing on now lists its strong route in `routeFrom` and describes each pool candidate: the keyless router snapshots, the Loader and provider compositions, the Laya composition, and the bench arms, whose preregistration records the added `routeFrom`. A deployment configuration written before this change fails load by name until it does the same. `config.spec.ts` pins each named `routeFrom` and description error; `controller.spec.ts` pins `base-unlisted` without a judgment call, the recorded `objective`, a held streak ended when its route is removed from `routeFrom`, and a held pool candidate removed from the pool. The refreshed keyless fixtures differ only by the candidate descriptions in the recorded questions and assessments and by the recorded `objective`.

`eligibility.spec.ts` pins `excludes routing under a budget-thinking Anthropic base` and the unaffected cases (reasoning off or unset, adaptive, none); `controller.spec.ts` pins the consult without a judgment call, the held-streak exit, and `returnThinking` across returns; llm's `service.spec.ts` pins `thinkingMode` validation and pass-through, and llm-pi-ai's `adapter.spec.ts` pins the declared modes.

compaction-basic's `compaction-basic.spec.ts` pins the manual route during a held streak, `request` keeping the latest header, the fallback without a router or a streak, an exact-target override, and the named validation error. The router's Loader composition runs compaction-basic with a held streak and checks the summarization request's model and the recorded `compaction/summary` for both routes.

The shipped personas no longer state which model is running, a product-visible prompt change that the keyless Web fixture `apps/web/tests/snapshots/fresh-round-trip/system-prompt.expected.md` pins. A deployment persona that interpolates `{{model}}` is incompatible with routing wherever invariants are composed. The ACP example personas and the headless example's base composition still interpolate it because they compose no router. `invariant.spec.ts` pins the rejection and the recovery exemption through real session appends. The Loader composition in `composition.spec.ts` runs a downgraded turn with the shipped headless persona and the companion composed, and a negative control whose `{{model}}` persona ends the turn with the guard's error before any model request.
