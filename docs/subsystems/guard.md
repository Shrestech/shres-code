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
  /** Resolved payload identity when an engine file loaded. */
  payload?: ShieldPayloadInfo
}
```

```ts type-equiv
/**
 * Currently resolved paid payload identity. Omitted from the snapshot when
 * nothing resolved.
 */
interface ShieldPayloadInfo {
  /** Resolution leg that supplied `apply`. */
  source: ShieldEngineSource
  /**
   * `version` from the resolved `@shrestech/shres-shield-plugin` package.json,
   * or `null` when that file is missing or not that package (env fixtures,
   * a bare specifier with no on-disk package).
   */
  version: string | null
}
```

```ts type-equiv
/**
 * Result of `checkUpdate` / `applyUpdate`. `applied` is true only after a
 * successful profile install and remount.
 */
interface ShieldPayloadUpdate {
  /** Always `@shrestech/shres-shield-plugin`. */
  specifier: string
  /** Current resolution leg, or `'none'` when the engine is missing. */
  source: ShieldEngineSource | 'none'
  /** Installed payload version, or `null` when it cannot be read. */
  installed: string | null
  /** `dist-tags.latest` from the npm registry, or `null` on a registry miss. */
  latest: string | null
  /**
   * True when `latest` is a semver string different from `installed` and
   * nothing blocks an install. Env override and missing profile force false.
   */
  available: boolean
  /** True only after `applyUpdate` installed `latest` into the profile. */
  applied: boolean
  /** Present when the check or install cannot proceed. */
  blocked?: ShieldUpdateBlocked
  /** Registry, pnpm, or validation diagnostic; omitted on success. */
  detail?: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxshield--shieldhost"></a>

### `ctx.shield` — `ShieldHost`

Published Shield status, snapshot RPC, and npm check/install remotes. `active` is the brand-mark switch: blue girl and green shield only while the paid engine is screening. The seat owns this service name; the paid plugin must not replace it.

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
 * Remember the resolved payload identity so snapshot and update RPCs can
 * report source and version without re-importing.
 * @param info - identity plus the import entry used for version lookup.
 */
bindResolved(info: ShieldPayloadInfo | undefined): void

/**
 * One-shot staleness probe (gapfix 2026-08-24): query npm `latest` and, when
 * it outruns the applied payload version, emit a stderr notice and mark the
 * host status reason `payload-outdated` WITHOUT deactivating screening.
 * Skipped for env-module overrides (their contract is explicit pinning) and
 * when the registry is unreachable. Fires at most once per boot.
 */
async notePayloadStaleness(): Promise<void>

/**
 * Remember the boot profile directory `pnpm add` installs into.
 * @param dir - absolute profile directory, or `undefined` when the seat
 *   is not booted from a profile.
 */
bindProfileDir(dir: string | undefined): void

/**
 * Remember the remount used after a successful npm install.
 * @param remount - queues a seat sync and returns the in-flight chain.
 */
bindRemount(remount: (() => Promise<void>) | undefined): void

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

/**
 * Compare the resolved payload version with npm `latest`. Does not install.
 * An env-module override still reports `latest` but sets `available: false`
 * and `blocked: 'env-override'` because that exclusive leg would ignore a
 * profile install.
 * @returns a JSON copy of the check result.
 */
@Remote('checkUpdate') async checkUpdate(): Promise<ShieldPayloadUpdate>

/**
 * Re-query npm `latest` and, when an update is available, `pnpm add` that
 * exact version into the boot profile, then remount so the profile leg
 * loads it. Refuses env-module override, a missing profile directory, and
 * a non-semver registry version.
 * @returns the post-install check, with `applied: true` on success.
 */
@Remote('applyUpdate') async applyUpdate(): Promise<ShieldPayloadUpdate>
```

Source: [`packages/guard/shield/src/index.ts:268`](../../packages/guard/shield/src/index.ts)
<!-- END GENERATED cordis-surface -->
