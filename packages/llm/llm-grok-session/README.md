# @shres-code/shres-code-llm-grok-session

Grok subscription-session adapter for the LLM seam. Registers one provider route, `grok-session`, that serves `https://cli-chat-proxy.grok.com/v1` over the `openai-responses` wire with the credential the [Grok Build CLI](https://docs.x.ai/build/overview) stores for its own `grok login`: the transport, streaming, tool, reasoning, and replay machinery are the shared [`shres-code-llm-pi-ai`](../llm-pi-ai/README.md) adapter, and this package owns only the credential — read from `~/.grok/auth.json`, refreshed through the issuer's `refresh_token` grant when it reaches the configured leeway, and written back so the CLI keeps working.

Using the route bills the CLI's subscription (SuperGrok tiers), not the X API; no `XAI_API_KEY` is involved. The delegated `grok-cli` route in [`shres-code-llm-cli-bridge`](../llm-cli-bridge/README.md) is the spawn-based alternative: it runs the CLI binary, so the CLI's own tools bypass harness approval, while this route is an ordinary HTTP adapter under harness control.

## Session credential

The session document is `~/.grok/auth.json` (configurable `authPath`), written by `grok login` (OIDC authorization-code + PKCE, or `--device-auth`). This adapter reads the newest `https://auth.x.ai::<client-id>` entry, serves its access token while it is valid, and at the refresh leeway runs one `refresh_token` grant against `https://auth.x.ai/oauth2/token`, persisting the rotated `key` / `refresh_token` / `expires_at` back into the same entry atomically at owner-only mode. Concurrent callers share one in-flight resolve, and a sibling process that refreshes the same document — the CLI itself — wins: its fresher token is adopted instead of overwritten, on both grant success and failure.
The credential engine itself — reading and selecting the document entry, running the refresh grant, and persisting rotations — is shared, not owned here. It lives in [`@shres-code/shres-code-grok-credential`](../grok-credential/README.md) and is exposed as the `ctx.grokCredential` service: this adapter resolves one single-flight manager per credential spec through `managerFor(spec)` when the service is mounted, so a future consumer (such as image generation) uses the same token engine and the same in-flight refresh against the same document. The credential fields (`authPath`, `refreshLeewayMs`) stay in this adapter's settings section.

Without a signed-in login the route still lists and can be selected; the first request fails loud with `MISSING_CREDENTIAL` and a message naming `grok login`. A failed refresh after the document expired is `AUTH_REFRESH_FAILED`, again naming `grok login`. Diagnostics never quote credential values.

## Configuration

The optional `llm-grok-session` settings section overlays the composition entry (the whole section is the one route's profile):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the directory entry but withdraws the live route. |
| `authPath` | `~/.grok/auth.json` | Session document this adapter reads and refreshes. |
| `baseURL` | `https://cli-chat-proxy.grok.com/v1` | Endpoint base; the proxy serves versioned paths. |
| `displayName` | `Grok (subscription)` | Selector label. |
| `models` | `grok-4.6`, `grok-4.5` (500k context, `low`/`medium`/`high`/`xhigh`) | Catalog; a new proxy release is a settings entry, not a code change. |
| `refreshLeewayMs` | `300000` | Refresh when the token is at or within this distance of expiry. |
| `cliVersion` | `1.0.13` | CLI version the route advertises via `x-grok-client-version` (sent with `X-XAI-Token-Auth: xai-grok-cli` and `x-grok-client-identifier: grok-shell`, the header set the proxy's 426 gate requires); a proxy floor bump is a settings entry. |
| `hostedWebSearch` | `false` | Serve web search as a hosted backend tool instead of the local `tool-web` tool. While on, the colliding local `web_search` function tool is dropped from the request for this route (hosted wins). |
| `hostedXSearch` | `false` | Serve X (Twitter) search as a hosted backend tool. |

## Model Experience

### Subscription chat request

#### What the model sees

The standard harness conversation: system text, ordered messages, harness tool schemas mapped to Responses function tools, and the selected reasoning effort. Nothing about the session document, the CLI, or the harness transport reaches the request beyond the bearer credential.

#### Token effect

Usage chunks carry the proxy's reported input/output/reasoning token counts; the request default for output tokens follows the model entry's `maxTokens` when one is configured. Both shipped models declare `input: ['text', 'image']`, which admits image blocks (vision); a deployment can narrow a model entry's `input` list through the settings section.

#### KV Cache effect

Provider-side. The proxy reports cached input inside its usage when it serves a cache hit; this adapter passes those counts through as `cacheReadTokens` unchanged.

## Hosted search

The route can present web search and X (Twitter) search as hosted backend tools - the provider
(the Grok proxy) executes the search on the model's behalf - instead of asking a harness tool to
run it. Both switches default off.

When a switch is on, the matching Responses tool entry is spliced into the outgoing request's
tools array through the shared adapter's payload hook, mirroring the declarations the Grok Build
CLI itself sends: {"type": "web_search"} and {"type": "x_search"}. Because the names collide with a
harness-local tool-web web_search, hosted wins: while hosted web search is on, the local
web_search function tool is dropped from the request so the model can reach only the backend tool;
a local tool registered for other names is unaffected. A local function tool also named x_search
stays in the request while hostedXSearch is on, and its model-invoked calls are promoted to
server-tool-call and never execute locally. The hosted x_search invocation is promoted
to a server-tool-call content block in the stream, so the agent loop logs it but never dispatches
it as a local tool; search results ride the assistant text the model writes.

The provider executes the search; this route never runs a local web_search for it.
## Known Limitations and Deferred Work

- **Unofficial wire** — `auth.json`'s format, the proxy's paths, and the CLI's client id are the Grok Build CLI's implementation details, not a published contract; a CLI self-update can change them, and this package pins no client id (the credential's own is echoed at refresh).
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the document; this adapter adopts its token rather than clobbering it, matching the CLI's own refresher.
- **Billing follows the subscription** — usage on this route consumes SuperGrok quota and reports the proxy's cost figures; it is not metered by the X API.
- **No silent first-run onboarding** — `providerUsable` treats the live route as usable, so the Models CLI shows it active without a login; the failure arrives at first use by design (fail loud at the earliest resolvable point).
- **Hosted `web_search_call` items stay invisible** — the pinned pi-ai dependency drops `web_search_call` output items (and the backend's `url_citation` annotations) before the harness sees them and exposes no response-body hook, so this route records neither the search action, its query, nor structured citations while that holds. The model's synthesized answer text still arrives and is logged; X search does surface and is recorded as a `server-tool-call` block. The conversion seam (`webSearchCallToServerToolCall` in `shres-code-llm-pi-ai`) is tested and ready for a pi-ai surface change or a raw-wire read.
