# @shres-code/shres-code-claude-credential

The one Claude subscription-credential engine, exposed as the singleton `ctx.claudeCredential` service. It reads the credential the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) stores for its own sign-in — the macOS login keychain's `Claude Code-credentials` item by default on macOS, `~/.claude/.credentials.json` elsewhere — serves the `claudeAiOauth` access token while `expiresAt` is valid, refreshes through `https://console.anthropic.com/v1/oauth/token`'s `refresh_token` grant at the configured leeway, and persists the rotated access and refresh tokens back into the same document at owner-only mode — so the CLI and every harness consumer keep working from one credential.

Extracted beside the `grok-credential` and `codex-credential` engines so any future capability uses the **same** token engine and the same in-flight refresh as subscription chat, instead of each route owning its own credential machinery. No `ANTHROPIC_API_KEY` is read; the subscription login is the whole credential.

## Service surface

`ctx.claudeCredential` exposes one operation:

- `managerFor(spec): ClaudeSessionManager` — returns the one manager memoized for a credential spec (`{ useKeychain, securityPath, authPath, keychainAccount, refreshLeewayMs, fetch?, now?, readKeychain?, writeKeychain? }`). Keying is those five source facts, so callers with the same facts share one single-flight resolve per source and concurrent requests never race the issuer with the same (possibly single-use) refresh token. The memoization caches each spec key for the service's lifetime; that is safe because every `current()` call re-reads the store and re-checks freshness at the moment it runs rather than trusting a cached token.

`ClaudeSessionManager.current()` resolves the bearer token. `selectSessionEntry`, the `ClaudeSessionEntry` / `ClaudeSessionOptions` / `ClaudeSessionToken` types, and the `TOKEN_URL` / `CLIENT_ID` / `KEYCHAIN_SERVICE` / `DEFAULT_SECURITY_PATH` constants are re-exported from this package's entry for consumers that need the engine directly.

Credentials never reach diagnostics: a refresh failure names the issuer's error code, and nothing about the credential value is ever quoted. Concurrent writes adopt a sibling's fresher rotation instead of clobbering it, and a `refreshTokenExpiresAt` already past refuses the grant up front (single-use tokens cannot be un-spent) after the same adoption re-read, so a login the CLI performed since is still picked up.

## Composition

```yaml
- name: '@shres-code/shres-code-claude-credential'
- name: '@shres-code/shres-code-llm-claude-session'
```

The service has no configuration of its own — credential specs come from consumers (the `claude-session` adapter's settings section owns `authPath`, `useKeychain`, `securityPath`, `keychainAccount`, and `refreshLeewayMs`). Mounting the plugin provides `ctx.claudeCredential`; the `claude-session` adapter re-reads it per request and consumes it when present, falling back to a locally keyed manager otherwise.

## Model Experience

Indirectly, through the claude-session adapter it serves; the engine itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the adapter and pi-ai own any request-prefix changes.

## Known Limitations and Deferred Work

- **Unofficial wire** — the keychain service name (`Claude Code-credentials`), the `claudeAiOauth` document fields (`accessToken` / `refreshToken` / `expiresAt` / `refreshTokenExpiresAt`), and the token endpoint's client id are the Claude Code CLI's implementation details, not a published contract; a CLI self-update can change them, and the error names the `claude` sign-in and its `/login` step.
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the store; the manager adopts its session rather than clobbering it. Because the refresh token is single-use, a grant this process already started cannot be un-spent.
- **The keychain account must match the CLI's** — reads take the service's item without an account filter, while a rotation writes under the configured `keychainAccount` (the OS user name by default); a CLI whose item lives under a different account keeps its own value until `keychainAccount` matches it.
- **Diagnostics carry the `llm-claude-session:` prefix** — the engine names its consumer so the recovery step stays actionable wherever the error surfaces.
