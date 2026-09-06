# Agent Note: Codex subscription-session provider

Status: implemented

## Problem

The Codex subscription (ChatGPT Plus / Pro / Max 20x plans) was reachable from shres-code only through the CLI process: the `codex-cli` delegated route in `llm-cli-bridge` (spawn `codex exec --json`, the CLI's own tools outside harness approval) and the `subagent-codex` backend. There was no HTTP adapter that bills the subscription the way the CLI does. The user asked for the grok story's second step for Codex: a native route over the ChatGPT backend with the CLI's own login credential.

## Decision

Two packages mirroring the [`grok-credential`](2026-08-31-grok-credential-service.md) + [`llm-grok-session`](2026-08-30-grok-session-provider.md) split, with every wire fact verified live or pinned from the CLI's source before implementation (2026-09-06, codex-cli 0.153.4, secrets never quoted):

- **Credential.** `codex login` writes a flat document at `~/.codex/auth.json`: `{ OPENAI_API_KEY: null, auth_mode: "chatgpt", last_refresh, tokens: { access_token, refresh_token, account_id, id_token } }` (issuer `https://auth.openai.com`, client `app_EMoamEEZ73f0CkXaXp7hrann`, ~10-day access tokens whose JWT `exp` is the only expiry statement; an API-key login sets `OPENAI_API_KEY` and is refused with the `codex login` recovery step). `CodexSessionManager.current()` resolves the bearer token and the account id **together** — the backend routes the subscription by the `chatgpt-account-id` header, so the credential and the header must name the same login — refreshes single-flight through the issuer's JSON `refresh_token` grant (`POST /oauth/token`, `{client_id, grant_type, refresh_token}`, response `{id_token?, access_token?, refresh_token?}`, pinned from the CLI's `request_chatgpt_token_refresh`), and persists rotations back atomically at 0600, adopting a sibling's (the CLI's) fresher rotation instead of overwriting it.
- **Transport.** `POST https://chatgpt.com/backend-api/codex/responses` with `authorization: Bearer`, `chatgpt-account-id`, `openai-beta: responses=experimental`, and `originator: codex_cli_rs` serves a standard Responses SSE stream with usage — verified live outside the CLI process, including image input on both shipped models and the `x-codex-plan-type`/rate headers that confirm subscription billing. The plugin therefore reuses `shres-code-llm-pi-ai`'s `openai-responses` route verbatim; only the credential and the account header are novel. No models-list endpoint exists (`GET .../models` answers 400), so the catalog is static: `gpt-6-astra` and `gpt-5.6-luna` (the machine's CLI default and subagent default), efforts `low`/`medium`/`high`/`xhigh`/`max` (the backend rejects `minimal`; its own error names `none/low/medium/high/xhigh/max`, and an omitted `reasoning` is the off mode).
- **Account header plumbing.** The account id rides the profile headers, which pi-ai builds per request from the profile object; the adapter seeds it from the document at mount (a non-validating `peekAccountId()`) and every credential resolve updates it, so a re-login to a different account heals on the following request.
- **Ship posture.** Mounted in the base bundle beside `llm-cli-bridge`, enabled and dormant: selection works without a login, the first request fails loud with `MISSING_CREDENTIAL` naming `codex login`. `shres models set codex-session <model> --effort <level>` works through the same directory entries as every other route.

## Alternatives considered

**Extract a generic "CLI OAuth session" engine shared with grok-credential.** Rejected: the two documents share no shape (keyed issuer entries vs one flat `tokens` object), no grant encoding (form-urlencoded vs JSON), and no account-header concept; the genuine symmetry is the single-flight/adopt/persist pattern, which is mirrored deliberately (lifecycle boilerplate carries jscpd markers; the engine bodies stay unmarked so drift stays visible) rather than parameterized.

**Reuse the `codex-cli` delegated route only.** Rejected for the same reason grok grew a native route: no streaming into the harness loop, one-shot prompts, CLI tools outside approval. The delegated route remains the right choice when the CLI's own agentic behavior is what a task needs.

**Serve the credential through the credentials seam.** Rejected as it was for grok: the seam has no refresh semantics, and a static key cannot stay signed in past the token's life.

## Consequences

The session document and the backend wire are the Codex CLI's implementation details, not a published contract; a CLI self-update can move them, and the request-time error names `codex login` or the failing endpoint. The backend rejects `max_output_tokens` outright (400 "Unsupported parameter"), so the route strips it through the shared adapter's payload hook and output caps are backend-owned — the one deviation from a stock pi-ai Responses body. Usage bills the account's Codex quota (the `x-codex-*` rate headers) and does not touch OpenAI API credits; the route does not yet surface those limits to the UI. Hosted web search — the backend serves provider-executed search the CLI itself uses — stays deferred until a stated need, following the grok route's sequencing. The `api/remotes` cold-tree `tsc` bootstrap failure observed during verification is pre-existing on master (typert-generated types missing until `tsdown` runs) and unrelated to this change.
