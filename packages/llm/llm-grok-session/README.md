# @shres-code/shres-code-llm-grok-session

Grok subscription-session adapter for the LLM seam. Registers one provider route, `grok-session`, that serves `https://cli-chat-proxy.grok.com/v1` over the `openai-responses` wire with the credential the [Grok Build CLI](https://docs.x.ai/build/overview) stores for its own `grok login`: the transport, streaming, tool, reasoning, and replay machinery are the shared [`shres-code-llm-pi-ai`](../llm-pi-ai/README.md) adapter, and this package owns only the credential — read from `~/.grok/auth.json`, refreshed through the issuer's `refresh_token` grant when it reaches the configured leeway, and written back so the CLI keeps working.

Using the route bills the CLI's subscription (SuperGrok tiers), not the X API; no `XAI_API_KEY` is involved. The delegated `grok-cli` route in [`shres-code-llm-cli-bridge`](../llm-cli-bridge/README.md) is the spawn-based alternative: it runs the CLI binary, so the CLI's own tools bypass harness approval, while this route is an ordinary HTTP adapter under harness control.

## Session credential

The session document is `~/.grok/auth.json` (configurable `authPath`), written by `grok login` (OIDC authorization-code + PKCE, or `--device-auth`). This adapter reads the newest `https://auth.x.ai::<client-id>` entry, serves its access token while it is valid, and at the refresh leeway runs one `refresh_token` grant against `https://auth.x.ai/oauth2/token`, persisting the rotated `key` / `refresh_token` / `expires_at` back into the same entry atomically at owner-only mode. Concurrent callers share one in-flight resolve, and a sibling process that refreshes the same document — the CLI itself — wins: its fresher token is adopted instead of overwritten, on both grant success and failure.

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
| `cliVersion` | `1.0.13` | CLI version the route advertises (`user-agent` and `x-grok-cli-version`); the proxy rejects version-less clients with 426 and floors the reported version, so a proxy floor bump is a settings entry. |

## Model Experience

### Subscription chat request

#### What the model sees

The standard harness conversation: system text, ordered messages, harness tool schemas mapped to Responses function tools, and the selected reasoning effort. Nothing about the session document, the CLI, or the harness transport reaches the request beyond the bearer credential.

#### Token effect

Usage chunks carry the proxy's reported input/output/reasoning token counts; the request default for output tokens follows the model entry's `maxTokens` when one is configured.

#### KV Cache effect

Provider-side. The proxy reports cached input inside its usage when it serves a cache hit; this adapter passes those counts through as `cacheReadTokens` unchanged.

## Known Limitations and Deferred Work

- **Unofficial wire** — `auth.json`'s format, the proxy's paths, and the CLI's client id are the Grok Build CLI's implementation details, not a published contract; a CLI self-update can change them, and this package pins no client id (the credential's own is echoed at refresh).
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the document; this adapter adopts its token rather than clobbering it, matching the CLI's own refresher.
- **Billing follows the subscription** — usage on this route consumes SuperGrok quota and reports the proxy's cost figures; it is not metered by the X API.
- **No silent first-run onboarding** — `providerUsable` treats the live route as usable, so the Models CLI shows it active without a login; the failure arrives at first use by design (fail loud at the earliest resolvable point).
