# Agent Note: The Codex subscription model carries an evidence-bounded context window

Status: implemented

## Problem

`llm-codex-session` shipped its models with no `contextWindow`, so the pi-ai adapter's `DEFAULT_CONTEXT_WINDOW` (262,144) stood in for a backend nobody had measured. Two consumers read that number: the compaction pressure threshold and the occupancy display. A production session against the backend completed a response reporting a 311,781-token prompt, which proves the real capacity exceeds the fallback by at least 19%; the pressure gate therefore fired later than the deployment's own capacity allowed.

The backend publishes no capacity to read instead. A probe of `GET /models` and `GET /v1/models` on the subscription endpoint answered 400 and 403 — it serves the Responses API only — so any shipped value has to come from observed traffic, and it can only be a bound rather than the provider's own figure.

## Decision

`gpt-6-astra` declares `contextWindow: 311_000`. The number is a deliberate round lower bound on what the backend demonstrably served (session-8bec6678, seq 52100: a completed response reporting 311,781 prompt tokens, 8,805 uncached plus 302,976 cached), not a claim about the endpoint's real limit. Naming a bound below observed capacity biases the pressure threshold toward compacting slightly early, the direction whose cost is retained context rather than a wedged session.

`gpt-5.6-luna` stays undeclared and keeps the adapter fallback, because nothing observed bounds it. Both remain correctable without a release through the settings `models` entry, which replaces the shipped list and whose `contextWindow` field wins over the catalog — the shipped value is the floor a deployment starts from.

## Alternatives considered

**Keep the adapter fallback for both models.** Rejected: 262,144 is below capacity this deployment already exercised, so pressure policy would keep describing a smaller window than the backend serves, and nothing in the configuration would say why.

**Declare the measured 311,781 exactly.** Rejected: the exact served capacity is unobserved — that figure is the largest prompt attempted, not a limit — and a precise-looking number invites treating it as measured. A round bound communicates the uncertainty and stays valid until evidence contradicts it.

**Interrogate the endpoint for capacity at request time.** Rejected: the backend serves no model listing (400/403), so there is nothing to read; capacity discovery through a failed request would spend a real prompt to learn a bound.

**Leave capacity unset and rely on overflow recovery.** Rejected: capacity-independent recovery still exists for a provider error, but pressure policy needs a number to scale its ratio against, and an undeclared route fails loud with a target-specific configuration error instead.

## Consequences

Pressure policy now scales against a window the deployment actually served. The value is a lower bound, so it under-states capacity if the backend grows: the effect is mildly early compaction, and the settings entry is the correction. The window no longer decides whether a completed response is an overflow, because usage comparison is scoped to silently-truncating protocols; it feeds the threshold and the display only.

## Testing

`route.spec.ts` pins the shipped value and the absence of one for the unverified model; `adapter.spec.ts` asserts the window the runtime resolves for each (`311_000`, and `262_144` for the fallback); `dynamic-settings.spec.ts` proves a settings entry raises it without a release.
