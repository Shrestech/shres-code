# Agent Note: OpenRouter Fetch reads the live `/models` listing, not the pinned catalog

Status: implemented

## Problem

OpenRouter is a pi-ai catalog route, so **Fetch available models** answered from the installed registry with no network call. That listing is ids, names, and whatever modalities the pinned pi-ai release recorded. OpenRouter's own `GET /models` discloses `architecture.input_modalities` on every row (text, image, audio, …), `context_length`, and models the catalog has not caught up with. Fetch on the OpenRouter card also often sends no `baseURL` — the composition profile is only `apiKeyEnv` — so even a later "prefer the listing when a URL is shown" rule would still miss.

The visible result: Auto on a hand-added OpenRouter row (`meta/muse-spark-1.3`) inherited `[text]`, while the live listing declares `['text', 'image', 'video', 'file', 'audio']`. Muse Spark never appears in the catalog Fetch picker at all.

## Decision

**OpenRouter skips the catalog short-circuit.** `provider === 'openrouter'`, hostname `openrouter.ai`, or a subdomain of it interrogates `GET {base}/models` and parses `architecture.input_modalities` the way a draft gateway already did. When the form shows no base URL, the catalog provider's `baseUrl` (`https://openrouter.ai/api/v1`) is the endpoint. Other catalog routes (OpenAI, Anthropic, DeepSeek, …) still answer from the registry: their listings disclose ids only, and the catalog's windows and modalities are the better answer.

**The listing is the candidate source, not a catalog refresh.** Adoption still writes `settings.yaml`. A listing-declared `input` of `[text, image]` (video/file dropped; audio becomes the STT chip) is stored for a newly adopted row. An existing row keeps its stored declaration, including Auto.

`top_provider.max_completion_tokens` is read as `maxTokens` when the listing omits `max_output_tokens`.

## Alternatives considered

- **Keep answering OpenRouter from the catalog** — the catalog is weeks behind OpenRouter's lineup and does not carry Muse Spark or current vision flags. Fetch then cannot do the job the control names.
- **Skip the catalog short-circuit whenever a baseURL is set, for every catalog route** — OpenAI and DeepSeek listings omit modalities and windows the catalog has; Fetch would get worse metadata. OpenRouter is the listing that is strictly more informative.
- **Require the form to show a baseURL** — the OpenRouter card's composition profile has none, so Fetch would keep hitting the catalog. Filling the catalog provider endpoint internally matches what the card already implies.
- **Probe OpenRouter at `resolveModelInfo`** — remains rejected: admission reads recorded declarations; Fetch is the query.

## Consequences

Fetch on OpenRouter returns the live catalog (hundreds of rows) with vision/STT chips from `architecture`. Adopting `meta/muse-spark-1.3` stores `[text, image]`. A saved row whose id does not match the live spelling (`muse-spark-1.3-contributor` vs `meta/muse-spark-1.3-contributor`) is a different model; Fetch will not rewrite it.

Other catalog providers are unchanged. A 401 on the live listing now surfaces as a Fetch error on OpenRouter instead of a silent catalog answer — the stored key must be valid for the probe, which is the same credential the route already needs to chat.

## Testing

`packages/llm/llm-pi-ai/tests/discovery.spec.ts` covers an `openrouter` route hitting the mock listing (not `getBuiltinModels('openrouter')`), mapping image+audio and `top_provider.max_completion_tokens`, defaulting `https://openrouter.ai/api/v1/models` when the form omits a base URL, and recognizing an `*.openrouter.ai` hostname on a non-catalog provider id. `tests/any-api.e2e.ts` pins live `meta/muse-spark-1.3` as `[text, image]` with `audioInput` and `moonshotai/kimi-k2-thinking` as `[text]` when `OPENROUTER_API_KEY` is set. DeepSeek Fetch still makes no network call.

## Related

- [Ollama discovery reads `/api/show` for vision and context, instead of inheriting text-only](2026-09-10-ollama-show-discovery-capabilities.md) — the other live-capability probe; OpenRouter's answer is already on `GET /models`.
- [Discovered input modalities surface in the models UI, and undeclared still means undeclared](2026-08-22-discovered-model-input-modalities.md) — OpenRouter `architecture` parsing this change finally reaches from the OpenRouter card.
