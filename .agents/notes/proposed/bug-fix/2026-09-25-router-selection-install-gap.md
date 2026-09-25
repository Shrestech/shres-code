# Agent Note: Routing is silently skipped for agents without an installed model selection

Status: proposed

## Problem

The model router is reached through one path only. `installModelSelection` ([packages/core/agent/src/model-selection.ts:179](../../../../packages/core/agent/src/model-selection.ts)) registers the agent-scoped `agent/request` listener that applies the session's manual selection and then calls `ctx.modelRouting.resolveRequest(...)` ([packages/core/agent/src/model-selection.ts:207](../../../../packages/core/agent/src/model-selection.ts)). Nothing else calls the consult. An agent for which no front end called `installModelSelection` sends every request on its creation options, and the router is never asked.

The router still adopts such an agent. `ModelRoutingController` attaches every agent whose context resolves it on `agent/created` ([packages/llm/model-router/src/index.ts:464](../../../../packages/llm/model-router/src/index.ts), [packages/llm/model-router/src/index.ts:595](../../../../packages/llm/model-router/src/index.ts)), and with `initialMode: on` it appends `model-routing/configuration { active: true }` to the session ([packages/llm/model-router/src/index.ts:713](../../../../packages/llm/model-router/src/index.ts)). `/route status` then answers "Routing is on." ([packages/llm/model-router/src/index.ts:1304](../../../../packages/llm/model-router/src/index.ts)). No `model-routing/decision` is ever written, and nothing is logged at any level. A deployment that composes the router with its mode on therefore records routing as on and never routes, which is the silent skip the "misconfiguration fails loud" rule forbids.

Observed in a keyless headless composition: a copy of `examples/headless-agent/model-router-on.cordis.snapshot.yml` that selects `@shres-code/shres-code-judgment-llm` as its judgment engine and omits the `./tests/fixtures/model-router-snapshot-fixture.ts` row booted the example spine with the router on. The session log held `model-routing/configuration { active: true }`, one turn on the manual route, and no `model-routing/decision`. A file trace showed `installModelSelection` never ran and `resolveRequest` was never reached. With the fixture row, whose only relevant act is `agentDefaultModel.selectionFor(agent)` on agent creation ([examples/headless-agent/tests/fixtures/model-router-snapshot-fixture.ts:179](../../../../examples/headless-agent/tests/fixtures/model-router-snapshot-fixture.ts)), the router is consulted. Every router snapshot and the router's composition specs install the selection explicitly ([packages/llm/model-router/tests/composition.spec.ts:278](../../../../packages/llm/model-router/tests/composition.spec.ts), [packages/llm/model-router/tests/provider-composition.spec.ts:358](../../../../packages/llm/model-router/tests/provider-composition.spec.ts), [packages/llm/judgment-laya/tests/composition.spec.ts:184](../../../../packages/llm/judgment-laya/tests/composition.spec.ts)), so no test covers a composition that does not.

## Which agents install a selection

`installModelSelection` is called by `agentDefaultModel.selectionFor(agent)` ([packages/core/agent-default-model/src/index.ts:197](../../../../packages/core/agent-default-model/src/index.ts), lazily, once per agent) and by the Host API's own `selectionFor` ([packages/host/apiproxy/src/api-proxy.ts:1223](../../../../packages/host/apiproxy/src/api-proxy.ts)), which delegates to `agentDefaultModel` when it is composed. The router is not composed by any shipped profile patch (`packages/bundle/base`, `web-app`, `headless`); a deployment adds it through an overlay or `shres plugin add`.

| Agent source | Selection installed | Router consulted when composed and on |
|---|---|---|
| Web (`shres web`): fresh, resumed, and forked sessions | Eagerly, in the `setup` every `composeAgent` result runs ([packages/host/apiproxy/src/api-proxy.ts:1290](../../../../packages/host/apiproxy/src/api-proxy.ts), [packages/host/apiproxy/src/api-proxy.ts:1247](../../../../packages/host/apiproxy/src/api-proxy.ts)) | Yes |
| Headless profile (`shres --profile headless`) | Eagerly, in the `agents.create` `setup` ([packages/bundle/headless/src/index.ts:114](../../../../packages/bundle/headless/src/index.ts)) | Yes |
| Agents the agent loop pre-creates from its `agents` config: `examples/headless-agent/cordis.yml`, `examples/jsonrpc-agent/cordis.yml` ([packages/core/agent-loop/src/index.ts:356](../../../../packages/core/agent-loop/src/index.ts)) | Never in these compositions, which compose neither `agent-default-model` nor `commands`; with both composed, only after a `/model` command runs ([packages/core/agent-default-model/src/command.ts:103](../../../../packages/core/agent-default-model/src/command.ts)) | No; with `/model` available, not until it runs |
| ACP server sessions (`@shres-code/shres-code-acp`; `examples/acp-agent/cordis.yml` and the `acp-demo` app) ([packages/acp/acp/src/index.ts:259](../../../../packages/acp/acp/src/index.ts)) | Never in these compositions; with `agent-default-model` and `commands` composed, only after `/model` runs | No |
| JSON-RPC server sessions (`@shres-code/shres-code-sdk-jsonrpc-server`; the `jsonrpc-demo` app) ([packages/sdk/server/src/server.ts:221](../../../../packages/sdk/server/src/server.ts)) | Never in these compositions; with `agent-default-model` and `commands` composed, only after `/model` runs | No |
| Subagent children and Team seats ([packages/subagent/subagent-in-process-driver/src/index.ts:133](../../../../packages/subagent/subagent-in-process-driver/src/index.ts), [packages/subagent/subagent/src/continuation.ts:1121](../../../../packages/subagent/subagent/src/continuation.ts)) | Never | No |

