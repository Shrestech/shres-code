# Agent Note: Public replayConsultInput and coldPointAt

Status: proposed

## Problem

PR16 replay must ask exactly what live `decide()` asks, without importing `model-router/src/*`.

## Proposal

Export `replayConsultInput`, `consultPrefix`, and `coldPointAt` from the package root. Live `decide()` calls the same producer on the entry path. Messages are derived with public `foldSurface` + `deriveEventMessage`. `requestConfig` is an explicit argument. `routeBase` and `coldPointBase` are split so a cheap-only log does not manufacture session-start cold points against a strong base.

## Alternatives considered

**Caller-supplied messages.** Rejected: the loop already sends `session.deriveMessages()`, which is the same fold.

## Consequences

Held streaks, cooldown, and breaker stay inside `decide()`. Replay refuses an active held streak and, when the two bases differ, a mixed-route log. Live `decide()` assigns `facts.cache` immediately after `facts.candidateEligibility`; fact insertion order is part of the persisted decision bytes.
