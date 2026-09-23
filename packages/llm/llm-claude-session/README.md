# @shres-code/shres-code-llm-claude-session

Claude subscription-session adapter for the LLM seam. Registers one provider route, `claude-session`, that serves api.anthropic.com's `/v1/messages` over the `anthropic-messages` wire with the credential the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) stores for its own sign-in: the transport, streaming, tool, reasoning, and replay machinery are the shared [`shres-code-llm-pi-ai`](../llm-pi-ai/README.md) adapter, and this package owns only the credential — read from the macOS login keychain's `Claude Code-credentials` item or `~/.claude/.credentials.json`, refreshed through console.anthropic.com's `refresh_token` grant when it reaches the configured leeway, and written back so the CLI keeps working.

Using the route bills the Claude subscription the CLI is signed in to (Pro / Max), not the Anthropic API; no `ANTHROPIC_API_KEY` is involved. A delegated `claude-code` CLI route would be the spawn-based alternative — it runs the CLI binary, so the CLI's own tools bypass harness approval, while this route is an ordinary HTTP adapter under harness control; [`shres-code-subagent-claude-code`](../../subagent/subagent-claude-code/README.md) already spawns that binary for subagents.

## Session credential

The credential document is one JSON object whose `claudeAiOauth` member holds the subscription login (`accessToken`, `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`); the CLI's `mcpOAuth` member beside it is preserved verbatim across every rotation. The source is the macOS login keychain's `Claude Code-credentials` item by default on macOS and the `~/.claude/.credentials.json` file elsewhere, matching the CLI's own split; `useKeychain`, `securityPath`, `keychainAccount`, and `authPath` override that. This adapter serves the stored access token while `expiresAt` is more than `refreshLeewayMs` away, and otherwise runs one `refresh_token` grant against `https://console.anthropic.com/v1/oauth/token` (JSON body: the CLI's own OAuth client id, `grant_type=refresh_token`, the refresh token), persisting the rotated access and refresh tokens back into the same document at owner-only mode. Concurrent callers share one in-flight resolve, and a sibling process that refreshes the same store — the CLI itself — wins: its fresher session is adopted instead of overwritten, on both grant success and failure.

`expiresAt: 0` states that the store holds no access token yet rather than that no credential exists, so it refreshes immediately instead of failing; a `refreshTokenExpiresAt` already in the past likewise refuses the grant up front (after the same sibling-adoption re-read, so a login the CLI performed since is still adopted) instead of spending a single-use refresh token on a doomed request. Only an absent or unparseable store, a missing `claudeAiOauth` member, or a missing refresh token is `MISSING_CREDENTIAL`.

The credential engine itself — reading and selecting the session, running the refresh grant, and persisting rotations — is shared, not owned here. It lives in [`@shres-code/shres-code-claude-credential`](../claude-credential/README.md) and is exposed as the `ctx.claudeCredential` service: this adapter resolves one single-flight manager per credential spec through `managerFor(spec)` when the service is mounted. The credential fields stay in this adapter's settings section.

Without a signed-in login the route still lists and can be selected; the first request fails loud with `MISSING_CREDENTIAL` and a message naming the `claude` sign-in and its `/login` step. A failed refresh after the stored token expired is `AUTH_REFRESH_FAILED`, with the same recovery step. Diagnostics never quote credential values.

## Configuration

