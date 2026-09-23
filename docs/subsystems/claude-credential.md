# Claude Subscription Credential

`@shres-code/shres-code-claude-credential` owns the one Claude subscription credential: it reads the credential the Claude Code CLI's sign-in stored — the macOS login keychain's `Claude Code-credentials` item by default on macOS, `~/.claude/.credentials.json` elsewhere — serves the `claudeAiOauth` access token while `expiresAt` is valid, refreshes through `https://console.anthropic.com/v1/oauth/token`'s `refresh_token` grant at the configured leeway, and persists rotated tokens back into the stored document at owner-only mode, so the CLI and every harness consumer keep working from one credential. An `expiresAt` of zero states that the store holds no access token, and a `refreshTokenExpiresAt` already past refuses a doomed grant; neither is treated as a missing credential.

`ctx.claudeCredential.managerFor(spec)` returns the one single-flight manager memoized per credential spec (keychain/file source, security path, credential path, keychain account, refresh leeway), so one shared source is never raced by concurrent consumers and is rotated once. The `ClaudeSessionManager` engine and the `ClaudeSessionEntry` / `ClaudeSessionOptions` / `ClaudeSessionToken` types are documented in the package [`README`](../../packages/llm/claude-credential/README.md); their exact behavior is pinned by `packages/llm/claude-credential/tests/session.spec.ts`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<!-- END GENERATED cordis-surface -->
