# @shres-code/shres-code-codex-credential

The one Codex subscription-credential engine, exposed as the singleton `ctx.codexCredential` service. It reads the session document the [Codex CLI](https://developers.openai.com/codex/) writes at `~/.codex/auth.json` (`codex login` with a ChatGPT account), serves the `tokens` object's access token while it is valid, refreshes through `https://auth.openai.com/oauth/token`'s `refresh_token` grant at the configured leeway, and persists the rotated `access_token` / `refresh_token` / `id_token` back into the same document at owner-only mode — so the CLI and every harness consumer keep working from one document.

Extracted beside the `grok-credential` engine so any future capability uses the **same** token engine and the same in-flight refresh as subscription chat, instead of each route owning its own credential machinery. No `OPENAI_API_KEY` is read: an API-key login is refused with the `codex login` recovery step.

## Service surface

`ctx.codexCredential` exposes one operation:

- `managerFor(spec): CodexSessionManager` — returns the one manager memoized for a credential spec (`{ authPath, refreshLeewayMs, fetch?, now? }`). Keying is the spec's auth path plus refresh leeway, so callers with the same credential facts share one single-flight refresh per document and concurrent requests never race the issuer with the same (possibly single-use) refresh token. The memoization caches each spec key for the service's lifetime; that is safe because every `current()` call re-validates the document and refresh at the moment it runs rather than trusting stale token state.

`CodexSessionManager.current()` resolves the bearer token and the `account_id` the backend's `chatgpt-account-id` header needs **together**, so the header always names the account the token belongs to; `peekAccountId()` serves the header's seed value before the first resolve without validating anything. `selectSessionEntry`, the `CodexSessionEntry` / `CodexSessionOptions` / `CodexSessionToken` types, and the `OIDC_ISSUER` / `TOKEN_URL` / `CLIENT_ID` constants are re-exported from this package's entry for consumers that need the engine directly.

Credentials never reach diagnostics: a refresh failure names the issuer's error code, and nothing about the credential value is ever quoted. Concurrent writes adopt a sibling's fresher rotation instead of clobbering it.

## Composition

```yaml
- name: '@shres-code/shres-code-codex-credential'
- name: '@shres-code/shres-code-llm-codex-session'
```

The service has no configuration of its own — credential specs come from consumers (the `codex-session` adapter's settings section owns `authPath` and `refreshLeewayMs`). Mounting the plugin provides `ctx.codexCredential`; the `codex-session` adapter re-reads it per request and consumes it when present.

## Model Experience

Indirectly, through the codex-session adapter it serves; the engine itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the adapter and backend own any request-prefix changes.

## Known Limitations and Deferred Work

- **Unofficial wire** — `auth.json`'s format and the backend's paths are the Codex CLI's implementation details, not a published contract; a CLI self-update can change them. The refresh grant's client id is the CLI's own (`app_EMoamEEZ73f0CkXaXp7hrann`), pinned from the CLI's source.
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the document; the manager adopts its session rather than clobbering it, matching the CLI's guarded-reload behavior.
- **Diagnostics carry the `llm-codex-session:` prefix** — the engine names its consumer so the recovery step (`codex login`) stays actionable wherever the error surfaces.
