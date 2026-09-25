# Agent Note: Hosted X search call family and replay on pi-ai routes

Status: implemented

## Problem

A signed-in Grok subscription request that declares the hosted `{ "type": "x_search" }` tool receives each X search the backend runs as a Responses `custom_tool_call` named `x_search`, `x_keyword_search`, `x_semantic_search`, `x_user_search`, or `x_thread_fetch`. Live probes on the `grok-session` route returned `x_keyword_search`, `x_user_search`, and `x_semantic_search` calls. The Grok Build sampler normalizes that family to `x_search` (`crates/codegen/xai-grok-sampler/src/stream/responses.rs`, the `CustomToolCall` arm), and its pager recognizes the four subtypes (`crates/codegen/xai-grok-pager/src/acp/tracker.rs`).

The llm-pi-ai adapter promoted only the literal `x_search`, and the live probes called the adapter directly, so they returned the other subtypes as ordinary tool calls without running an agent loop. In an agent loop those tool calls would be dispatched, fail with `UNKNOWN_TOOL`, and be sent back with their error results on the next request; that consequence follows from the code and was not observed live. The promotion also recorded `status: 'completed'` although pi-ai's tool call reports no status. A turn with a promoted block could not replay natively: the stored per-block replay entry still said `tool-call`, so every later request logged `INVALID_REPLAY_STATE` and resent the message as provider-neutral history.

## Decision

- **One call family per hosted tool.** `HOSTED_X_SEARCH_CALL_NAMES` in `llm-pi-ai/src/hosted-tools/openai-responses.ts` lists the five names. When a model hosts `x_search`, the `openai-responses` plan registers the whole family as promotable call names and drops client function tools with those names from the request (hosted wins, as with `web_search`).
- **Promote only what the sent request did not declare.** After the hosted splice and the route's own `onPayload` hook, `promotableCallNames` removes every name the final `tools` array still declares as a client tool. `mapHostedToolCalls` promotes a call only when its name is still promotable. Unknown future names and all X calls on a route with `xSearch` off stay ordinary tool calls. The adapter does not guess from id prefixes and does not promote custom tool calls in general.
- **Canonical kind, reported subtype, no invented status.** A promoted block records `kind: 'x_search'`, the reported call name as `name`, and the pi-ai call id. `ServerToolCallBlock.status` and `ServerToolCallInput.status` are optional; `toServerToolCallBlock` omits an absent status, the item converters copy a reported `completed`/`failed` and otherwise omit it, and the Agent Teams message decoder accepts a block without one.
- **Replay without the hosted call.** The pi-ai replay envelope is version 3. `mapHostedToolCalls` retags each promoted index `server-tool-call` in the finish chunk's envelope, and `replayedAssistant` omits those blocks from the pi-ai assistant message. The next request therefore carries neither a function call nor a function output for a hosted call, and the message keeps its native ids and signatures. A version 2 envelope degrades to provider-neutral history through the existing unusable-state path, which also omits `server-tool-call` blocks.

The agent loop is unchanged: a step whose only calls are hosted has no local tool call, so the turn ends after that step.

## Alternatives considered

- **Promote every `custom_tool_call`.** Rejected: pi-ai also surfaces local custom (grammar) tools as custom tool calls, and promoting them would silently skip real local work.
- **Classify by id prefix (`ctc_` versus `fc_`).** Rejected: the prefix is an undocumented backend detail and does not say whether the tool is hosted.
- **Keep `status: 'completed'` as a best guess.** Rejected: a failed hosted search would be recorded as a success; an absent status states only what the wire reported.
- **Store the full hosted call in replay metadata to resend it.** Rejected: the backend executes the call inside the same response, and the Grok CLI does not replay it as client history; the `server-tool-call` tag is the only fact validation needs.
- **Add optional query or result enrichment now.** Deferred: pi-ai does not surface the item's result payload, and the name and id are enough to stop dispatch and replay errors.

## Consequences

- While the route hosts `x_search` and the sent request declares no client tool of that name, X searches under any of the five names are logged as `server-tool-call` blocks and never dispatched; the headless snapshots `hosted-search` and `hosted-search-only` pin this through the real agent loop, including a second step whose replayed request the fixture backend checks on the wire.
- A session log written with replay version 2 degrades every version-2 assistant message to provider-neutral history on every request, because each request rebuilds history from the durable messages. The degraded bytes are deterministic, so only the first request after resume misses the prompt cache, and the adapter reports each degraded message once ([once-per-message reporting](../bug-fix/2026-09-25-replay-degrade-reported-once.md)).
- A backend that adds a new X call name keeps it local until the constant lists it; unless a local tool of that name is registered, the loop then reports `UNKNOWN_TOOL` for that call, which makes the gap visible.
- Client renderers must treat `status` as optional.

## Verification

`hosted-tools.spec.ts` pins the family constant, the splice and drop only while hosting, `promotableCallNames`, subtype promotion under the canonical kind, an unknown name staying local, and the replay retag. `adapter.spec.ts` pins a route hook that re-declares `x_user_search` keeping that call local. `convert.spec.ts` pins replay without a function call and without a degrade, and a mismatched tag degrading. `llm-grok-session/tests/hosted-search.spec.ts` streams all five names through the real route, then replays the message and checks the second request carries no function call, function output, or custom tool call and keeps the native message id; with `hostedXSearch: false` the call stays local. `server-tool-call.spec.ts` and the Agent Teams fold spec pin the optional status.

## Related

- [Hosted web search and X search on grok-session](../feature/2026-08-31-grok-hosted-search.md) introduced the splice and the single-name promotion this note extends.
- [LLM server-tool-call block](../feature/2026-08-31-llm-server-tool-call-block.md) owns the block and the loop exclusion.
- [Hosted tools as a route capability](2026-09-02-hosted-tools-route-capability.md) owns the per-model declaration and dialect plans.
- [Grok X search tools for Shres agents on other routes](../feature/2026-09-25-grok-x-search-agent-tools.md) builds the cross-provider X tools on this promotion and the per-request `hostedTools` narrowing.
