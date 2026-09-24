# Agent Note: Routing correctness after the live review

Status: implemented

## Problem

A session running this branch with the router on recorded 17 decisions and no downgrade. Its logs, together with a review of the router against them, exposed correctness defects that the deterministic fixtures had not reached.

The manual route could appear on its own allowlist. With `zai/glm-5.3` as the manual route and a `mid-glm` candidate naming the same model, the judge chose `mid-glm` in 3 of 6 decisions. The duplicate split the probability that belonged to `keep-current` and lowered the reported confidence. Inside a held streak the defect changed the route: an answer naming the duplicate failed the gate as `candidate-equals-base`, and `sticky-hold` then kept the cheap candidate although the judge had chosen the manual model. A candidate on the manual model at another reasoning effort passed the gate as a downgrade, although it changes no model and, on providers that render effort into the cached request, only re-prefills the conversation.

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

## Alternatives considered

**Omit the duplicate from the question only.** An engine answer naming it would reach the gate as an unknown candidate, and `sticky-hold` treats every gate failure below the horizon as a reason to keep the held cheap route. The answer has to be read as the current model before the gate.

**Delete the `candidate-equals-base` reason.** The routing chip reports its idle state from that reason and offers the restore of the last strong route. The state still exists when the manual pick is the only candidate, and it is now detected without a judgment call.

**Recompute the effort lift at every step.** The lift answers "is this turn hard enough to need more reasoning", but per-step difficulty answers vary on the same task, and every change of effort re-prefills an Anthropic conversation. Fixing the effort at entry trades a possibly lower effort on a later harder step for a stable cache; a step that turns hard enough reaches the escalation threshold and returns to the manual route instead.

**Record the entry effort in a new sticky field.** The held selection already records the effort in every active decision, and the fold carries it as the held candidate. A second field would duplicate one durable fact that replay must then keep consistent.

**Keep same-model effort candidates as downgrades.** A different effort on the same model is not a model downgrade. On Anthropic routes an effort change invalidates the cached message blocks, so it costs a full re-prefill without the price difference a cheaper model provides.

## Consequences

An allowlist cannot express a same-model effort downgrade; a deployment that wants a lower effort changes the manual selection. A session whose manual pick is its only candidate skips the judgment call on every turn. The allowlist still carries no cost or strength ordering relative to the manual route, so a candidate naming a different model can be lateral or stronger; per-base candidate lists are proposed in the [routing proposal](../../proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md).

`eligibility.spec.ts` pins the `equals-base` classification, including a same-model candidate at another effort, and the absence of a metadata lookup for it. `controller.spec.ts` pins the omitted question option, the judgment-free `candidate-equals-base` resolution, the `candidate-ineligible` resolution for a mixed allowlist, and the held-streak exit through `current-preferred`. The keyless `model-router-keep-current` snapshot configures a base-equal candidate and records its `equals-base` assessment in the logged decision. `controller.spec.ts` also pins an effort lift fixed at entry in both directions, and a configured effort change that is held below the horizon and enters as a new streak after it, with and without a lift configured.
