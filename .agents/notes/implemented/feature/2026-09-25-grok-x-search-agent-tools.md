# Agent Note: Grok X search tools for Shres agents on other routes

Status: implemented

## Problem

The Grok subscription route can run X (Twitter) search on its backend, but only a conversation whose model runs on `grok-session` could use it. A Shres agent on DeepSeek, Claude, or another route had no way to search X. The options were to delegate to a Grok CLI child, to create a Grok-routed subagent, or to switch the conversation's model. The first two add a second agent loop and its tool surface, and the third changes the caller's model.

## Decision

`@shres-code/shres-code-tool-grok-x-search` registers four read-only tools — `x_keyword_search`, `x_semantic_search`, `x_user_search`, `x_thread_fetch` — that Shres agents on routes other than `grok-session` can call. Each call makes one `ctx.llm.stream` request on the `grok-session` route with the configured model (default `grok-4.6`), a fixed system prompt, one JSON-framed user message, no function tools, and `hostedTools: ['x_search']`.

- **Hosted-tool narrowing is a Service Definition option.** `GenerateOptions.hostedTools` narrows the route's declared hosted tools for one request (`[]` offers none; omission keeps the route default). `LlmRuntime.stream` fails a list naming a tool outside the resolved model info's `hostedTools` with `UNSUPPORTED_OPTION` before calling the adapter, so an adapter that declares no hosted tools cannot silently ignore it. An adapter whose model info declares hosted tools must apply the narrowing; llm-pi-ai filters the declared set before building its splice plan, including which local tools it drops.
- **No recursion, no delegation.** The Grok request offers no function tools, so Grok cannot call the X tools or any local tool. A Grok response containing a local tool call fails the tool call rather than being executed. No CLI process and no child agent exist.
- **Route and attribution.** The request uses the plugin's own `ctx.llm` with an explicit provider and model, so an agent-scoped model selection cannot reroute it. `sessionId` is the calling session. The calling Agent is resolved from the tool execution at entry; before dispatch the call appends an ignorable `grok-x-search/request` event to that session with the exact route, system prompt, messages, hosted tools, and output cap. A call without a calling agent fails instead of making an unrecorded request.
- **Result evidence.** The tool assembles the full stream. It fails when the stream ends in error or abort, when Grok ran no hosted X search (no `server-tool-call` with `kind: 'x_search'`), or when Grok asked for a local tool. Otherwise it returns the distinct reported X operation names with call counts and Grok's answer in an untrusted-content frame. The whole rendered result fits `maxResultChars`: trailing operation names are left out first behind a counted `N more not listed` marker, then the answer is cut before it is framed. Provider call ids are not returned.
- **Post references are checked locally.** `x_thread_fetch` accepts only a numeric post id or an `https` x.com or twitter.com status URL; a profile, search, or other URL fails before any request is recorded or sent, so a malformed reference costs no quota.
- **Honest descriptions.** Each description names what it asks Grok to do and states that Grok runs it, that Grok chooses the operations and may use a different one, what the result contains, and that each call uses Grok plan quota and fails when sign-in or plan does not allow it. The names are requests to a mediator, not direct X API calls.
- **Gate owned by the route's section.** The tools exist only while the `llm-grok-session` section has `enabled`, `hostedXSearch`, and the new `agentXTools` (default `false`) on. The tool plugin owns no settings; it reads the namespace llm-grok-session exports and follows it live. Turning the switch on is configuration, not entitlement: nothing inspects the credential document or promises plan status.
- **Settings registration events.** The settings Service Definition gains `settings/registered(ns, value)` and `settings/unregistered(ns)`, emitted from the one registration effect and its disposer (including owner unload), with the same listener containment as `settings/updated`; the settings invariant checks both. A consumer of another plugin's namespace reads `get()` once and follows the three events, so load order does not matter. When the namespace is still missing after the Loader settles, the tool plugin logs one warning and the tools stay off.
- **Cancellation, disable, unload.** A call's signal fuses the caller's tool signal, a `timeoutMs` deadline (default 180000), and the plugin lifetime. Closing the gate withdraws the tools from later requests; a call already running keeps the authorization it was dispatched with and finishes or times out, and a call that starts after the gate closed fails. Unloading the plugin aborts running calls.
- **Scope.** The tools live in the global tool layer. An agent scope inherits that layer, including a subagent or a preset-joined agent, unless a tool restriction on its scope chain hides the tools. They appear in native tool lists and in code-mode `run_code` SDKs.
- **Invariant.** The companion checks each `grok-x-search/request` names one of the four tools, routes to `grok-session`, and offers exactly `['x_search']`. It does not require a tool result: in-flight, cancelled, and crashed calls legitimately have none.

