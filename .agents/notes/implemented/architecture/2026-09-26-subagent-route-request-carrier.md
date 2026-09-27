# Agent Note: Subagent child-route carrier and childTurnOutcomes (foundation)

Status: implemented

## Problem

The model-router consumer needs a durable identity for one `subagent/child-route` dispatch and an observe-only read of a direct child's accounting turns. The router package must not mint those ids or inspect child logs itself.

## Decision

The subagent package owns the carrier and the observe-only reader. `resolveChildRoute` mints one branded `SubagentRouteRequestId` per waterfall that reaches listeners and copies it onto the child's `AgentOptions` only when a listener changed the route. Explicit routes, forks, unanswered consults, thrown listeners, and equal routes return `requested` unchanged. Both descriptor modes may carry optional nonempty `agentRouteRequestId` at version 2. `subagent/start` and `subagent/end` carry the same optional id and the invariant requires them to agree. `SubagentRuntime.childTurnOutcomes(parent, childId, signal)` reads the live session first, otherwise one persistence inspect under the listing lifecycle witness, and returns accounting turns from `foldConsumedWork` plus the last `request/header` at a lower seq, or `unavailable`.

The subagent package owns request identity and child-log access; the model-router consumer owns judgment, decisions, and candidate failure accounting.

## Alternatives considered

**Mint the id in the router.** Rejected: the dispatch is owned by subagent, and a router-minted id would not exist on non-router consults that still need a stable request identity.

**Always stamp the id onto the child.** Rejected: inherited, explicit, and fork children never dispatched or never changed route, and stamping would make start/end look routed.

## Consequences

- Listeners that change the route can record `request.routeRequestId` before the child exists.
- Cold resume restores the descriptor id onto options so later start/end pairs still agree.
- `childTurnOutcomes` is observe-only: no events, no mutation. Cancellation rejects; data damage returns `unavailable`.

## Testing

- `packages/subagent/subagent/tests/child-route.spec.ts`: mint per dispatch; carry only on change; none for explicit/fork; one-shot descriptor and start/end ids match.
- `packages/subagent/tool-subagent/tests/child-route.spec.ts`: a routed tool child carries the id into its start request, while an unchanged inherited route carries no id.
- `packages/subagent/subagent/tests/invariant.spec.ts`: mismatched start/end route-request ids fail.
- `packages/subagent/subagent/tests/service.spec.ts`: empty/non-string `agentRouteRequestId` rejected; round-trip.
- `packages/subagent/subagent/tests/child-outcomes.spec.ts`: live completed/max-tokens/error/outputSchema; two continuable epochs; fold of completed/error/blocked/aborted/interrupted/max-tokens; unavailable missing/no-persistence/not-a-child; cancel rejects.
- `packages/subagent/subagent/tests/continuation.spec.ts`: cold resume restores `agentRouteRequestId` onto child options.

## Limitations

- The id identifies a changed route, not every child dispatch. Consumers must preserve the mint-on-change rule when joining decisions to children.
- Catalog and type-equiv pastes must stay in lockstep with the public types, or doc-sync fails on the combined 13b base.
