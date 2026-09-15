# Agent Note: Cursor subscription session — HTTP route over the cursor-agent login

Status: implemented

## Problem

Cursor, like Codex (ChatGPT) and Grok (SuperGrok), sells a subscription whose CLI login is a usable credential. The codex-session and grok-session adapters serve those subscriptions as ordinary HTTP routes over the CLIs' stored sessions. Cursor had only the delegated `cursor-cli` spawn route. Serving the Cursor subscription the same way required two facts nobody had verified: where `cursor-agent login` stores its credential, and what wire the CLI actually speaks (its documented aiserver chat methods are all deprecated).

## Decision

Two packages, mirroring the codex/grok pairs, with one honest descope.

**`cursor-credential`** is the shared credential engine (`ctx.cursorCredential`). The login lives in the macOS login keychain (services `cursor-access-token` / `cursor-refresh-token`, account `cursor-user`), read through the same `/usr/bin/security` tool the CLI shells out to; a file store (`~/.cursor/auth.json`, `AGENT_CLI_CREDENTIAL_STORE=file`) is the alternative source. The access token is a JWT whose `iss` (`https://authentication.cursor.sh`) does not resolve publicly, so the engine never runs a refresh grant: it serves the token while `exp` holds, re-reads the store on every resolve (adopting the CLI's rotations), and fails loud `AUTH_REFRESH_FAILED` naming `cursor-agent login` on expiry. This is the deliberate deviation from the codex/grok engines, whose issuers are reachable.

**`llm-cursor-session`** registers the `cursor-session` route on `ctx.llm` plus a configurable-provider directory entry (the Models-page card): provider info, `listModels`, and `resolveModel` over the six model ids cursor-agent validated against the live backend (`gpt-5.2`, `claude-4.5-sonnet`, `cursor-grok-4.6-high`, `cursor-grok-4.6-high-fast`, `claude-fable-5-1-thinking-high`, `gemini-3.8-flash-high`), with a settings overlay for catalog updates and an `enabled` switch that withdraws the live route. `stream()` resolves the credential first (login failures surface ahead of the gate), then fails loud `UNSUPPORTED_OPTION` naming the wire and the `cursor-cli` overlay alternative.

## Wire findings (why chat is gated)

The CLI's chat is `agent.v1.AgentService/Run` (BiDi Connect, `application/connect+proto`) on `agentn.global.api5.cursor.sh` — a host and proto namespace invisible to api2-only tracing, found by unfiltered HTTP/2 session logging. The request is a progressive frame sequence: conversation state (turns, selected model as model_id plus option pairs, catalog), a gzip environment-context frame, and reactive ack frames after server checkpoint echoes. Fourteen systematic replays (exact bytes, fresh UUIDs, mirrored headers including `x-blob-encryption-key`, paced/reactive ordering, keepalives, session warm-up, body-level gzip, preserved worker id) all reach `200` plus a checkpoint echo, then idle on heartbeats: the server never processes the environment frame, and the model turn (whose response shape — `interactionUpdate` `text_delta`/`thinking_delta`/`tool_call` frames — is fully decoded and adapter-ready) never starts. The gating behavior is not in the bytes, headers, or ordering we can observe.

## Alternatives considered

**Ship nothing until chat works.** Rejected: the credential engine, catalog serving, and composition are complete and useful now; the gate is upstream and undocumented, and blocking the whole seam on it serves nobody.

**Serve chat through legacy `aiserver.v1.AiService/StreamChat`.** Rejected: the backend answers `ERROR_DEPRECATED` for every legacy shape, with correct `cli-`-prefixed client headers included.

**Refresh the token ourselves like codex/grok.** Rejected: the JWT issuer does not resolve; a grant has no endpoint to post to. Adoption of the CLI's rotation replaces it.

## Consequences

Mounting the bundle exposes `cursor-session` in the Models directory; its directory entry advertises `chatGated: true`, so usability checks do not count the route as servable and model selection refuses it before the gate diagnostic can be reached through the picker ([chat-gated directory fact](../bug-fix/2026-09-15-chat-gated-directory-fact.md)). A chat attempt that still reaches the adapter — a selection stored before the guard — surfaces the gate diagnostic with the recovery step (`cursor-agent login` when the credential is the problem). The shipped delegated `cursor-cli` route was retired with the other CLI routes; a hand-declared `cursor-cli` overlay on `llm-cli-bridge` remains the serving path for Cursor completions. When the handshake is cracked, `stream()` gains the Connect transport against the documented response vocabulary and the catalog moves to live `AvailableModels`; nothing else changes.
