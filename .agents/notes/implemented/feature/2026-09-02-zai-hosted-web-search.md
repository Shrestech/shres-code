# Agent Note: z.ai hosted web search on the openai-completions dialect

Status: implemented

## Problem

PR1 made hosted tools a declared route capability but shipped one dialect module (`openai-responses`, the Grok/xAI proxies). The user's named case — "if a z.ai provider model is used, the websearch to be used is z.ai's" — needed the `openai-completions` dialect, which z.ai's GLM coding endpoint speaks, before any route declaration could turn the capability on.

## Decision

A second dialect module, `hosted-tools/openai-completions.ts`, serving exactly one tool: the request-side entry `{"type":"web_search","web_search":{"search_engine":"search-prime"}}` — the same external-spec engine code `web-search-attached-cli` already sends — with the colliding local `web_search` dropped per request and an empty `callNames` list. The base bundle's `zai` route declares `hostedTools: { webSearch: true }`, so selecting a z.ai model makes the provider's own search the route's normal search, and the local chain (attached-cli first) stops serving `web_search` for it. `x_search` stays responses-only; resolution rejects it here.

The response surface was pinned by a live spike against `api.z.ai/api/coding/paas/v4` (2026-09-02, streaming and non-streaming, secrets unquoted): the tool entry is accepted and the search executes server-side, but **no artifact surfaces** — no `tool_calls`, no `search_result` field in either mode, answer text and `stop` as a plain chat turn (the served model also reported a newer generation than requested, `glm-4.7` for a `glm-4.5-air` call). The dialect therefore promotes nothing: the search's existence rides the billing, the answer text, and this note. A `ZAI_API_KEY`-gated e2e pins that surface (entry accepted, silent fold, local `web_search` never dispatched) so a z.ai change that starts surfacing an artifact fails a named test instead of shipping unnoticed.

## Alternatives considered

**Parse reasoning deltas or sniff content for evidence of search.** Rejected: no wire fact distinguishes "searched then answered" from "answered from stale knowledge" (the spike's non-search answer was indistinguishable in shape), so any heuristic would be a guess wearing a test's clothes.

**Wait for a surfaced artifact before shipping the declaration.** Rejected: the capability the user asked for is the search executing on their selected provider, which the entry delivers today; observability is z.ai's gap to close, and the e2e will catch it.

## Consequences

Every request on the `zai` route now carries the tool entry, so z.ai bills a search query per request while the declaration is on — the composition row states this and a deployment can turn it off per route or per model through the same `hostedTools` vocabulary. Models on other `openai-completions` routes (ollama, kimi, gateways) are unaffected until they declare. The [hosted-tools capability note](../architecture/2026-09-02-hosted-tools-route-capability.md) owns the machinery; this one owns the z.ai wire facts.