The optional `llm-claude-session` settings section overlays the composition entry (the whole section is the one route's profile):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the directory entry but withdraws the live route. |
| `authPath` | `~/.claude/.credentials.json` | Credential document read where the login keychain is not. |
| `securityPath` | `/usr/bin/security` | macOS security tool the keychain source reads and writes through. |
| `keychainAccount` | the OS user name | Keychain account a rotation writes its item under. Reads do not filter by account. |
| `useKeychain` | `true` on macOS, `false` elsewhere | Read the login keychain instead of the credential document. |
| `baseURL` | `https://api.anthropic.com` | Endpoint base; the vendor SDK appends `/v1/messages`. |
| `displayName` | `Claude (subscription)` | Selector label. |
| `models` | `claude-opus-5`, `claude-sonnet-5` (both `text`+`image`, 1,000,000 context, 128,000 output; efforts `off`/`low`/`medium`/`high`/`xhigh`/`max`) | Catalog; a new release is a settings entry, not a code change. |
| `refreshLeewayMs` | `300000` | Refresh when the token is at or within this distance of expiry. |

The section declares no `headers` field: pi-ai builds the OAuth request's header set (the `claude-code` and `oauth` betas, the pinned CLI user-agent, `x-app`) and merges configured headers over it later-wins, so a route header would replace the beta set the subscription login needs rather than add to it.

An Opus 5.5 release ships as a settings `models` entry carrying the published capacities and `compat: { forceAdaptiveThinking: true }` once its model id is confirmed against the served catalog; the shipped list holds the two ids the installed CLI and pi-ai's catalog both name today.

## Model Experience

### Subscription chat request

#### What the model sees

The standard harness conversation — system prompt, ordered messages, harness tool schemas, and the selected reasoning effort — plus one fixed request member the OAuth bearer adds: pi-ai prepends the Claude Code identity block as `system[0]` ahead of the harness system prompt whenever the credential is an OAuth token (`sk-ant-oat`). The route cannot suppress, reorder, or reword it.

##### Claude Code identity block

```markdown
You are Claude Code, Anthropic's official CLI for Claude.
```

#### Token effect

Usage chunks carry Anthropic's reported input/output counts, with thinking tokens folded into the output count by pi-ai, and the cache-creation/cache-read counts as reported. Each shipped model declares 128,000 output tokens, which a configured entry can change through `maxTokens` (it also becomes that model's per-request default); both shipped models declare `input: ['text', 'image']`, which admits image blocks (vision).

#### KV Cache effect

Provider-side. Anthropic reports prompt-cache hits and writes inside its usage, and this adapter passes those counts through as `cacheReadTokens` / `cacheWriteTokens` unchanged; the adapter sends no cache controls of its own, so whether a prefix is cached and how long it lives remain the provider's and pi-ai's decisions.

## Known Limitations and Deferred Work

- **Unofficial wire** — the keychain service name (`Claude Code-credentials`), the `claudeAiOauth` document fields, the `claude-code-20250219` / `oauth-2025-04-20` beta set, and the identity system block are the CLI's implementation details, not a published contract; a CLI update can change them, and the failure at request time names the sign-in step.
- **Harness attribution replaces pi-ai's CLI user-agent** — the beta set and `x-app: cli` reach the subscription endpoint, but the `User-Agent` header is Harness app attribution on every provider request ([mandatory attribution](../../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md)), applied through pi-ai's later-wins options merge over the `claude-cli/2.1.75` value pi-ai pins for OAuth requests. Whether the endpoint accepts the harness identity is unverified; correcting it is a decision about attribution versus CLI identity in `shres-code-llm-pi-ai` or pi-ai, not a route setting. A new required beta or a server-side floor bump is likewise a pi-ai upgrade.
- **`?beta=true` unverified** — the Anthropic SDK builds `baseURL + /v1/messages` with no query string, and no query can be smuggled through `baseURL` or headers; if the subscription endpoint turns out to require it, the fix belongs upstream in pi-ai.
- **Thinking-disabled acceptance unverified** — an effort of `off` sends `thinking: {type: "disabled"}` on these adaptive-thinking models; that the subscription endpoint accepts the explicit disabled mode (as the shipped catalog's absence of an `off` pin implies) awaits a live request.
- **`expires_at` unit assumed** — the grant parser reads `expires_at` as epoch milliseconds, matching the store's own convention, and falls back to `expires_in` seconds; a live rotation that states the other unit would persist a wrong expiry.
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the store; this adapter adopts its session rather than clobbering it. The refresh token is single-use, so a grant this process already started cannot be un-spent.
- **Keychain account mismatch** — a rotation writes its item under the configured `keychainAccount` (the OS user name by default); a CLI whose item lives under a different account keeps its own value, which `keychainAccount` corrects.
- **No silent first-run onboarding** — the route is usable without a login in the Models picker; the failure arrives at first use by design (fail loud at the earliest resolvable point).
