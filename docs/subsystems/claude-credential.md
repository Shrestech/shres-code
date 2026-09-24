# Claude Subscription Credential

`@shres-code/shres-code-claude-credential` owns the one Claude subscription credential: it reads the credential the Claude Code CLI's sign-in stored — the macOS login keychain's `Claude Code-credentials` item by default on macOS, `~/.claude/.credentials.json` elsewhere — serves the `claudeAiOauth` access token while `expiresAt` is valid, refreshes through `https://console.anthropic.com/v1/oauth/token`'s `refresh_token` grant at the configured leeway, and persists rotated tokens back into the stored document at owner-only mode, so the CLI and every harness consumer keep working from one credential. An `expiresAt` of zero states that the store holds no access token, and a `refreshTokenExpiresAt` already past refuses a doomed grant; neither is treated as a missing credential.

`ctx.claudeCredential.managerFor(spec)` returns the one single-flight manager memoized per credential spec (keychain/file source, security path, credential path, keychain account, refresh leeway), so one shared source is never raced by concurrent consumers and is rotated once. The `ClaudeSessionManager` engine and the `ClaudeSessionEntry` / `ClaudeSessionOptions` / `ClaudeSessionToken` types are documented in the package [`README`](../../packages/llm/claude-credential/README.md); their exact behavior is pinned by `packages/llm/claude-credential/tests/session.spec.ts`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclaudecredential--claudecredential"></a>

### `ctx.claudeCredential` — `ClaudeCredential`

Single-flight Claude session-credential service.

ClaudeCredential.managerFor returns the one ClaudeSessionManager memoized for a credential spec, preserving one shared in-flight resolve per source. The memoization caches every spec key for the service's lifetime; that is safe because each `current()` call re-reads the store and re-checks freshness at the moment it runs rather than trusting a cached token.

```ts cordis-catalog
/**
 * Resolve the credential manager for one spec, sharing the cached instance
 * across callers so concurrent requests refresh the store once.
 * @param spec - the credential spec this manager reads and refreshes.
 * @returns the manager for the spec's credential facts.
 */
managerFor(spec: ClaudeSessionOptions): ClaudeSessionManager
```

Source: [`packages/llm/claude-credential/src/index.ts:64`](../../packages/llm/claude-credential/src/index.ts)
<!-- END GENERATED cordis-surface -->
