# @shres-code/shres-code-grok-credential

The one Grok Build subscription-credential engine, exposed as the singleton `ctx.grokCredential` service. It reads the session document the [Grok Build CLI](https://docs.x.ai/build/overview) writes at `~/.grok/auth.json` (Grok subscription login, OIDC authorization-code + PKCE, or `--device-auth`), serves the newest `https://auth.x.ai::<client-id>` entry's access token while it is valid, refreshes through the issuer's `refresh_token` grant at the configured leeway, and persists rotated `key` / `refresh_token` / `expires_at` back into the document at owner-only mode — so the CLI and every harness consumer keep working from one document.

Extracted from the `grok-session` HTTP adapter into a shared package so a future capability (image generation) uses the **same** token engine and the same in-flight refresh as subscription chat, instead of each route owning its own credential machinery. No `XAI_API_KEY` is involved and never read.

## Service surface

`ctx.grokCredential` exposes one operation:

- `managerFor(spec): GrokSessionManager` — returns the one manager memoized for a credential spec (`{ authPath, refreshLeewayMs, fetch?, now? }`). Keying is the spec's auth path plus refresh leeway, so callers with the same credential facts share one single-flight refresh per document and concurrent requests never race the issuer with the same (possibly single-use) refresh token. The memoization caches each spec key for the service's lifetime; that is safe because every `accessToken()` call re-validates the document and refresh at the moment it runs rather than trusting stale token state.

`GrokSessionManager`, `selectSessionEntry`, the `GrokSessionEntry` / `GrokSessionOptions` types, and the `OIDC_ISSUER` constant are re-exported from this package's entry for consumers that need the engine directly.

Credentials never reach diagnostics: an entry key names its issuer and client id, a refresh failure names the issuer's error code, and nothing about the credential value is ever quoted. Concurrent writes adopt a sibling's fresher rotation instead of clobbering it.

## Composition

```yaml
- name: '@shres-code/shres-code-grok-credential'
- name: '@shres-code/shres-code-llm-grok-session'
```

The service has no configuration of its own — credential specs come from consumers (the `grok-session` adapter's settings section owns `authPath` and `refreshLeewayMs`). Mounting the plugin provides `ctx.grokCredential`; the `grok-session` adapter re-reads it per request and consumes it when present.

## Model Experience

Indirectly, through the grok-session adapter it serves; the engine itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the adapter and proxy own any request-prefix changes.

## Known Limitations and Deferred Work

- **Unofficial wire** — `auth.json`'s format, the proxy's paths, and the CLI's client id are the Grok Build CLI's implementation details, not a published contract; a CLI self-update can change them, and the engine pins no client id (the credential's own is echoed at refresh).
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the document; the manager adopts its token rather than clobbering it, matching the CLI's own refresher.
- **Diagnostics keep the legacy `llm-grok-session:` prefix** — the moved engine preserves its original error text verbatim; a future rename can reword it for the shared role.
