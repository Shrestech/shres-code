# Agent Note: Model-router child-route consumer (judge and outcomes)

Status: proposed

## Problem

PR 13b's router must decide a fresh child's route at spawn and later count that child's accounting turns toward a per-candidate breaker, without adopting the child or reading its files.

## Proposal

The controller registers `subagent/child-route` (next() first). Off and unmatched rules write nothing. On returns the first matching pool route. Shadow logs the same decision and returns undefined. Judge rules ask keep-current vs the candidate over `request.prompt` with correlation `child:<routeRequestId>`, using the same engine snapshot, deadline, fitting, and confidence/margin floors as `decide()`. Uncalibrated, unavailable, invalid, low-confidence, and thin-margin answers keep.

Live `subagent/end` and parent attach reconcile missing outcomes via `SubagentRuntime.childTurnOutcomes`. Classification uses the route in force, not stopReason: completed-on-selection is success; LlmError codes other than UNKNOWN on-selection are failure; max-tokens, abort, interrupt, blocked, UNKNOWN, and off-selection errors are neutral. Neutral never resets. Dedupe key is `(routeRequestId, childTurn)`. Events are required-on-read.

This chunk does not include stats rollup, Settings/Routing UI, keyless snapshot, or Web e2e.

## Alternatives considered

**Adopt the child and rewrite its route mid-turn.** Rejected: that is router adoption, which 13b forbids.

**Count stopReason from subagent/end.** Rejected: a completed turn on a different route is not a candidate success.

## Consequences

- Explicit routes, forks, and non-honoring providers still never dispatch (foundation).
- A resumed parent re-reads live or persisted child logs through the runtime, not the filesystem.

## Acceptance criteria

- Config tests for childPolicies, catch-all last-rule, judge text, childRouteErrors.
- Consult tests: off, no-match, on, shadow, unlisted, equal, suspended.
- Controller tests: off, on static, shadow, judge correlation `child:<id>`.
- Classification tests: success, QUOTA failure, UNKNOWN/max-tokens/aborted/blocked/off-selection neutral; breaker N failures, success reset, mode-on reset.

## Risks

- Reconcile currently discovers child ids from already-recorded outcomes; the live `subagent/end` path is the first writer. A parent that never saw end still needs those ids from the child's descriptor on a later follow-up — a follow-up if attach has no prior outcomes.

## Verification

Covered by the acceptance criteria above.
