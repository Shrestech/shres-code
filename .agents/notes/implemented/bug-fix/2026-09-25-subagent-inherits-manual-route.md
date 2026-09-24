# Agent Note: Children inherit the parent's manual route, not a routed header

Status: implemented

## Problem

A delegated child with no requested provider or model inherits its parent's route through the subagent package's inheritance helper, which read the parent's latest logged request header first. Under `model-router`, a held downgrade rewrites that header to the routed candidate, so the header stops naming the route the session is pointed at. While a parent was downgraded:

- a fresh child inherited the cheap candidate with no routing decision of its own, outside the router's `routeFrom` and pool policy;
- the `inherited` route a `subagent/child-route` listener was told was that candidate;
- a continuable child recorded the candidate as its descriptor route and reused it on follow-up and cold resume, so the downgrade outlived the parent's streak;
- a fork child took the same path;
- a reader of the same route, such as a Team roster reporting the Lead, reported the candidate.

It is reachable only with a router composed.

## Decision

The inheritance helper reads `selectionInForce(parent)` from the agent package before the live default-model selection and the parent's creation options. `selectionInForce` is the Definition-owned answer to "which selection is this session pointed at": the explicit `agent/model-selection`, else the manual base a composed `ctx.modelRouting` reports beneath a routed header (`stickySelection`, which also covers the header left by a streak that has just ended), else the logged header. `agent-default-model` and the Host API already read it for the same question. The subagent package already peer-depends on the agent package, so no dependency is added, and the router stays unknown to the subagent package.

A cheaper route for a child is a routing decision, made only through `subagent/child-route` by a listener that chooses and logs it. With no router and no explicit selection, the helper reads the same logged header as before. The only non-router difference is the window after an explicit `/model` switch and before the parent's next request, where a reader now sees the new selection. A tool-driven delegation always runs after the request that carries the selection, so it cannot observe that window.

## Alternatives considered

**Read the router's streak state in the subagent package.** That would make the subagent package know the router's fold and duplicate what `selectionInForce` already answers through the optional `ctx.modelRouting` consult. Reading the agent package's selection keeps one answer for every reader.

**Read the live default-model selection first.** The live default is a deployment-wide selection; a session with its own explicit `/model` choice runs that choice, so a child of that session would inherit the wrong route. The selection in force already falls back to the header, and the live default follows it only for a parent that has neither.

**Leave inheritance on the header and let a child-route policy correct it.** The `inherited` route is what a policy compares against, and continuable children and forks never consult the waterfall. Correcting only the waterfall's answer would leave those paths on the candidate.

## Consequences

- A child of a parent on a held downgrade runs the parent's manual route, and a continuable child records and keeps that route.
- A `subagent/child-route` listener is told the manual route as `inherited`, so a child-route policy compares its choice with the route the child would otherwise run.
- A parent whose durable explicit selection has invalid fields now fails the delegation, as the parent's own next request would.

## Verification

- `packages/subagent/subagent/tests/child-agent.spec.ts`: the manual base beneath a routed header, an explicit selection over the header, the header when no router and no selection exist, and a per-child override over the manual selection.
- `packages/llm/model-router/tests/composition.spec.ts` ("children of a parent on a held downgrade") boots the router, subagent runtime, spawn, fork, `tool-subagent`, and session persistence through the real Loader. A parent on a held streak spawns a child through its own `subagent` call: the wire serves the parent step on the candidate, the child on the manual route, and the next parent step on the candidate, and the listener saw the manual route. A fork child and a continuable child run the manual route, and the continuable descriptor records it.
- Negative control: restoring header-first inheritance fails all five of those tests.
