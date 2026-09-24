# Agent Note: Routing correctness after the live review

Status: implemented

## Problem

A session running this branch with the router on recorded 17 decisions and no downgrade. Its logs, together with a review of the router against them, exposed correctness defects that the deterministic fixtures had not reached.

The manual route could appear on its own allowlist. With `zai/glm-5.3` as the manual route and a `mid-glm` candidate naming the same model, the judge chose `mid-glm` in 3 of 6 decisions. The duplicate split the probability that belonged to `keep-current` and lowered the reported confidence. Inside a held streak the defect changed the route: an answer naming the duplicate failed the gate as `candidate-equals-base`, and `sticky-hold` then kept the cheap candidate although the judge had chosen the manual model. A candidate on the manual model at another reasoning effort passed the gate as a downgrade, although it changes no model and, on providers that render effort into the cached request, only re-prefills the conversation.

Routed requests also misidentified their model. The shipped personas rendered `You are a coding agent powered by the {{model}} model`, and `{{model}}` resolves to the manual model when the system prompt is assembled, once per turn and before routing rewrites the request configuration. A routed DeepSeek or Kimi request was therefore told that it was the manual model.

A failed candidate request failed the user's turn. The router registered no `agent/request-error` listener, so a candidate failure that llm-retry did not retry ended the turn with an error, although the manual model could have served it. The route-error breaker counted such failures only while a streak was active, after the turn was already lost.

Effort also moved inside a streak. The `difficultyToEffort` lift was recomputed from every step's difficulty answer, so a held candidate switched between its own effort and the lifted effort as the answers varied, while the streak comparison looked only at the candidate id. Anthropic invalidates cached message blocks when the request's effort changes, so each switch re-prefilled the conversation, and the fold, which compares effort, reset the route-failure count on changes the decision recorded as a continued streak.

## Decision

### The manual route is never a candidate

Candidate eligibility compares each configured candidate with the manual call configuration before any metadata lookup. A candidate naming the manual provider and model, at any reasoning effort, is recorded as `equals-base` and is not eligible. The route question is built from the eligible candidates, so the judgment is never offered the manual model under a candidate id.

When every configured candidate is `equals-base`, the consult resolves `candidate-equals-base` without a judgment call. That reason keeps its meaning for the routing chip: routing is on and can change nothing, because the session already runs the only downgrade target. When eligibility leaves no candidate for any other mix of reasons, the consult resolves `candidate-ineligible`; the recorded assessments distinguish `equals-base` from capability failures.

An answer that names an `equals-base` candidate chose an option the question did not offer. The consult reads it as `keep-current` and records `current-preferred`, which ends a held streak before the gate and the `sticky-hold` check run. The gate compares the answer only with eligible candidates, so every candidate it selects changes the model.

The route question otherwise keeps the rules of the [current-model choice note](2026-09-22-routing-choice-and-difficulty.md): `keep-current` is always offered first, and each option names its provider, model, and explicit effort.

### Effort is fixed for a streak

The `difficultyToEffort` lift applies only when a candidate enters a streak. A later passing answer for the held candidate returns the held selection, with its entry effort, while that effort is still one the candidate can enter at under the current configuration: the candidate's configured effort or the lift. A configuration change that makes the held effort unreachable produces a fresh entry selection.

Whether a decision continues the streak compares the complete selection, candidate id and effort, with the same comparison the fold uses. An effort change is therefore a candidate change: below `minTurnsDowngraded` the held selection stands as `sticky-hold`, and after the horizon the new effort enters a new streak with its own entry turn. The held selection in every active decision, and the fold's held candidate, already record the effort, so no separate sticky field carries it.

### Routed requests do not name the manual model

The headless and Web bundle personas and the `code`, `standard`, and `cordis` agent presets no longer interpolate `{{model}}`; the `model` and `provider` prompt variables remain available to other templates. The model-router keyless snapshot compositions use personas that name no model as well.

The model-router invariant companion rejects, before publication, a `request/header` that follows a downgraded decision in the same turn and whose system prompt contains that decision's manual model id, `sticky.entryBase.model`, with `routed request names the manual model`. A route-error recovery request runs the manual route and is exempt. The comparison is a substring match on the model id, and it runs wherever the invariant registry is composed; the shipped bundles do not compose it.

