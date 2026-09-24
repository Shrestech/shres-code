# Agent Note: The `subagent/child-route` extension point

Status: implemented

## Problem

The model-routing redesign ([proposed plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md)) names subagent routing as its highest-value lever. A fresh child has an isolated context, so running it on a cheaper model causes no churn in the parent's cached prefix, and its delegation prompt is short enough for a small local judge. The subagent seam had no place to make that choice. A child's route came from the delegating tool's configured `agentOptions`, else from the parent's effective route, so choosing a route per child required changing every delegation consumer.

Four constraints bound the extension point:

- A fork child is seeded with the parent's completed turns and reuses the parent's warm cached prefix under the same model. Routing it to another model forfeits that prefix.
- A team seat's configured provider and model are a deployment's explicit binding and must not be overridden.
- An out-of-process provider runs its own configured model and ignores `agentOptions`, so a routed model would be reported for a child that never ran it.
- A later routing policy must record its choice in the parent log before the child exists, so every routed child request stays reconstructable from the logs.

## Decision

`@shres-code/shres-code-subagent` declares one waterfall, `subagent/child-route`, and one service method, `SubagentRuntime.resolveChildRoute(name, input)`, that dispatches it. The method is the only dispatch site. Delegation consumers call it once per fresh child, start the child with its result as `agentOptions`, and derive any reported route from the same result with `effectiveChildRoute`, so the reported route and the run route cannot diverge.

**Consumers.** `tool-subagent` calls it with kind `subagent` and its tool name as `agentType`, after validating the call's background argument so a refused call never asks the route question. The worker-thread workflow engine calls it with kind `workflow` and re-checks run admission after the await, so a child whose route resolution outlives cancellation, worker death, or settlement never starts. Agent Teams rosters and other direct `start()` or `startContinuable()` callers do not call it and are never routed.

**When the waterfall is not consulted.** The method returns the requested options unchanged, without dispatch, when:

- the request names a provider or a model: explicit routes win, and every bound team seat carries both;
- the provider seeds the child with parent history: the fork provider;
- the provider does not set `SubagentProvider.runsRequestedModel`, a new optional descriptive flag that only the in-process `spawn` and `fork` backends set.

