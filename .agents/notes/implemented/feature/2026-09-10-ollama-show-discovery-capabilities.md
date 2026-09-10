# Agent Note: Ollama discovery reads `/api/show` for vision and context, instead of inheriting text-only

Status: implemented

## Problem

Ollama Cloud and a local daemon list models as ids only. `GET /v1/models` and `GET /api/tags` carry no `architecture.input_modalities`, no `capabilities`, and no context window. [Discovered input modalities](2026-08-22-discovered-model-input-modalities.md) therefore adopted Ollama candidates with no `input` key. Resolution then applied route `defaultInput` (`[text]`), the Models page showed **Auto (catalog or route default)**, and image intake refused `read_image` on models whose own `/api/show` lists `vision` — `kimi-k3:cloud`, `gemma4:31b`, `glm-5.3-flash:cloud`, and the rest of the Cloud vision lineup.

That note rejected a per-model `/api/show` probe on the claim that ollama.com listings carry no modality data, so the probe would buy nothing. The listing is still id-only; `/api/show` is a different endpoint and does answer. `POST https://ollama.com/api/show` with `{"model":"kimi-k3:cloud"}` returns `capabilities: ["vision","thinking","completion","tools"]` and `kimi-k3.context_length` without running inference.

## Decision

**After a successful OpenAI-compatible listing, an Ollama origin is enriched from `POST /api/show` per listed id.** The origin qualifies when the provider id starts with `ollama`, the hostname is `ollama.com` (or a subdomain), or the port is `11434`. The native URL is the OpenAI-compatible base with a trailing `/v1` stripped, then `/api/show`. A random gateway is not POSTed there.

**`/api/show` is enrichment, never a second listing.** `capabilities` containing `vision` becomes `input: [text, image]`; any of `completion`, `chat`, `tools`, or `thinking` without `vision` becomes `[text]`; an embedding-only, missing, or unreadable list states no chat answer. `{architecture}.context_length` fills `contextWindow` when the listing omitted one. A listing-declared `input` or window is not overwritten. A miss, a non-2xx, an oversized or non-JSON body, or caller abort while a show is in flight leaves that row as the listing returned it and does **not** fail the interrogation — first-run's 1.5s local probe must still report reachable when `GET /models` succeeded. Show probes run at a fixed concurrency of eight and reuse the listing's bearer token when one was sent.

**The request path stays a resolution over recorded declarations.** `resolveModelInfo` does not call `/api/show`. Fetch is the query; **Auto** remains the absent `input` key (catalog, then route `defaultInput`). Adopting a candidate that is not yet configured stores the show-declared `input`; a row already in the form keeps its stored declaration. `shres models discover --add` writes the same `input` and `contextWindow` fields for a newly appended id.

This supersedes the `/api/show` rejection and the "listing is the only probe" clause of [discovered input modalities](2026-08-22-discovered-model-input-modalities.md). OpenRouter listing parsing, the conservative `[text]` floor, and request-time non-interrogation stay there.

## Alternatives considered

- **Infer vision from the model id** (`*-vl`, `*-vision`, `:cloud`) — a naming convention is not a capability; Cloud ids are not consistently spelled that way, and `/api/show` already answers.
- **Set `defaultInput: [text, image]` on `ollama-cloud`** — over-claims for DeepSeek V4 Flash/Pro, which `/api/show` lists without `vision`, and poisons a session that attaches an image to them.
- **Probe `/api/show` at `resolveModelInfo` / request time** — remains rejected under the discovered-modalities note: admission and selectors read recorded declarations; a live probe on every turn adds latency for the same fact Fetch already stored.
- **Probe every OpenAI-compatible gateway at `/api/show`** — a company gateway would see an unexpected POST. The origin filter confines the extra request to hosts that already identify as Ollama.
- **Treat `/api/show` failure as discovery failure** — would make first-run report local Ollama unreachable whenever enrichment overran its 1.5s timeout after a successful listing.
- **Refresh existing rows' Auto input on re-adopt** — adopting still keeps a configured row, including an absent `input`, so a user-corrected text-only declaration cannot be silently widened. Filling Auto on re-adopt is left unset; the user sets **Input** or deletes the row and re-adopts.

## Consequences

Fetch on `ollama-cloud` or `ollama-local` marks vision models in the candidate picker and stores `input: [text, image]` for a newly adopted row. Text-only Cloud models (`deepseek-v4-flash:cloud`, `gpt-oss:120b`) store `[text]` instead of inheriting a guess. Context windows that `GET /models` omits come from `model_info` when show returns them; max output tokens stay a route default.

An already-saved row with Auto still resolves as text-only until its `input` is written. Show-declared vision is still the endpoint's claim, not a verification: a model listing `vision` whose chat route then rejects images produces the same durable poisoned-session failure the [route-default note](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md) records.

## Testing

`packages/llm/llm-pi-ai/tests/discovery.spec.ts` covers an `ollama*` route mapping vision/text/embedding and `context_length`, forwarding the listing bearer token, skipping `/api/show` on a non-Ollama gateway, recognizing `https://ollama.com/v1` by hostname and port `11434`, keeping a listing-declared `input` over a contradictory show body, surviving 404 and unreadable capabilities, and returning the listing when show enrichment is aborted. `apps/cli/tests/models-cli.spec.ts` pins `--add` persisting a declared `input`. `tests/any-api.e2e.ts` pins live Cloud `kimi-k3` as `[text, image]` and `deepseek-v4-flash*` as `[text]` when `OLLAMA_API_KEY` is set.

## Related

- [OpenRouter Fetch reads the live `/models` listing, not the pinned catalog](2026-09-10-openrouter-live-listing-discovery.md) — OpenRouter's modalities are already on `GET /models`; the catalog short-circuit was the obstacle.
- [Discovered input modalities surface in the models UI, and undeclared still means undeclared](2026-08-22-discovered-model-input-modalities.md) — OpenRouter listing parsing, the Auto control, and the conservative floor this enrichment feeds.
- [A pi-ai model declares its own input modalities, and undeclared means text](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md) — resolution chain and why a wrong image claim is expensive.
