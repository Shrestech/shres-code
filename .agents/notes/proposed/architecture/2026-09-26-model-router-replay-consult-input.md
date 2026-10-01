# Agent Note: Public replayConsultInput and coldPointAt

Status: proposed

## Problem

Offline replay must reconstruct the same consult input live `decide()` builds, without importing `model-router/src/*`.

## Proposal

Export `replayConsultInput`, `consultPrefix`, and `coldPointAt` from the package root. Live `decide()` calls the same producer on the entry path with the live log and request messages. Messages for the wrapper are derived with public `foldSurface` + `deriveEventMessage`. `requestConfig` and the composed LLM runtime are explicit arguments: `replayConsultInput(config, events, at, routeBase, coldPointBase, requestConfig, runtime, signal?)`. The same runtime supplies metadata and prepares base/candidate calls, preserving adapter defaults and preparation failures. `routeBase` and `coldPointBase` are split so a cheap-only log does not manufacture session-start cold points against a strong base. Live `decide()` assigns `facts.cache` immediately after `facts.candidateEligibility`; fact insertion order is part of the persisted decision bytes.

## Alternatives considered

**Caller-supplied messages.** Rejected: the loop already sends `session.deriveMessages()`, which is the same fold.

**Metadata-only preparation fallback.** Rejected: returning the requested config without adapter preparation hides defaults and preparation failures, changing eligibility. Replay requires the composed runtime; passthrough behavior belongs only in explicit test doubles.

## Acceptance criteria

- Package-root exports include `replayConsultInput`, `consultPrefix`, and `coldPointAt`. Live `decide()` does not call `consultPrefix`.
- The wrapper refuses a missing `step/start`, an active held streak, a re-entry cooldown, mixed request-header routes, and a folded mode of off.
- A dollars asked decision records `cache` immediately after `candidateEligibility`; a quota asked decision records `coldPoint` then `cache` before eligibility facts.

## Risks

Held streaks, cooldown, and breaker stay inside `decide()`. Replay cannot reconstruct a held-step consult. Splitting `routeBase` and `coldPointBase` is required for counterfactual cheap-only logs; using one base would invent cold points against the wrong model. Replay resolves the cache lifetime independently through its runtime; live routing reuses its precomputed lifetime or eligibility metadata. When preparation fails after metadata succeeds, replay can retain an adapter lifetime while a non-quota live decision reports the fallback lifetime. That consult remains ineligible.
