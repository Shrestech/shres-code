# Agent Note: A shared Grok subscription-credential service

Status: implemented

## Problem

The Grok Build subscription credential — reading the CLI's OIDC session document at `~/.grok/auth.json`, serving its access token while valid, refreshing through `auth.x.ai`'s `refresh_token` grant at a leeway, and persisting rotations back — lived inside the `llm-grok-session` HTTP adapter (`session.ts`). A future image-generation capability needs the same token engine against the same document. Two consumers each owning a copy of that machinery would fork the refresh behavior, the failure postures, and the security promises. The engine is the shared value, so it belongs in a package of its own, plus a service that guarantees the one in-flight refresh per document across consumers.

## Decision

Extract the credential engine into a sibling package `@shres-code/shres-code-grok-credential` (`packages/llm/grok-credential`), moving `session.ts` there verbatim (identity of behavior is the requirement: same reads, same refresh grant, same rotation persistence, same diagnostics). On top of it, expose a Cordis service `ctx.grokCredential`:

- `managerFor(spec)` returns the one `GrokSessionManager` memoized per spec, keyed by `authPath` + `refreshLeewayMs` — the same keying `llm-grok-session`'s private resolver used, so a shared document is refreshed single-flight regardless of which consumer asked first. The memoization caches every spec key for the service's lifetime (develop's single-slot resolver evicted on change); that is safe because each `accessToken()` call re-validates the document and refresh when it runs, and `managerFor`'s JSDoc acknowledges the change.

`llm-grok-session` keeps its settings section and `resolveCredentialSpec` exactly as they were (the credential fields stay its own), adds the new package as a dependency, and resolves its credential through `ctx.get('grokCredential')` — re-read per request — when the composition mounts the service, falling back to a locally memoized manager otherwise. The moved file's public re-exports (`GrokSessionManager`, `selectSessionEntry`, the entry/options types, `OIDC_ISSUER`) now come from the new package; the deleted file has no other importers. The shipped `shres-code-base` bundle mounts the new service before the adapter so production uses the shared path.

## Alternatives considered

- **Hard-inject or one-shot optional inject** — the Cordis loader marks a fiber `INACTIVE` when a required inject service is absent, so `export const inject = ['llm', 'grokCredential']` would stop the pre-existing `llm-grok-session` specs (which mount only the adapter) from loading; a one-shot `ctx.inject(['grokCredential'], …)` child captured the service once and missed a composition that mounts or unloads it later. Re-reading `ctx.get('grokCredential')` per request avoids both: the unchanged specs keep passing without the service, and a live composition is honored dynamically.
- **A `register(spec)` disposer on the service** — proposed as a lifecycle surface, but it had no production caller, was misdocumented (it released on the service context rather than the caller context), and its unconditional release would drop the memoized manager out from under other `managerFor` holders. `managerFor` alone is the reviewed surface.
- **Move `session.spec.ts` whole** — it bundled the engine tests with `llm-grok-session`'s own route-config tests (defaults, refusals, optional model mapping over `config.ts`). Those config tests cannot live in a package that has no such config, so the file was split: the engine tests moved to the shared package, the config tests stayed in `llm-grok-session`.
- **Keep `session.ts` in place and wrap it** — leaves the engine tied to the adapter package, so the future image tool would import from a chat-adapter package and the shared-service guarantee would be cosmetic.

## Consequences

- One token engine and one single-flight refresh per document for every current and future consumer; behavior is bit-for-bit the previously user-verified subscription chat path.
- The service memizes a manager per spec key for its whole lifetime instead of evicting on change, so a credential spec changed in settings adds a manager rather than replacing one; each `accessToken()` call still re-validates the document, so memory is bounded by the distinct specs a deployment ever uses, not by stale token state.
- Duplication risk is controlled: the only engine copy is the moved file; the adapter's fallback is a few lines of memoization over the same class.
- The new package keeps the moved engine's diagnostics verbatim, including the legacy `llm-grok-session:` prefix, so the error strings the verified routes surface are unchanged; a future rename can reword them for the shared role.
- The extraction is pre-release (no public consumers outside the repo), so the move updates every reference together with no compatibility shims.

## Verification

- `pnpm exec vitest run packages/llm/grok-credential packages/llm/llm-grok-session` is green. The pre-existing `adapter` / `dynamic-settings` / `loader-composition` / `route` specs ran unchanged; `session.spec.ts` was split (the engine tests moved to the new package, grok-session's own config tests stayed); and a new `credential-service.spec.ts` mounts the service with the adapter and spies `managerFor` to pin the shared-service path.
- `pnpm exec tsc -b packages/llm/grok-credential` and `…/llm-grok-session` are clean.
- `pnpm exec oxlint` on the changed paths reports zero new errors against develop.
- `pnpm run duplication` shows no new clones over the develop baseline.
- The three doc gates (`verify-module-graph`, `verify-doc-graphs`, `verify-config-catalog`) pass after regenerating `docs/module-graph.md`, the graph docs, and `docs/config-catalog.md`, and classifying `GrokSessionManager`/`GrokSessionOptions` in the typert cordis-catalog and `grokCredential` in the service-role map.
- No `XAI_API_KEY` is read, no token is ever logged, and no CLI is spawned by the new package or by the adapter's new credential path.
