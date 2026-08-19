# Guard services

Guard services observe or intercept model and tool activity without changing the agent-loop driver. Shres Shield owns its detailed configuration, screening policy, and optional external engine in [`packages/guard/shield/README.md`](../../packages/guard/shield/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxshield--shieldhost"></a>

### `ctx.shield` — `ShieldHost`

Published Shield status and a read-only snapshot RPC. `active` is the brand-mark switch: blue girl and green shield only while the paid engine is screening. The seat owns this service name; the paid plugin must not replace it.

```ts cordis-catalog
/**
 * Remember the live paid instance so {@link snapshot} can read its stats.
 * @param payload - value returned by the paid `apply`, or `undefined` after dispose.
 */
bindPayload(payload: unknown): void

/**
 * Remember a module-level stats reader used when screening is off.
 * @param reader - `stats.snapshot` from the resolved payload module, or `undefined`.
 */
bindPersistedReader(reader: ((cwd?: string | null) => unknown) | undefined): void

/**
 * Per-repo counters for the current session cwd. Disable remounts the payload
 * off but still returns last persisted counts with `status.reason === 'disabled'`.
 * @param sessionId - live session whose `header.cwd` keys the stats; omitted
 *   uses the most recently created live session that has a cwd.
 * @returns a JSON copy, never a live alias of seat or engine state.
 */
@Remote('snapshot') snapshot(sessionId?: string): ShieldSnapshot
```

Source: [`packages/guard/shield/src/index.ts:243`](../../packages/guard/shield/src/index.ts)
<!-- END GENERATED cordis-surface -->
