# Agent Note: Grok subscription-session provider

Status: implemented

## Problem

The Grok subscription (SuperGrok tiers) was reachable from shres-code only by spawning the Grok Build CLI (`llm-cli-bridge`'s `grok-cli` route): no streaming, one-shot prompts, and the CLI's own tools outside harness approval. The direct HTTP routes (`llm-pi-ai`'s `xai`, `web-search-attached-cli`'s grok backend) all speak the public X API at `api.x.ai` with `XAI_API_KEY` — a different credential class and a different bill. The user goal: connect to Grok the way the CLI does, without the CLI process and without the X API.

## Decision

A dedicated provider package, `packages/llm/llm-grok-session`, that reuses the CLI's own OIDC session as the credential and the shared pi-ai adapter as the transport:

- **Credential.** `grok login` persists an OIDC session (authorization-code + PKCE, or device-code) in `~/.grok/auth.json`: an `at+jwt` access token (`iss: https://auth.x.ai`, `scope` incl. `grok-cli:access`, `offline_access`; tier claim encodes the subscription level; 6-hour life) plus a `refresh_token`. `GrokSessionManager` serves the access token while valid, refreshes at a configurable leeway through `https://auth.x.ai/oauth2/token` (`grant_type=refresh_token`, echoing the entry's own client id), and writes the rotation back into the same entry atomically at 0600.
- **Sibling courtesy.** The CLI refreshes the same document, so the manager single-flights concurrent resolves and adopts a sibling's fresher token instead of overwriting it — on grant success and failure alike — mirroring the CLI's own `oidc_refresher` ("sibling refreshed, adopting valid disk AT").
- **Transport.** The plugin resolves one hand-declared `openai-responses` route over `https://cli-chat-proxy.grok.com/v1` through `shres-code-llm-pi-ai`'s `resolveProfiles` and registers its `PiAiAdapter` with an injected `resolveApiKey`. Streaming, tools, reasoning efforts (`low`/`medium`/`high`/`xhigh`), usage, and replay all come from the shared adapter; the OpenAI SDK joins the versioned base verbatim, which the live proxy requires (`/responses` without `/v1` is 404).
- **Ship posture.** Mounted in the base bundle next to `llm-cli-bridge`, enabled and dormant: selection works without a login, the first request fails loud with `MISSING_CREDENTIAL` naming `grok login`. `shres models set grok-session <model> --effort <level>` works through the same directory entries as every other route.

Verified live before implementation (2026-08-30, SuperGrok Heavy session, secrets redacted): the stored token alone authenticates `GET /v1/models` (200; `grok-4.6`, `grok-4.5`) and `POST /v1/responses` (200 with completion and usage) from outside the CLI process — bearer only, no client headers required.

## Alternatives considered

**Serve the credential through the credentials seam and ship a plain `llm-pi-ai` route.** Rejected: the seam's local provider layers env/managed-yaml/dotenv and has no refresh semantics; embedding xAI OIDC refresh in the generic local provider would vendor-couple it, and a static key cannot stay signed in for more than the token's 6-hour life.

**Hand-write the Responses transport.** Rejected for the maintained-dependency policy: pi-ai already implements the wire, streaming translation, tool conversion, and replay; only the credential is novel here.

**Speak ACP to `grok agent stdio`.** Rejected: it still requires the CLI process, which is what this provider exists to remove.

## Consequences

The route sends the CLI header set the proxy's 426 gate requires on every request: X-XAI-Token-Auth: xai-grok-cli (validate as a CLI session token), x-grok-client-identifier: grok-shell, and x-grok-client-version with the tracked CLI generation. A user-agent approach is inert twice over - the proxy does not read it, and pi-ai's requestHeaders reserves user-agent for harness attribution; cliVersion is a settings entry for proxy floor bumps.

The session document is the CLI's implementation detail, not a published contract: format drift, a proxy path change, or a header requirement introduced by a CLI self-update can break the route at request time, where the error names `grok login` or the failing endpoint. Refresh races are resolved by adoption, so under concurrent use one side's grant is occasionally spent for nothing — the document still ends up valid for both. Usage on this route bills the subscription (the proxy returns cost figures), not the X API; the [`grok-cli` headless-spike](2026-08-16-grok-cli-headless-spike.md) route remains the right choice when the CLI's own agentic behavior is what a task needs.
