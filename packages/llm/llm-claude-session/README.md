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
| `models` | `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5` (each `text`+`image`, 1,000,000 context, 128,000 output; efforts `low`/`medium`/`high`/`xhigh`/`max`) | Catalog; a new release is a settings entry, not a code change. |
| `refreshLeewayMs` | `300000` | Refresh when the token is at or within this distance of expiry. |
| `cacheRetention` | `short` | Prompt-cache retention every request asks for: `short` is Anthropic's five-minute ephemeral cache, `long` asks for the one-hour cache, and `none` sends no cache control. The route always states it, so pi-ai's process-wide `PI_CACHE_RETENTION` never applies. Each model declares the matching `promptCacheTtlMs`: `300000`, `3600000`, or `0`. |

The section declares no `headers` field: pi-ai builds the OAuth request's header set (the `claude-code` and `oauth` betas, the pinned CLI user-agent, `x-app`) and merges configured headers over it later-wins, so a route header would replace the beta set the subscription login needs rather than add to it.

`claude-opus-5-5` is the live catalog's "Claude Opus 5.5" (`GET /v1/models`, 2026-09-21). It shares the 5 generation's capacities and, like Opus 5, rejects both a stated temperature and `thinking: {type: "disabled"}`, so its entry carries the same compat and the route does not offer `off`.

## Model Experience

### Subscription chat request

#### What the model sees

The standard harness conversation — system prompt, ordered messages, harness tool schemas, and the selected reasoning effort — plus one fixed request member the OAuth bearer adds: pi-ai prepends the Claude Code identity block as `system[0]` ahead of the harness system prompt whenever the credential is an OAuth token (`sk-ant-oat`). The route cannot suppress, reorder, or reword it.

##### Claude Code identity block

```markdown
You are Claude Code, Anthropic's official CLI for Claude.
```

#### Token effect

Usage chunks carry Anthropic's reported input/output counts, with thinking tokens folded into the output count by pi-ai, and the cache-creation/cache-read counts as reported. Each shipped model declares 128,000 output tokens, which a configured entry can change through `maxTokens` (it also becomes that model's per-request default); every shipped model declares `input: ['text', 'image']`, which admits image blocks (vision).

#### KV Cache effect

Provider-side. pi-ai places up to four Anthropic `cache_control` breakpoints — the Claude Code identity block, the harness system prompt, the last tool, and the final block of the last user message — in the retention `cacheRetention` names: `{type: 'ephemeral'}` for `short`, `{type: 'ephemeral', ttl: '1h'}` for `long`, and no breakpoints for `none`. A cached prefix stays readable for the declared `promptCacheTtlMs`, counted from the start of the request that wrote or last read it; an idle gap longer than that makes the next request re-write the whole prefix. Anthropic reports prompt-cache hits and writes inside every usage block, so the route declares `cacheUsage: 'reported'` and every call carries both `cacheReadTokens` and `cacheWriteTokens`, a miss as 0; the usage chunk carries no split between five-minute and one-hour writes.

## Known Limitations and Deferred Work

- **A return after a routed segment is probed, not tested keylessly** — the opt-in `tests/foreign-return.e2e.ts` (`SHRES_E2E_CLAUDE_FOREIGN_RETURN=1` plus a Claude login) continues a DeepSeek-shaped tool-call segment on `claude-opus-5-5` with reasoning enabled and checks that the request is accepted and the reply thinks; it spends subscription quota, so no default run makes it.
- **Unofficial wire** — the keychain service name (`Claude Code-credentials`), the `claudeAiOauth` document fields, the `claude-code-20250219` / `oauth-2025-04-20` beta set, and the identity system block are the CLI's implementation details, not a published contract; a CLI update can change them, and the failure at request time names the sign-in step.
- **Harness attribution replaces pi-ai's CLI user-agent** — the beta set and `x-app: cli` reach the subscription endpoint, but the `User-Agent` header is Harness app attribution on every provider request, applied through pi-ai's later-wins options merge over the `claude-cli/2.1.75` value pi-ai pins for OAuth requests. A live Opus 5.5 turn was accepted with that harness identity, so no CLI user-agent is required. A new required beta or a server-side floor bump is a pi-ai upgrade.
- **No thinking-off mode** — the live 5.x models reject `thinking: {type: "disabled"}` (the error names adaptive thinking plus `output_config.effort`), so `off` is not offered. A request that names no effort sends no thinking field, which the endpoint accepts; `POST /v1/messages` needs no `?beta=true` query.
- **`expires_at` unit assumed** — the grant parser reads `expires_at` as epoch milliseconds, matching the store's own convention, and falls back to `expires_in` seconds; a live rotation that states the other unit would persist a wrong expiry.
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the store; this adapter adopts its session rather than clobbering it. The refresh token is single-use, so a grant this process already started cannot be un-spent.
- **Keychain account mismatch** — a rotation writes its item under the configured `keychainAccount` (the OS user name by default); a CLI whose item lives under a different account keeps its own value, which `keychainAccount` corrects.
- **One-hour cache on the subscription is unverified** — `cacheRetention: long` sends `ttl: '1h'` (pi-ai gates it on the model's `supportsLongCacheRetention` compat, not on the base URL), but whether the subscription OAuth endpoint honours it has not been measured, so the default stays `short`. The opt-in live probe [`tests/cache-retention.e2e.ts`](tests/cache-retention.e2e.ts) settles it: it runs only with `SHRES_E2E_CLAUDE_CACHE_TTL=1` and a signed-in login, waits six and a half minutes, and spends subscription quota.
- **No silent first-run onboarding** — the route is usable without a login in the Models picker; the failure arrives at first use by design (fail loud at the earliest resolvable point).
