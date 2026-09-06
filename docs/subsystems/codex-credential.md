# Codex Subscription Credential

`@shres-code/shres-code-codex-credential` owns the one Codex subscription credential: it reads the Codex CLI's ChatGPT-login document at `~/.codex/auth.json`, serves the `tokens` object's access token while valid (with the `account_id` the backend's routing header needs), refreshes through `https://auth.openai.com/oauth/token`'s `refresh_token` grant at the configured leeway, and persists rotated `access_token` / `refresh_token` / `id_token` back into the document at owner-only mode — so the CLI and every harness consumer keep working from one document.

`ctx.codexCredential.managerFor(spec)` returns the one single-flight manager memoized per credential spec (auth path + refresh leeway), so a shared document is never raced by concurrent consumers and rotated once. The `CodexSessionManager` engine and the `CodexSessionEntry` / `CodexSessionOptions` / `CodexSessionToken` types are documented in the package [`README`](../../packages/llm/codex-credential/README.md); their exact behavior is pinned by `packages/llm/codex-credential/tests/session.spec.ts`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcodexcredential--codexcredential"></a>

### `ctx.codexCredential` — `CodexCredential`

Single-flight Codex session-credential service.

CodexCredential.managerFor returns the one CodexSessionManager memoized for a credential spec, preserving one shared in-flight refresh per document. The memoization caches every spec key for the service's lifetime (develop's single-slot resolver evicted on change); that is safe because each `current()` call re-validates the document and refresh at the moment it runs rather than trusting a stale cached token state.

```ts cordis-catalog
/**
 * Resolve the credential manager for one spec, sharing the cached instance
 * across callers so concurrent requests refresh the document once.
 * @param spec - the credential spec this manager reads and refreshes.
 * @returns the manager for the spec's credential facts.
 */
managerFor(spec: CodexSessionOptions): CodexSessionManager
```

Source: [`packages/llm/codex-credential/src/index.ts:56`](../../packages/llm/codex-credential/src/index.ts)
<!-- END GENERATED cordis-surface -->
