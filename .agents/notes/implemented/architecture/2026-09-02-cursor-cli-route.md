# Agent Note: Cursor subscription route (cursor-cli) and the native-adapter deferral

Status: implemented

## Problem

Cursor subscriptions (Pro / Pro+ / Business) were unreachable from shres-code: no HTTP route speaks Cursor's backend, and no delegated route runs the Cursor Agent CLI. The Grok subscription had grown a two-step story — the [`grok-cli`](../../implemented/architecture/2026-08-16-cli-agent-bridges.md) delegated route first, then the native [`grok-session`](2026-08-30-grok-session-provider.md) HTTP provider once the wire proved it could serve the whole seam. The user asked for the same for Cursor, with the facts brute-forced out of the Cursor binary rather than assumed from community proxies.

## Decision

Ship the first step now: a fifth `llm-cli-bridge` route, `cursor-cli`, that spawns `cursor-agent -p --output-format json --force --model <model> <prompt>`. The prompt is the trailing positional (`-p` is cursor-agent's print flag, not a prompt flag), the route advertises no reasoning efforts (the CLI has no effort flag; requesting one fails `UNSUPPORTED_OPTION`), and parse mode is `json` because `--print --output-format json` emits exactly one `{type:"result", subtype:"success", is_error:false, duration_ms, result, session_id, request_id?}` line, which the shared answer extractor reads through its `result` field. Use bills the CLI's `cursor-agent login` session (the Cursor subscription); an optional `CURSOR_API_KEY` stored through the credentials seam overrides it with pay-as-you-go.

Verified against the installed artifacts before implementation (Cursor.app 3.18.9 and the official cursor-agent CLI 2025.09.18-7ae6800 bundle, static analysis only, no credential values handled):

- **Credential store.** darwin keeps the session in the login keychain (services `cursor-access-token` / `cursor-refresh-token` / `cursor-api-key`, account `cursor-user`, via `/usr/bin/security`); other platforms keep `~/.cursor/auth.json` with `{accessToken, refreshToken, apiKey}`. The access token is a JWT served while `exp − now ≥ 300 s`.
- **Login.** PKCE device flow: open `https://cursor.com/loginDeepControl?challenge=<sha256(verifier)>&uuid=<uuid>&mode=login&redirectTarget=cli`, then poll `GET https://api2.cursor.sh/auth/poll?uuid&verifier` until it answers `{accessToken, refreshToken}`. An API key exchanges at `POST https://api2.cursor.sh/auth/exchange_user_api_key`.
- **Refresh.** This CLI version performs no refresh-token grant. The desktop does: `POST https://api2.cursor.sh/oauth/token`, JSON body `{grant_type:"refresh_token", client_id:"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token}`, response `{access_token, shouldLogout?, error?}` — access token only, no refresh-token rotation.
- **Model wire.** connect-RPC protobuf only; no OpenAI-compatible REST exists anywhere in the bundle. Classic chat is `aiserver.v1.AiService/StreamChat` (request `GetChatRequest` with `conversation[]` of `{type: HUMAN|AI, text}` plus `model_details`; response `StreamChatResponse` streaming `text` deltas). The CLI's agent loop instead speaks `agent.v1.AgentService` (Run / RunSSE), a server-driven agent protocol. CLI request headers are `authorization: Bearer`, `x-ghost-mode`, `x-cursor-client-version: cli-<version>`, `x-request-id`; the `x-cursor-checksum` the desktop sends is IDE-only (a timestamp-mixed machine-id digest) and absent from the CLI.

## Alternatives considered

**A native `llm-cursor-session` HTTP provider mirroring grok-session.** Rejected on wire honesty: `StreamChat`'s request carries no client tool schemas (tools are Cursor-side "capabilities") and its response carries no tool calls, finish reason, or usage — the route could stream text but could not serve the conversation loop or report usage, which is below the bar grok-session set. The `agent.v1.AgentService` protocol swaps that mismatch for a worse one: the remote side drives tools, which is delegated semantics over HTTP, not an LLM seam. Revisit if Cursor ships a function-calling wire; the refresh grant above means a future `cursor-credential` service (mirror of [`grok-credential`](2026-08-31-grok-credential-service.md)) has a real rotation path when that day comes.

**Ship `cursor-credential` now alongside the route.** Deferred: the credential seam requires a consumer; a service with only future consumers is an incomplete seam. The delegated route reads nothing itself — `cursor-agent` owns its credential — so there is nothing for the service to serve today.

**Community proxy endpoints (cursor2api-style OpenAI shims).** Rejected: they are third-party reimplementations, not the product's wire; every fact above is derived from the installed binaries.

## Consequences

`cursor-cli` is dormant-by-environment like its siblings: the route always lists, and a spawn fails loud when `cursor-agent` is missing or signed out — `cursor-agent login` is the recovery step the error surfaces. The advisory model list (`gpt-5`, `sonnet-4`) tracks the CLI's own `--help` examples; a deployment overrides `models` through the settings section rather than a code change. The e2e gates on `cursor-agent status` reporting `Logged in` because that CLI exits 0 even while signed out. The binary-derived facts above are the starting point for any future native provider; they are implementation details of Cursor's app and CLI, not a published contract, and a Cursor update can move any of them.
