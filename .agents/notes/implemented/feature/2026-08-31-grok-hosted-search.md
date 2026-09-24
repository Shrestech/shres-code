# Agent Note: hosted web search and X search on grok-session

Status: implemented

## Problem

The Grok subscription proxy can execute web and X search inside a Responses request. These operations must be declared to the provider, distinguished from harness-local function tools, and excluded from local dispatch. The subscription route shares pi-ai streaming and replay with other providers, so adding search must preserve that implementation rather than introduce a second Responses client.

## Decision

Declare hosted capabilities on the route and let the shared llm-pi-ai adapter splice the corresponding entries into each outgoing payload. The Grok settings switches `hostedWebSearch` and `hostedXSearch` default on and reject non-boolean values. Account access is checked by the provider when a request runs, not inferred from these switches.

- **Request declarations:** the adapter uses pi-ai’s payload hook to add hosted search entries and withdraw colliding local function declarations. The tool entries follow the Grok Build sampler’s Responses protocol. Request-level narrowing can select a subset of the route’s declared capabilities.
- **Hosted calls:** observed provider operations become `server-tool-call` blocks, which the agent loop does not execute. The [X call-family and replay decision](../architecture/2026-09-25-hosted-x-search-call-family-replay.md) owns subtype recognition, final-payload collision handling, absent status, and replay metadata.
- **Web-search visibility:** pinned pi-ai drops `web_search_call` items and structured URL-citation annotations before the harness receives them. The adapter has a tested converter for those items, but native web-search results currently arrive through assistant text rather than a captured search-operation block.
- **Other agents:** the separate, default-off sharing setting and auxiliary Grok requests are owned by the [agent-visible X tools decision](2026-09-25-grok-x-search-agent-tools.md). Native hosted search and sharing are separate capabilities.

## Verification

Local proxy tests cover hosted declarations, collision handling, configuration validation, observed hosted calls, and replay. Real Loader snapshots exercise hosted-only turns and mixed hosted/local turns without dispatching hosted calls. The loop’s server-tool-call regression independently verifies exclusion from local execution. Real subscription tests cover an X-search turn followed by a request that reuses its native replay state.

## Alternatives considered

- **Fork pi-ai to surface web-search items:** this adds an owned upstream patch for structured telemetry. The shared adapter already supports provider execution and assistant answers; capturing the missing items remains dependent on an upstream API or a justified raw-wire integration.
- **Own the Responses client in grok-session:** this duplicates streaming, cancellation, and replay behavior already owned by llm-pi-ai.
- **Offer hosted and local search under the same name:** this leaves execution ownership ambiguous. Hosted declarations take precedence unless a trusted final payload hook explicitly restores a client function declaration, as detailed in the call-family decision.
- **Configure only a generic adapter flag:** Grok’s user-facing switches belong with its subscription route. The adapter consumes the resolved capability declaration rather than owning subscription settings.

## Consequences

Search execution remains on the provider backend, and assistant text carries its answer. Captured hosted calls have a neutral transcript summary; structured operation metadata remains available in the trajectory. An absent status is not evidence of completion. Disabling a native hosted capability restores the ordinary local-tool handling for that request. Neither enabled flags nor model-capability badges verify login, plan entitlement, or successful execution.
