# Loop Guards

Host-seat types for the paid Shres Shield plugin published on `ctx.shield`. Loop-hygiene guards in this group (repeat-tool reminders, step budget, tool timeout) are listener plugins without a `ctx` service; their contracts live in the [package README](../../packages/guard/README.md). This page records the snapshot the Settings pane and Host RPC read from [`packages/guard/shield/src/types.ts`](../../packages/guard/shield/src/types.ts).

`snapshot()` returns a JSON copy, never a live alias of seat or engine state. Disable remounts the payload off but still returns last persisted counts with `status.reason === 'disabled'`. A repo exempt through `repos` reports `status.reason === 'repo-disabled'` while diagnostics keep precedence over the exemption.

```ts type-equiv
/** Host RPC payload for the current session cwd. */
interface ShieldSnapshot {
  /**
   * Effective status for the requested repo: `'disabled'` when the global
   * switch is off, `'repo-disabled'` when this repo is exempt while the
   * engine screens others.
   */
  status: ShieldStatus
  /** Last persisted counts for this repo; disable does not wipe them. */
  stats: ShieldRepoStats
  /** Definition stamp when the engine reports one. */
  definitions?: ShieldDefinitions
}
```

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
 * Remember the per-repo exemption check used to override snapshot status.
 * @param disabledFor - `(cwd) => true` when an entry disables that repo.
 */
bindRepoDisabled(disabledFor: ((cwd: string) => boolean) | undefined): void

/**
 * Remember the pull re-evaluation run at the top of every snapshot call —
 * the safety net for session events scope-filtered away from the seat fiber.
 * @param pull - triggers a seat sync when the repo-gate decision flipped.
 */
bindPullSync(pull: (() => void) | undefined): void

/**
 * Per-repo counters for the current session cwd. Disable remounts the payload
 * off but still returns last persisted counts with `status.reason === 'disabled'`.
 * A repo exempt through `repos` reports `status.reason === 'repo-disabled'`
 * while diagnostics keep precedence over the exemption. The call first
 * re-evaluates the repo gate; because that re-evaluation settles
 * asynchronously, the snapshot that detected a flip reports the pre-flip
 * status and the next read reflects the new one.
 * @param sessionId - live session whose `header.cwd` keys the stats; omitted
 *   uses the most recently created live session that has a cwd.
 * @returns a JSON copy, never a live alias of seat or engine state.
 */
@Remote('snapshot') snapshot(sessionId?: string): ShieldSnapshot
```

Source: [`packages/guard/shield/src/index.ts:251`](../../packages/guard/shield/src/index.ts)
<!-- END GENERATED cordis-surface -->
