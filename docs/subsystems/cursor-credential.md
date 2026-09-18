# Cursor Subscription Credential

`@shres-code/shres-code-cursor-credential` owns the one Cursor subscription credential: it reads the login the Cursor Agent CLI stores — the macOS login keychain items `cursor-access-token` / `cursor-refresh-token` (account `cursor-user`) that `cursor-agent login` writes by default, or the file document at `~/.cursor/auth.json` under the CLI's file credential store — and serves the access token while its JWT `exp` claim holds. The issuer is not publicly resolvable, so the CLI owns refresh: this engine never runs a grant itself, and it adopts a rotation on the next resolve.

`ctx.cursorCredential.managerFor(spec)` returns the one single-flight manager memoized per credential spec (the source paths and store kind), so a shared store is read once by concurrent consumers regardless of which capability asked first. The `CursorSessionManager` engine and the `CursorSessionEntry` / `CursorSessionOptions` / `CursorSessionToken` types are documented in the package [`README`](../../packages/llm/cursor-credential/README.md); their exact behavior is pinned by `packages/llm/cursor-credential/tests/session.spec.ts`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcursorcredential--cursorcredential"></a>

### `ctx.cursorCredential` — `CursorCredential`

Single-flight Cursor session-credential service.

CursorCredential.managerFor returns the one CursorSessionManager memoized for a credential spec, preserving one shared in-flight read per source. The memoization caches every spec key for the service's lifetime; that is safe because each `current()` call re-reads the store at the moment it runs rather than trusting a cached token.

```ts cordis-catalog
/**
 * Resolve the credential manager for one spec, sharing the cached instance
 * across callers so concurrent requests read the store once.
 * @param spec - the credential spec this manager reads.
 * @returns the manager for the spec's credential facts.
 */
managerFor(spec: CursorSessionOptions): CursorSessionManager
```

Source: [`packages/llm/cursor-credential/src/index.ts:58`](../../packages/llm/cursor-credential/src/index.ts)
<!-- END GENERATED cordis-surface -->
