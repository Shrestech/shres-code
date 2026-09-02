# Agent Note: deep_research tool over a request-level search provider pin

Status: implemented

## Problem

The model-facing web suite had one search tool (`web_search`) whose backend was the composition's selected search provider. Perplexity's method is not retrieval: it bills a model turn per call and returns a generated, citation-marked answer. Serving that as the ordinary search backend is wrong for routine lookups and right for deliberate research. The seam had no per-call provider pin, so a second model-facing tool could not reach Perplexity without changing the composition's default search selection.

## Decision

`WebSearchRequest.provider` is an optional exclusive search-provider pin. At execution time it wins over the singular config pin and the ordered fallback list and uses the same `WEB_PROVIDER_CONFIGURED_MISSING` / `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` failures as a singular pin.

`shres-tool-web` registers a third tool, `deep_research`, independently gated by `research` (default true). The tool takes `{ query }`, reuses the search result card, and calls `ctx.web.search({ query, maxResults, provider: 'perplexity' }, exec.signal)`. Its cooperative timeout budget is `researchTimeoutMs` (default 180000), not `searchTimeoutMs` (30000), because a deep-research call takes tens of seconds to minutes.

The prompt section states the cost and latency posture and names `web_search` / `web_fetch` only when those tools are also config-enabled. Backend routing, including the Perplexity pin, is not model-visible. Model and recency pass-through stay on the Perplexity provider's own settings; this slice does not add them.

## Alternatives considered

**A separate Perplexity-owned model-facing tool.** Rejected: providers register capabilities, not tools. `shres-tool-web` remains the only owner of model-facing names, schemas, and prompt guidance.

**Reuse `searchTimeoutMs` for deep research.** Rejected: a 30s budget is too short for a billed multi-source synthesis that can take minutes.

**A dedicated `ctx.web.research()` operation.** Rejected: the result is still a `WebSearchResult`. A per-call pin on `search()` is the smaller seam change and keeps one selection owner.

**Advertise Perplexity in model-visible text.** Rejected: the model sees two search tools plus `web_fetch`; backend routing is harness-owned.

## Consequences

A composition can keep `web_search` on the ordinary chain and still offer `deep_research` against Perplexity. When Perplexity is missing or unavailable, `deep_research` stays visible and fails with the configured-id `WebError` codes. The keyless snapshot that exercises the new model-visible tool is a separate change.

## Testing

`packages/web/web/tests/web.spec.ts` covers request-pin hit, not-registered, and unavailable, including a pin that wins over both the singular config pin and the ordered list. `packages/web/tool-web/tests/tool-web.spec.ts` covers registration on/off, the Perplexity request pin, the 180s timeout budget, and the four guidance-text branches.
