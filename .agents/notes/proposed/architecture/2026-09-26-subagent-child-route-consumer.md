# Agent Note: Model-router child-route consumer (judge and outcomes)

Status: proposed

## Problem

PR 13b's router must decide a fresh child's route at spawn and later count that child's accounting turns toward a per-candidate breaker, without adopting the child or reading its files.

## Proposal

The controller registers `subagent/child-route` (next() first). Off and unmatched rules write nothing. On returns the first matching pool route. Shadow logs the same decision and returns undefined. Judge rules ask keep-current vs the candidate over `request.prompt` with correlation `child:<routeRequestId>`, using the same engine snapshot, deadline, fitting, and confidence/margin floors as `decide()`. Uncalibrated, unavailable, invalid, low-confidence, and thin-margin answers keep.

Live `subagent/end` and parent attach reconcile missing outcomes via `SubagentRuntime.childTurnOutcomes`. Classification uses the route in force, not stopReason: completed-on-selection is success; LlmError codes other than UNKNOWN on-selection are failure; max-tokens, abort, interrupt, blocked, UNKNOWN, and off-selection errors are neutral. Neutral never resets. Dedupe key is `(routeRequestId, childTurn)`. Events are required-on-read.

Stats fold `children`/`recentChildren`, Settings Subagent routing (schema-gated), parent Routing KPI/card, child-session notice, and Trajectory CHILD-ROUTE rows ship with the consumer. A routed child's first `request/header` must match the parent `model-routing/child-decision` selection (runtime-owned join via the live session store and `childTurnOutcomes`; missing/corrupt/no-persistence/not-a-child stay unavailable). The keyless `model-router-subagent` snapshot starts a real spawn (routed) and fork (no child-route dispatch) through `resolveChildRoute` + `ctx.subagents.start`, and pins each child's own session log. The fork copies the parent seed; its own first `request/header` is the first header with `seq >= seedLength` and stays on the manual base. Follow-up arms pin shadow inheritance, `judge: true` / `child-judged`, and two countable candidate failures then `child-route-errors`. Web GIF remains Lead-only.

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
- Classification tests: success, QUOTA/SERVER/TRANSPORT failure, UNKNOWN/max-tokens/aborted/blocked/off-selection neutral; breaker N failures, success reset, mode-on reset.

## Risks

- Reconcile currently discovers child ids from already-recorded outcomes; the live `subagent/end` path is the first writer. A parent that never saw end still needs those ids from the child's descriptor on a later follow-up — a follow-up if attach has no prior outcomes.

## Verification

Covered by the acceptance criteria above. Keyless child-log snapshots: `model-router-subagent` (spawn + fork), `model-router-subagent-shadow`, `model-router-subagent-judge`, `model-router-subagent-guard`. Countable child failure is an on-selection LlmError other than UNKNOWN (`QUOTA`, `SERVER`, `TRANSPORT`). The guard arm scripts `quota_exceeded` → `QUOTA` because it is not retryable, so the scripted count is exact. `server_error` maps to `SERVER`, which also counts after retries are exhausted.
