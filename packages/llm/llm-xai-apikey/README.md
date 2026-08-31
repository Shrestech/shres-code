# @shres-code/shres-code-llm-xai-apikey

Pay-per-token xAI adapter for the LLM seam. Registers one provider route, `xai-apikey`, that serves https://api.x.ai/v1 over the `openai-responses` wire with a key stored through the credentials capability (an environment-variable reference such as `XAI_API_KEY`): the transport, streaming, tool, reasoning, and replay machinery are the shared [`shres-code-llm-pi-ai`](../llm-pi-ai/README.md) adapter, and this package owns only the route config — the endpoint, the model catalog, each model's service tier, and the credential reference resolved per request through the credentials seam.

This is the pay-per-token API path, distinct from the Grok subscription route [`shres-code-llm-grok-session`](../llm-grok-session/README.md): no `~/.grok/auth.json`, no OIDC, and no cli-chat-proxy involvement. Requests here bill the X API by token, and `priority` service tier is billed differently from the default tier.

The route ships **off by default** — it needs an explicit key, so nothing serves until a deployment enables it. Enabling it without a stored key leaves listing and selection working while the first request fails loud with `MISSING_CREDENTIAL`, the same posture as any shipped API-key route whose key was never stored.

## Configuration

The optional `llm-xai-apikey` settings section overlays the composition entry (the whole section is the one route's profile):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Route is off until a deployment turns it on; `true` registers the live route. |
| `apiKeyEnv` | `XAI_API_KEY` | Credential reference resolved per request through the credentials capability. |
| `baseURL` | `https://api.x.ai/v1` | Endpoint base; configurable for a gateway. |
| `displayName` | `xAI (pay-per-token)` | Selector label. |
| `models` | `grok-4.6`, `grok-4.5`, `grok-4.5-mini`, `grok-4.5-vision` | Catalog; a new X API release is a settings entry, not a code change. |
| `models[].serviceTier` | `default` | Per-model service tier: `default` omits `service_tier` (parity with the Grok CLI); `priority` splices `service_tier: "priority"` for priority processing, which lowers TTFT/ITL and is billed differently. |

## Model Experience

### xAI API request

#### What the model sees

The standard harness conversation: system text, ordered messages, harness tool schemas mapped to Responses function tools, and the selected reasoning effort. A model whose `serviceTier` is `priority` also sends `service_tier: "priority"` in the request body; a `default` model sends no service-tier field. Nothing about the API key or the harness transport reaches the request beyond the bearer credential.

#### Token effect

Usage chunks carry the X API's reported input/output/reasoning token counts; the request default for output tokens follows the model entry's `maxTokens` when one is configured.

#### KV Cache effect

Provider-side. The X API reports cached input inside its usage when it serves a cache hit; this adapter passes those counts through as `cacheReadTokens` unchanged.

## Known Limitations and Deferred Work

- **Advisory shipped catalog** — the model list is a snapshot of the X API lineup at shipping time; a newer release is a settings `models` entry, not a code change.
- **Two service tiers only** — the underlying Responses enum accepts `auto` / `default` / `flex` / `scale` / `priority`; this route exposes `default` and `priority` because `auto` is server-side project policy and `flex`/`scale` are a separate pricing track.
- **Pay-per-token billing** — usage on this route is metered by the X API, not by a SuperGrok subscription; `priority` requests are billed differently.
- **No silent first-run onboarding** — the route lists as configurable from the start; the failure arrives at first use by design (fail loud at the earliest resolvable point).