The two shipped `shres` profiles install eagerly and route. The gap affects the ACP and JSON-RPC server apps, agents pre-created by the agent loop (every example spine that configures `agents`), and any future front end that creates agents without calling `selectionFor`. Where `agent-default-model` and `commands` are composed with those front ends, a session changes behavior mid-way: a `/model` command installs the selection, and routing starts on the next request.

Children are not routed by design: the redesign plan routes a child only through `subagent/child-route` at spawn ([redesign plan](../feature/2026-09-24-model-routing-redesign-plan.md)). By code reading, the controller nevertheless adopts a child whose context resolves it and writes `model-routing/configuration { active: true }` into the child's session, so a child session also records routing as on. This part is not reproduced.

## Proposal

Give every root agent exactly one `agent/request` consult from the moment it is created, independent of which front end created it, and keep the front end as the owner of the manual selection only.

1. **The agent package installs the hook at creation.** The agent registry calls `installModelSelection` once for every root agent (no `parentSession`) it creates or resumes, with a selection slot whose manual source is empty. With an empty source the hook already consults with the request's resolved route as the manual base and rewrites nothing ([packages/core/agent/src/model-selection.ts:199](../../../../packages/core/agent/src/model-selection.ts)), so a composition without a router or a front-end selection runs exactly as today. This reaches the ACP and JSON-RPC servers and agent-loop-configured agents, none of which compose `agent-default-model`.
2. **Front ends provide the manual source instead of installing.** `agentDefaultModel.selectionFor(agent)` and the Host API's `selectionFor` fill the agent's slot with their selection reference rather than registering their own listener. A second provider for the same agent fails loud, so no request can be consulted twice. The headless bundle and the Host API keep their eager calls, which now fill the slot.
3. **Children are not adopted.** The controller skips agents with a `parentSession` in `attachAgent`, so a child session carries no routing mode, and the hook in step 1 is not installed for children. Child routing stays with `subagent/child-route`.
4. **The router reports an adopted root agent it cannot reach.** The agent package exports a read such as `modelSelectionInstalled(agent)`. When the controller adopts a root agent for which it is false — possible only in a composition that replaces the agent registry — it logs at error level once per agent and appends no `model-routing/configuration`, so the log never records routing as on for an agent it cannot route.

## Alternatives considered

**Install eagerly from `agent-default-model`.** `agent-default-model` could call `selectionFor` on `agent/created` for every root agent. It is composed by the shipped base patch, but not by the ACP, JSON-RPC, or example spines, which are the affected compositions, so the gap would remain there. Its selection also falls back to the deployment-wide default ([packages/core/agent-default-model/src/index.ts:200](../../../../packages/core/agent-default-model/src/index.ts)), which would move an ACP or JSON-RPC session created with its own provider and model onto that default.

**Install a consult-only hook from the router.** On adopting a root agent without a hook, the router could call `installModelSelection` with an empty selection. It reaches every composition that composes the router, but the router would then own an installation that `agent-default-model` and the Host API also make, and a later `/model` or Host API install would register a second listener unless `installModelSelection` learned to replace an installation's source, which is step 2's slot owned by the wrong package.

**Call the consult from the agent loop's base request path.** This moves the consult out of the selection hook so no front end can omit it. It changes `agent-loop` and the order the consult relies on: the manual selection must rewrite the request before the router reads its base. It is not proposed.

**Only fail loud.** Reporting the missing installation without installing it satisfies the rule but leaves ACP, JSON-RPC, and example-spine deployments unable to route. Step 4 keeps the report for the one composition step 1 cannot reach.

## Acceptance criteria

- A keyless headless snapshot composes the router with its mode on over the example spine, with no fixture that calls `selectionFor`, and records a `model-routing/decision` and a routed `request/header` for the first request.
- A keyless ACP snapshot creates a session through `session/new` with the router on and records a routing decision for its first prompt.
- A unit test proves that one root agent gets one `agent/request` consult per request whether zero, one, or both of `agent-default-model` and the Host API provide its selection, and that a second provider for the same agent fails.
- A unit test proves that an ACP or JSON-RPC session created with its own provider and model keeps that route as the manual base.
- A composition whose agent registry does not install the hook, with the router on, logs the router's error once per root agent and writes no `model-routing/configuration` for it.
- A subagent child of a routed parent carries no `model-routing/configuration` event, and its requests make no `resolveRequest` call.
- The router's composition specs, the Laya composition spec, and the router snapshots drop their explicit `selectionFor` calls and pass.

## Risks

- Every root agent gains an `agent/request` listener. Without a router or a manual source it passes the resolved request through unchanged, so compositions without a router keep their requests byte-identical; the snapshot suites verify that.
- Step 2 turns a second selection provider from a silent duplicate consult into a load-time failure. A front end that installs twice today fails once this lands, which is the intended signal.
- Excluding children from adoption removes `model-routing/configuration` from child sessions; a reader that inferred a child's mode from that event reads no mode.