The Lead owns the Web UI for this feature: the grok-session provider editor exposes `agentXTools` beside `enabled` and `hostedXSearch` with entitlement and quota guidance, and the model picker and transcript render the route's hosted capabilities and hosted calls neutrally.

## Alternatives considered

- **Delegate to the Grok CLI or a Grok-routed child agent.** Rejected: both run a second agent loop with its own tools and approval surface, and the retired delegated CLI routes bypassed harness approval. One auxiliary model request is enough to get the hosted search.
- **Offer the X tools as function tools on the Grok request.** Rejected: Grok could call them again, and the request would need a local dispatch loop.
- **Narrow hosted tools only inside llm-pi-ai.** Rejected: another adapter would ignore the option silently. Enforcing it in the llm service makes an unsupported request fail loud for every adapter.
- **A llm-grok-session-specific section event instead of generic settings registration events.** Rejected: it would duplicate `settings/updated` for one owner, and the next cross-namespace consumer would need another bespoke event.
- **Fail tool-plugin load when the namespace is missing.** Rejected: plugin load order is not guaranteed, so the namespace can legitimately register after the tool plugin loads.
- **Cancel running calls when the gate closes.** Rejected: the call was authorized when dispatched; cancelling mid-flight would discard a paid Grok answer without protecting anything. Later calls fail instead.

## Consequences

- A Shres agent on another route that runs the Shres tool loop can search X when the user opts in, without switching models or creating agents. Delegated CLI routes run their own tools and do not see these; on `grok-session` itself the hosted-wins splice drops client tools named after X call names, so native Grok chat keeps using the hosted search. Every call uses Grok plan quota.
- The Grok request's tokens and model output do not enter the calling conversation; the recorded request and the tool result do.
- `GenerateOptions` gains one optional field; existing requests are unchanged.
- A Grok function call under one of the X call names cannot be told apart from a hosted call by pi-ai, so it would be listed as an X operation.

## Verification

`tool-grok-x-search.spec.ts` runs the real agent loop on a mock non-Grok model with the real llm-grok-session route against a local proxy stand-in: the four descriptions pinned verbatim; the gate following settings writes, owner unload, and reverse load order; an existing code-mode agent's rendered `run_code` SDK listing the tools only while enabled; an existing agent on the real worker-thread code runtime calling `tools.x_keyword_search` from `run_code` once enabled (the nested call records its request on the caller's session and sends the caller's session id) and failing before any Grok request once disabled; a malformed `x_thread_fetch` reference refused with no request; the result bound with many operations at the minimum cap; one Grok request offering exactly `[{ "type": "x_search" }]`, recorded before the tool result, with operations and cited text in the result; failures for no X evidence, a local tool call, a closed gate, a missing agent, a route without hosted X (`UNSUPPORTED_OPTION`, no request sent), caller cancellation, plugin lifetime abort, and the deadline; and the result bound. `invariant.spec.ts` covers the request invariant. The llm service spec covers the `hostedTools` rejection and pass-through, the pi-ai adapter spec covers `['x_search']`, `[]`, and omission on the wire, and the settings specs cover the registration events, a remount, and the invariant. `proxy.e2e.ts` is an opt-in real-proxy check (`SHRES_GROK_X_E2E=1`) that runs each tool once through the tool registry, derives the `x_thread_fetch` post from the keyword result, and fails on any refusal while reporting only the failure code. The keyless headless snapshot `grok-x-tools` runs the shipped headless composition: a non-Grok calling model discovers and calls `x_keyword_search`, the real grok-session route answers from a proxy stand-in, and the transcript ends `X_TOOLS_OK`.

## Related

- [Hosted X search call family and replay](../architecture/2026-09-25-hosted-x-search-call-family-replay.md) owns how hosted X calls surface and replay.
- [Hosted tools as a route capability](../architecture/2026-09-02-hosted-tools-route-capability.md) owns per-model hosted-tool declarations.
- [Hosted web search and X search on grok-session](2026-08-31-grok-hosted-search.md) introduced the grok-session hosted switches.
