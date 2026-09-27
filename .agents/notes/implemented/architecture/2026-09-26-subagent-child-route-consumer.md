# Agent Note: Model-router child-route consumer (judge and outcomes)

Status: implemented

## Problem

The model-router consumer decides a fresh child's route at spawn and later counts that child's accounting turns toward a per-candidate breaker, without adopting the child or reading its files.

## Decision

The controller registers `subagent/child-route` (next() first). Off and unmatched rules write nothing. On returns the first matching pool route. Shadow logs the same decision and returns undefined. Judge rules ask keep-current vs the candidate over `request.prompt` with correlation `child:<routeRequestId>`, using the same engine snapshot, deadline, fitting, and confidence/margin floors as `decide()`. A prompt longer than `state.maxChars` is kept before dispatch with `input-too-large`, `promptChars`, and `inputChars: 0`. Uncalibrated, unavailable, invalid, low-confidence, and thin-margin answers keep.

Each judged child decision records its questions, plain `judgmentState` or fitted `judgmentInput`, route answer, engine identity, effective thresholds, latency, offered character count, usage, capacity rejection, and engine failure. Dispatcher refusal and fit rejection retain their no-inference facts. Parent cancellation rethrows without logging; a late answer after `judgmentDeadlineMs` records its facts with `DEADLINE` and cannot route. The mode is checked again after the answer, so only `on` returns a pool route. Candidate options use the pool description.

Live `subagent/end` and parent attach reconcile missing outcomes via `SubagentRuntime.childTurnOutcomes`. Classification uses the route in force, not stopReason: completed-on-selection is success; LlmError codes other than UNKNOWN on-selection are failure; max-tokens, abort, interrupt, blocked, UNKNOWN, and off-selection errors are neutral. Neutral never resets. Dedupe key is `(routeRequestId, childTurn)`. Events are required-on-read.

Stats fold `children`/`recentChildren`, Settings Subagent routing (schema-gated), parent Routing KPI/card, child-session notice, and Trajectory CHILD-ROUTE rows ship with the consumer. Child statistics count spawn decisions, including shadow decisions; candidate suspension is folded from child outcomes and is not a `children` stats field. A routed child's first `request/header` must match the parent `model-routing/child-decision` selection (runtime-owned join via the live session store and `childTurnOutcomes`; missing/corrupt/no-persistence/not-a-child stay unavailable). The keyless `model-router-subagent` snapshot starts a real spawn (routed) and fork (no child-route dispatch) through `resolveChildRoute` + `ctx.subagents.start`, and pins each child's own session log. The fork copies the parent seed; its own first `request/header` is the first header with `seq >= seedLength` and stays on the manual base. Follow-up arms pin shadow inheritance, `judge: true` / `child-judged`, and two countable candidate failures then `child-route-errors`.

## Alternatives considered

**Adopt the child and rewrite its route mid-turn.** Rejected: that is router adoption, which would bypass the recorded spawn decision.

**Count stopReason from subagent/end.** Rejected: a completed turn on a different route is not a candidate success.

## Consequences

- Explicit routes, forks, and non-honoring providers still never dispatch (foundation).
- A resumed parent re-reads live or persisted child logs through the runtime, not the filesystem.

## Testing

- Config tests for childPolicies, catch-all last-rule, judge text, childRouteErrors.
- Consult tests: off, no-match, on, shadow, unlisted, equal, suspended.
- Controller tests: off, on static, shadow, judge correlation `child:<id>`, plain and fitted telemetry, fit rejection, prompt-size refusal, mode recheck, parent cancellation, and late-answer deadline handling.
- Classification tests: success, QUOTA/SERVER/TRANSPORT failure, UNKNOWN/max-tokens/aborted/blocked/off-selection neutral; breaker N failures, success reset, mode-on reset.

## Limitations

- Reconciliation discovers child ids from already-recorded outcomes; the live `subagent/end` path is the first writer. Parent attach cannot recover a child whose first outcome was never recorded, so that failure does not advance the candidate breaker until an observable settlement records it.

## Verification

Keyless child-log snapshots: `model-router-subagent` (spawn + fork), `model-router-subagent-shadow`, `model-router-subagent-judge`, `model-router-subagent-guard`. Countable child failure is an on-selection LlmError other than UNKNOWN (`QUOTA`, `SERVER`, `TRANSPORT`). The guard arm scripts `quota_exceeded` → `QUOTA` because it is not retryable, so the scripted count is exact. `server_error` maps to `SERVER`, which also counts after retries are exhausted.