**Payload and result.** `SubagentChildRouteRequest` carries the delegating `parent`, the consumer `kind` (`'subagent' | 'workflow'`), the `subagentProvider` name, the `inherited` route (the parent's effective provider and model), the optional `agentType`, the child's `prompt` text, and the delegation's `signal`. The result is `{ provider?, model? } | undefined`. A listener route is merged over the inherited route, and an answer equal to the inherited route leaves the requested options untouched, so an unrouted child's start request is unchanged.

**Ordering contract for a routing policy.** The waterfall settles before any child resource exists. A listener that records its choice appends to `request.parent.session` before returning, and that record precedes the child's creation in the parent log. The payload carries the parent, consumer kind, tool name, and task text such a record needs. The planned router listener's `model-routing/child-decision` event relies on this order.

**Failure behavior.**

- A throwing listener is contained: the method logs a warning naming the consumer kind and provider, and the child keeps its inherited route. Routing is an optional cost policy, so a broken policy must not fail the delegation it would only have made cheaper.
- An `InvariantError` raised during the dispatch is not contained. The waterfall's catch cannot tell a listener's exception from a failure raised by a registered invariant's dispatch hook, so the method checks for the invariants package's `InvariantError` and rethrows it: a violated invariant means the durable log is about to become inconsistent, and the repository requires that to fail loudly. `@shres-code/shres-code-invariants` was already a required peer dependency of this package.
- A cancelled delegation rejects with its cancellation reason instead of falling back, so cancellation is never reported as a policy failure.
- A route that names no provider or model, or that `ctx.llm.resolveModelInfo()` cannot resolve, rejects with `SubagentError` code `INVALID_CHILD_ROUTE` before any child exists. Agent creation itself does not validate a route: an unregistered route would otherwise fail only at the child's first model request, after the child was published and counted.

**Dispatch scope.** Dispatch goes through `scopeTarget(this, parent)`, the same carrier as `subagent/start`, so a listener registered on `parent.ctx` answers only that parent's delegations. Because the payload exposes `parent`, the generated scoped-event resolver reads it, and the scope invariant checks that the carrier key is that exact Agent. Listener registrations are disposed with their fiber, which restores inheritance.

The waterfall is a subagent-capability extension point, not an agent-loop change. [Architecture](../../../../docs/architecture.md#where-new-behavior-goes) lists it among the extension points, and [the subagent subsystem page](../../../../docs/subsystems/subagent.md) owns the new types.

**Later work.** The router's `childPolicies` listener, its `model-routing/child-decision` event, the installation of per-agent model selection for children, and the Settings card's subagent section are a separate change that consumes this extension point.

**Verification.**

- `packages/subagent/subagent/tests/child-route.spec.ts` covers explicit override, fork exclusion, the out-of-process skip, byte-identical no-listener behavior, a routed spawned child whose request header carries the routed model, partial-route merging, the inherited-answer no-op, HMR disposal, parent-scoped dispatch, contained listener failure with its log line, cancellation, and every `INVALID_CHILD_ROUTE` path.
- `packages/subagent/tool-subagent/tests/child-route.loader.spec.ts` boots a test-only `cordis.yml` through the real Loader against the mock model server. A test plugin routes children to `deepseek-v4-flash`, and the parent turn's `subagent` call makes wire requests in the order parent `deepseek-v4-pro`, child `deepseek-v4-flash`, parent `deepseek-v4-pro`. The listener observed only the parent as a live agent. Without the plugin, all three requests use the parent model.
- With the invariant registry and the scope invariant mounted, a routed dispatch is accepted and logs no warning. A test invariant that fails on every `subagent/child-route` dispatch makes `resolveChildRoute` reject with that `InvariantError` and log nothing.
- Negative controls: removing the fork exclusion, the explicit-route rule, the listener containment, route validation, the `InvariantError` rethrow, or the `tool-subagent` wiring each fails its named test, and dispatching with a carrier keyed to no parent fails the scope-invariant test.

No shipped composition registers a listener, so no model-visible output changes and no keyless snapshot applies. The Loader test is the real-composition evidence.

## Alternatives considered

**Dispatch inside `effectiveChildRoute`.** That helper is synchronous and is also called by the continuation manager to derive a continuable child's descriptor route, and by `resolveChildAgentOptions` at child creation. Making it asynchronous would ripple into the in-process driver and the continuation manager, and dispatching there would ask the route question a second time for one child. A single service method called by the consumer before `start()` asks exactly once, and both downstream paths then read the resolved options they are given.

**Dispatch inside `SubagentRuntime.start()` and `startContinuable()`.** The consumer reports the child's route in its result and would need the routed value back from the service. Routing inside start would also put the route question after capability validation and slot occupancy, inside provider-owned setup, where recording a parent-log decision can no longer precede the child cleanly.

**Fail the delegation on a throwing listener.** A routing policy is optional and advisory; failing the delegation would turn a policy bug into lost work. The failure is logged instead. An unregistered route is different: it is a misconfiguration that would otherwise fail later and less clearly, so it rejects.

**Route every provider and let providers ignore the result.** An out-of-process provider ignores `agentOptions`, so the tool would report a model the child never ran. The explicit `runsRequestedModel` flag keeps the reported route truthful.

## Consequences

With no listener, every delegation is byte-identical to its previous behavior. The two consumers now await one extra resolution step before starting a child, which dispatches nothing when no listener is registered. A deployment can route fresh `subagent` and `workflow` children without touching either consumer, while fork children and bound seats keep their routes by construction. A listener that returns an unregistered route breaks delegations loudly at their first use rather than silently falling back. An invariant violated during the dispatch fails the delegation with its `InvariantError` instead of being logged as a routing-policy failure.
