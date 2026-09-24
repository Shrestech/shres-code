# @shres-code/shres-code-llm-codex-session

Codex subscription-session adapter for the LLM seam. Registers one provider route, `codex-session`, that serves the ChatGPT backend's codex endpoint (`https://chatgpt.com/backend-api/codex/responses`) over the `openai-responses` wire with the credential the [Codex CLI](https://developers.openai.com/codex/) stores for its own `codex login`: the transport, streaming, tool, reasoning, and replay machinery are the shared [`shres-code-llm-pi-ai`](../llm-pi-ai/README.md) adapter, and this package owns only the credential — read from `~/.codex/auth.json`, refreshed through the issuer's `refresh_token` grant when it reaches the configured leeway, and written back so the CLI keeps working — plus the `chatgpt-account-id` header the backend routes the subscription by.

Using the route bills the ChatGPT account's Codex subscription (Plus / Pro / Max 20x), not the OpenAI API; no `OPENAI_API_KEY` is involved. The delegated `codex-cli` route in [`shres-code-llm-cli-bridge`](../llm-cli-bridge/README.md) is the spawn-based alternative: it runs the CLI binary, so the CLI's own tools bypass harness approval, while this route is an ordinary HTTP adapter under harness control.

## Session credential

The session document is `~/.codex/auth.json` (configurable `authPath`), written by `codex login` with a ChatGPT account (the CLI's `--with-api-key` login is an API-key document and is refused with the `codex login` recovery step). This adapter serves the `tokens` object's access token while it is valid, and at the refresh leeway runs one `refresh_token` grant against `https://auth.openai.com/oauth/token` (JSON body: the CLI's own OAuth client id, `grant_type=refresh_token`, the refresh token), persisting the rotated `access_token` / `refresh_token` / `id_token` back into the same document atomically at owner-only mode. Concurrent callers share one in-flight resolve, and a sibling process that refreshes the same document — the CLI itself — wins: its fresher session is adopted instead of overwritten, on both grant success and failure.

The credential engine itself — reading and selecting the document session, running the refresh grant, and persisting rotations — is shared, not owned here. It lives in [`@shres-code/shres-code-codex-credential`](../codex-credential/README.md) and is exposed as the `ctx.codexCredential` service: this adapter resolves one single-flight manager per credential spec through `managerFor(spec)` when the service is mounted. The credential fields (`authPath`, `refreshLeewayMs`) stay in this adapter's settings section.

Every request carries the document's `tokens.account_id` as the `chatgpt-account-id` header beside the bearer token, with `originator: codex_cli_rs` and `OpenAI-Beta: responses=experimental` — the header set the backend's subscription wire requires. The account id is seeded from the document at mount and kept current by every credential resolve; a re-login to a different account reaches the header on the following request.

Without a signed-in login the route still lists and can be selected; the first request fails loud with `MISSING_CREDENTIAL` and a message naming `codex login`. A failed refresh after the document expired is `AUTH_REFRESH_FAILED`, again naming `codex login`. Diagnostics never quote credential values.

## Configuration

The optional `llm-codex-session` settings section overlays the composition entry (the whole section is the one route's profile):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the directory entry but withdraws the live route. |
| `authPath` | `~/.codex/auth.json` | Session document this adapter reads and refreshes. |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | Endpoint base; the backend serves unversioned paths. |
| `displayName` | `Codex (subscription)` | Selector label. |
| `models` | `gpt-6-astra`, `gpt-5.6-luna` (both `text`+`image`; `low`/`medium`/`high`/`xhigh`/`max`) | Catalog; a new backend release is a settings entry, not a code change. |
| `refreshLeewayMs` | `300000` | Refresh when the token is at or within this distance of expiry. |

## Model Experience

### Subscription chat request

#### What the model sees

The standard harness conversation: system text, ordered messages, harness tool schemas mapped to Responses function tools, and the selected reasoning effort. Nothing about the session document, the CLI, or the harness transport reaches the request beyond the bearer credential and the account header.

#### Token effect

Usage chunks carry the backend's reported input/output/reasoning token counts. The backend rejects `max_output_tokens` outright ("Unsupported parameter"), so the route strips it from every outgoing body and output caps are backend-owned: a configured model `maxTokens` sizes the model for the harness but never reaches the wire, and a request-level output cap is not enforceable on this route. Both shipped models declare `input: ['text', 'image']`, which admits image blocks (vision); a deployment can narrow a model entry's `input` list through the settings section.

#### KV Cache effect

Provider-side. The backend reports cached input inside its usage, so the route declares `cacheUsage: 'reported'` and every call carries `cacheReadTokens` and `cacheWriteTokens`, a miss as 0.

## Known Limitations and Deferred Work

- **Unofficial wire** — `auth.json`'s format, the backend's paths, and the account header are the Codex CLI's implementation details, not a published contract; a CLI self-update can change them, and the error at request time names `codex login` or the failing endpoint.
- **Refresh races are resolved by adoption, not prevention** — a sibling that refreshes concurrently wins the document; this adapter adopts its session rather than clobbering it, matching the CLI's guarded-reload behavior.
- **Billing follows the subscription** — usage consumes the account's Codex quota (the response's `x-codex-*` headers expose the limits); it is not metered by the OpenAI API. The route does not yet surface those rate-limit headers to the UI.
- **Output caps are backend-owned** — the backend answers 400 "Unsupported parameter: max_output_tokens" for any value, so the route strips the parameter pi-ai derives from the model's size; a request-level output cap cannot be enforced on this wire.
- **No silent first-run onboarding** — the route is usable without a login in the Models picker; the failure arrives at first use by design (fail loud at the earliest resolvable point).
- **Account switches heal one request late** — the account header rides the profile, which is rebuilt when a credential resolve observes a new account id; the request that observes the change itself ran under the profile built before it.
- **Hosted tools stay deferred** — the backend serves provider-executed web search the CLI itself uses; wiring it as a hosted tool (dropping the colliding local tool, as `llm-grok-session` does) waits for a stated need.