### A failed downgraded request retries on the manual route

The router registers an `agent/request-error` listener while it is composed. The listener calls `next()` first, so llm-retry keeps ownership of transient retries in any listener order: a `retry` from downstream is returned unchanged, and the candidate's retry reuses the step's downgraded pin. When nothing downstream retries, `inTurnFallback` is `manual` (the default), the failure is not a cancellation, and the failed request is the step this router downgraded, the router:

- appends a `kept-strong` / `route-failed` decision that records the failed request in `failure` and the attempt's last `assistant/chunk` in `failedChunkSeq`;
- re-pins the step to that decision, keeping the manual route recorded as the streak's entry base;
- returns `retry`.

The retried request resolves the manual route without another judgment. When the caller's manual base is the failed header's route, which happens for an agent without an installed session selection, the pin supplies the recorded manual route. The decision precedes the retried request's header. The invariant companion rejects a `route-failed` decision that does not directly follow the same step's downgraded decision for the failed provider, and a later header in that turn that runs the failed route. A failure of the manual retry is terminal. `inTurnFallback: off` keeps failures terminal for a deployment that wants them visible.

The breaker counts `route-failed` decisions for one candidate across the streaks they end, in a new fold field; the projection's state version moves to 6 so a stored accumulator from before is rebuilt. Reaching `maxRouteErrors` is a route-error break with the existing manual recovery turn. A completed turn on the candidate, another candidate's failure, or a route-error break resets the count. Terminal failures of a held route still count while the streak is active.

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

## Consequences

An allowlist cannot express a same-model effort downgrade; a deployment that wants a lower effort changes the manual selection. A session whose manual pick is its only candidate skips the judgment call on every turn. The allowlist still carries no cost or strength ordering relative to the manual route, so a candidate naming a different model can be lateral or stronger; per-base candidate lists are proposed in the [routing proposal](../../proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md).

`eligibility.spec.ts` pins the `equals-base` classification, including a same-model candidate at another effort, and the absence of a metadata lookup for it. `controller.spec.ts` pins the omitted question option, the judgment-free `candidate-equals-base` resolution, the `candidate-ineligible` resolution for a mixed allowlist, and the held-streak exit through `current-preferred`. The keyless `model-router-keep-current` snapshot configures a base-equal candidate and records its `equals-base` assessment in the logged decision. `controller.spec.ts` also pins an effort lift fixed at entry in both directions, and a configured effort change that is held below the horizon and enters as a new streak after it, with and without a lift configured.

`controller.spec.ts` pins the in-turn fallback through the real `agent/request-error` waterfall: a converted failure with its exact decision, the manual retry without a second judgment, deference to a downstream retry, `inTurnFallback: off`, cancellation, requests this router did not route, and a callback captured or entered after the plugin fiber is disposed. `folds.spec.ts` pins the count across streaks and its resets. `provider-composition.spec.ts` boots both real judgment providers through the Loader and completes a turn on the manual model after a 500 from the candidate. The keyless `model-router-fallback` snapshot records two converted failures and the route-error recovery turn they trigger. Compositions that test terminal candidate failures, including the keyless `model-router-on` snapshot and its recovery arm, set `inTurnFallback: off`. The trajectory view labels a `route-failed` decision as a visible streak exit rather than a quiet kept-strong marker, which `routing.client.spec.ts` pins.

The shipped personas no longer state which model is running, a product-visible prompt change that the keyless Web fixture `fresh-round-trip/system-prompt.expected.md` pins. A deployment persona that interpolates `{{model}}` is incompatible with routing wherever invariants are composed. The ACP example personas and the headless example's base composition still interpolate it because they compose no router. `invariant.spec.ts` pins the rejection and the recovery exemption through real session appends. The Loader composition in `composition.spec.ts` runs a downgraded turn with the shipped headless persona and the companion composed, and a negative control whose `{{model}}` persona ends the turn with the guard's error before any model request.
