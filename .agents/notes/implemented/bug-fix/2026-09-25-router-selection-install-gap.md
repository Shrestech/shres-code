# Agent Note: Every root agent can be routed, whichever front end created it

Status: implemented

## Problem

The model router is reached through one path only: the agent-scoped `agent/request` listener that `installModelSelection` registers ([packages/core/agent/src/model-selection.ts](../../../../packages/core/agent/src/model-selection.ts)) applies the manual selection and then calls `ctx.modelRouting.resolveRequest(...)`. Front ends installed it themselves: the Web Host API for every session it creates, resumes, or forks, and the headless profile in its `agents.create` setup. The ACP server, the JSON-RPC server, and agents the agent loop pre-creates from its `agents` config (every example spine) installed nothing, and with `agent-default-model` and `commands` composed they installed it only once a `/model` command ran. The router still adopted those agents on `agent/created`, appended `model-routing/configuration { active: true }`, and answered "Routing is on." to `/route status`, but no request ever reached it: no decision, no log line. Routing was silently off, which the "misconfiguration fails loud" rule forbids. The router also adopted delegated children and wrote a routing mode into their sessions, although a child is routed only by `subagent/child-route`.

## Decision

**The agent registry installs one hook on every root agent.** `AgentRegistry.enter` ([packages/core/agent/src/index.ts](../../../../packages/core/agent/src/index.ts)) installs the model-selection hook before the agent is announced, on create and on resume, for every agent whose session header records no `delegationDepth`; setup that already installed it is not repeated. A root agent is defined by delegation depth, not by `parentSession`: `childSessionMeta` stamps every subagent and Team seat header with `delegationDepth` (equal to `AgentOptions.subagentDepth` at creation, and persisted across resume), while a user fork records `parentSession` with depth zero and stays a routed root agent. The agent loop does not change.

**Front ends provide the manual selection instead of installing.** `provideModelSelection(agent, ref)` fills the hook's slot; `agentDefaultModel.selectionFor` and the Host API's `selectionFor` call it, the Host API delegating to `agentDefaultModel` when it is composed, so a Web session has one provider. A second, different provider for the same agent throws, and a second hook throws, so no request can be consulted twice. An agent the registry did not hook, such as a delegated child, gets the hook when a front end provides its selection. `modelSelectionInstalled(agent)` reports the hook.

**Without a provided selection, the manual route is the router's report beneath a routed header.** The agent loop seeds each request after the first from the last logged request header, so after a downgrade the resolved route is the candidate. The hook's manual route is therefore `ctx.modelRouting.stickySelection(agent)`, the streak's entry base or the manual route beneath a routed header, else the request's resolved route, and it rewrites the request only when the two differ. A kept-strong decision thus runs the manual route, a hold cap returns to it, and a resumed agent continues its streak from the entry base. With no router composed there is no report and nothing is rewritten, so request headers are byte-identical to an unhooked agent's. A header a router left on a candidate before it was removed stays in force until a front end provides a selection, because nothing reports a manual route beneath it.

**The router adopts root agents only and reports what it cannot reach.** The controller ([packages/llm/model-router/src/index.ts](../../../../packages/llm/model-router/src/index.ts)) skips delegated children in adoption and returns no route for one in `resolveRequest`, even when a front end gave it a hook and its seeded log carries a routing mode. A root agent without the hook, possible only under a registry that does not install it, is reported at error level once and gets no routing mode, and `/route` answers "Routing can't run for this agent: it has no model-selection hook."

Session logs written before this change that record routing on with no decisions are not migrated, under the pre-release stance; the Routing view's "on, no decisions" state describes them.

## Alternatives considered

**Keep the resolved route as the manual base for an agent with no provided selection.** This was the proposal as first written. The loop seeds each request after the first from the last logged header, so after a downgrade the resolved route is the candidate: the router is handed the candidate as the manual route, and a kept-strong or hold-cap decision still runs the candidate. The keyless hold-cap snapshot, run without a provided selection, sent both requests to the candidate.

**Use `selectionInForce(agent)` as that base.** It also honours explicit `agent/model-selection` events and falls back to the logged header. With no router composed it would rewrite each request with its own header's effort, turning an adapter-default effort into an explicit one and changing request headers of compositions that never route; it would also make the ACP and JSON-RPC servers honour an explicit selection another front end wrote, which no front end of theirs owns.

**Seed each request from the agent's creation options instead of the logged header.** The loop's header seeding keeps a session on the route it last ran and restores an explicit effort across restarts; changing it is an agent-loop change with effects beyond routing.

**Install eagerly from `agent-default-model`.** It is absent from exactly the compositions that were affected, and its selection falls back to the deployment-wide default, which would move an ACP or JSON-RPC session off its own provider and model.

**Install a consult-only hook from the router.** The router would own an installation that the front ends also make, and a later `/model` would register a second listener unless the hook's source were replaceable, which is the slot the agent package now owns.

**Only fail loud.** Reporting the missing hook without installing it would leave the ACP, JSON-RPC, and example-spine deployments unable to route.

## Consequences

- The ACP and JSON-RPC servers and agent-loop-configured agents are routed when a router is composed and on.
- A routed delegated child gets no in-turn `route-failed` fallback from the router, because the router does not adopt it. Subagent routing (redesign plan PR 13b) must choose a replacement: the child's own `llm-retry` policy, or a child-route that records a fallback route. This reverses the redesign plan §4.2 line that installs the router listener for children too.
- In compositions whose front end provides no selection, the manual route keeps an adapter-default reasoning effort as a default rather than as an explicit effort, so an entry base records no `reasoningEffort`. The router's keyless snapshots now run this path.
- A test fake registered with the agent registry needs a scoped `ctx`, because a root agent gets the hook's listeners on it.

## Verification

- `packages/core/agent/tests/model-selection.spec.ts`: one hook per agent, one provider, the empty-source rewrite from the router's report, and pass-through with no router.
- `packages/core/agent-loop/tests/model-selection-hook.spec.ts`: through the real factory, the hook is installed before `agent/created` on create and on resume and not on a delegated child, a child is never consulted, and each request makes one consult whether the selection is provided in setup, later, or never.
- `packages/llm/model-router/tests/composition.spec.ts`: through the real Loader and loop with no provided selection, a kept-strong decision after a downgrade runs the creation route, a hold cap returns to it, a resumed agent continues its streak from the entry base, and a routed header survives the router's removal; the composition specs no longer call `selectionFor`.
- `packages/llm/model-router/tests/front-end-composition.spec.ts`: a JSON-RPC session and an agent-loop-configured agent, with no `selectionFor`, each record a decision and run the candidate.
- `packages/llm/model-router/tests/controller.spec.ts`: a delegated child is not adopted or routed, a user fork is adopted, and an unhooked root is reported once with no mode and the `/route` message.
- `packages/host/apiproxy/tests/api-proxy-selection.spec.ts`: a Web fork is a root agent and routes, and a Web session has exactly one provider when the Host API delegates to `agentDefaultModel`.
- The keyless router snapshots run without the fixture's `selectionFor` call, and the `model-router-llm-judge` arm composes no fixture row; the non-router keyless snapshots are unchanged.
