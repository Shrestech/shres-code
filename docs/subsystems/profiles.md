# Profiles

A profile is a named directory of bundle layers plus the user's own patch layer, owned by [shres-app-boot](../../packages/boot/app-boot). This page records the vocabulary a launcher hands the booted tree and the managed plugin transaction the CLI and the host share. The [app-boot README](../../packages/boot/app-boot/README.md#profiles) owns directory layout, bundle resolution, patch-layer composition, and the transaction ordering, lock, journal, staging, and recovery rules; the [plugin-admin README](../../packages/host/plugin-admin/README.md) owns the `pluginAdmin` methods and what its gesture tokens do and do not prove. Source: [`packages/boot/app-boot/src/profile-runtime.ts`](../../packages/boot/app-boot/src/profile-runtime.ts), [`packages/boot/app-boot/src/profile-plugin-types.ts`](../../packages/boot/app-boot/src/profile-plugin-types.ts), and [`packages/host/plugin-admin/src/types.ts`](../../packages/host/plugin-admin/src/types.ts).

## Profile runtime

A launcher provides `ProfileRuntime` under the `profileRuntime` context key through `provideProfileRuntime` before any tree entry mounts. Boot metadata is frozen. An optional `control` owner exposes current bundle membership and serializes explicit activation with live patch reconciliation; hosts without that owner retain restart-required behavior. The CLI provides `'enabled'`; the packaged desktop provides `'unsupported'` because it has no executable plugin-install owner. A composition whose launcher provides no runtime has no managed profile at all.

```ts type-equiv
/**
 * The boot-time profile facts an app provides before any tree entry mounts.
 * Boot facts are frozen; optional controls own the current applied composition.
 * Hosts without controls save supported changes for their next restart.
 */
interface ProfileRuntime {
  /** Absolute directory of the booted profile (its manifest's owner). */
  readonly profileDir: string
  /** Bundle names captured at boot, in `shres.profile.bundles` order. */
  readonly bootBundles: readonly string[]
  /**
   * Whether this surface permits plugin mutations through the shared core.
   * `'unsupported'` marks a surface with no executable plugin-install owner:
   * it serves status and refuses mutations with its own message.
   */
  readonly pluginMutations: 'enabled' | 'unsupported'
  /** Package anchor used to resolve installed profile bundles. */
  readonly installAnchor?: string
  /** Required and optional bundles available from the running installation. */
  readonly shippedBundles?: readonly string[]
  /** Live profile controls exposed by a launcher that supports reconciliation. */
  readonly control?: ProfileRuntimeControl
}
```

## Managed plugin transactions

`beginPluginInstall` answers `InstallBegin`: a refusal whose rollback already completed, or a `ParkedInstall` holding the profile lock until one terminal decision. The transaction types are also exported without the core's runtime from the `@shres-code/shres-code-app-boot/plugin-types` subpath, which transport contracts import.

```ts type-equiv
/** Package identity and consequences presented before activation. */
interface InstallPreview {
  spec: string
  name: string
  version: string
  source: 'registry' | 'git' | 'path' | 'tarball'
  stagedFrom?: string
  clientHalf: boolean
  addedPackages: string[]
}
```

```ts type-equiv
/** Exactly one terminal decision owns a parked install; repeating that decision joins its promise. */
interface ParkedInstall {
  readonly preview: InstallPreview
  /** Activate the previewed bundle, or refuse it after composition validation.
   * @returns the committed identity or refusal after rollback.
   */
  confirm(): Promise<({ kind: 'committed' } & InstallCommitted) | InstallRefused>
  /** Restore the pre-install files; rejects if confirmation already owns settlement.
   * @returns the completed restoration report.
   */
  cancel(): Promise<RollbackReport>
}
```

```ts type-equiv
/** A staged package remains inactive until its returned transaction is confirmed. */
type InstallBegin = { kind: 'parked'; install: ParkedInstall } | InstallRefused
```

A confirmed install commits `InstallCommitted` and reports `'restart-required'`. A subsequent explicit activation can reconcile a supported live profile.

```ts type-equiv
/** A consented manifest commit takes effect on the next profile boot. */
interface InstallCommitted {
  name: string
  version: string
  readiness: 'restart-required'
}
```

`unsupported-layout` means the profile's `node_modules` is not recorded as pnpm's hoisted layout, which build inspection requires; `nodeLinker` names the recorded linker. Every refusal after the transaction began carries the rollback that already ran. `filesRestored` is always `true` because the manifest and lockfile are restored byte-for-byte; `reinstall` reports the best-effort offline repair of installed packages.

```ts type-equiv
/** Install failure with the completed rollback outcome. */
interface InstallRefused {
  kind: 'refused'
  refusal: InstallRefusal
  rollback: RollbackReport
}
```

```ts type-equiv
/** Expected refusal; details contain diagnostics, never a runnable command. */
interface InstallRefusal {
  code: 'pnpm-not-found' | 'pnpm-failed' | 'needs-build' | 'foreign-dsh' | 'not-a-bundle'
    | 'already-active' | 'link-spec' | 'compose-failed' | 'declined' | 'unsupported-platform' | 'invalid-spec'
    | 'unsupported-layout'
  detail?: string
  /**
   * For `unsupported-layout`: the linker pnpm recorded for the profile's
   * node_modules, or null when no readable linker was recorded.
   */
  nodeLinker?: string | null
}
```

```ts type-equiv
/** Metadata restoration is exact; package-directory restoration is best effort. */
interface RollbackReport {
  filesRestored: true
  reinstall: 'ok' | 'failed' | 'skipped'
  detail?: string
}
```

`removePlugin` deactivates the bundle before package cleanup, so a `removed` outcome with `pnpm: 'failed'` still means the plugin will not load on the next boot.

```ts type-equiv
/** Removal deactivates the bundle before dependency cleanup. */
type RemoveOutcome = { kind: 'removed'; pnpm: 'ok' | 'failed'; detail?: string }
  | { kind: 'refused'; code: 'not-installed' | 'template-bundle' | 'unsupported-platform' }
```

`pluginStates` compares the manifest’s desired bundles with the caller’s applied membership; hosts without live controls use `ProfileRuntime.bootBundles`. Each row's `removable` repeats the core's own removal precondition — desired membership outside the shipped template bundles — so a removed-restart row is never removable. Lock timeouts, a live transaction owned by another process, and failed restorations are `ProfilePluginError` exceptions with the codes `lock-timeout`, `transaction-pending`, and `restore-failed`, never package refusals.

```ts type-equiv
/** Desired profile membership compared with this process's boot snapshot. */
interface PluginStateEntry {
  name: string
  version?: string
  state: 'active' | 'installed-restart-required' | 'removed-restart-required'
  /**
   * Whether the core accepts a removal for this name: desired membership that
   * is not a shipped template bundle. Removed-restart rows are never removable.
   */
  removable: boolean
}
```

## Host administration

The `pluginAdmin` Remote namespace of [shres-host-plugin-admin](../../packages/host/plugin-admin) serves the managed transaction to the Web client for the profile in `ProfileRuntime`, and re-exports the core transaction types above rather than redeclaring them. Its gesture grants, confirm tokens, and transaction ids are [branded](core.md#branded-ids) opaque strings.

```ts type-equiv
/** Opaque single-use grant from `pluginAdmin/begin`; the wire form is a 32-character hex string. */
type PluginGestureToken = Branded<'PluginGestureToken'>
```

```ts type-equiv
/** Opaque id of one parked install transaction; the wire form is a 32-character hex string. */
type PluginTransactionId = Branded<'PluginTransactionId'>
```

```ts type-equiv
/** Opaque single-use token that confirms or cancels one parked transaction. */
type PluginConfirmToken = Branded<'PluginConfirmToken'>
```

```ts type-equiv
/**
 * Whether this host may install or remove profile plugins. `'unsupported'`
 * marks a host with no executable plugin-install owner for its profile: the
 * packaged desktop, or a composition whose launcher provided no
 * `profileRuntime`. Skill add and remove stay available in both states.
 */
type PluginMutations = 'enabled' | 'unsupported'
```

```ts type-equiv
/** Full plugin-and-skill picture for a fresh page load. */
interface PluginAdminStatusResult {
  /** Whether this host may install or remove profile plugins. */
  mutations: PluginMutations
  /** Every profile plugin with its restart readiness; empty when no profile runtime was provided. */
  plugins: PluginStateEntry[]
  /** Every user-installed skill, with live-catalog shadowing when known. */
  skills: InstalledSkillView[]
  /** The one parked install transaction, when one awaits consent. */
  parked?: ParkedTransactionView
}
```

```ts type-equiv
/** One parked install transaction as `status` reports it. */
interface ParkedTransactionView {
  /** Opaque transaction id; settling needs the confirm token, not this id. */
  transactionId: PluginTransactionId
  /** The preview the parked install is awaiting consent for. */
  preview: InstallPreview
}
```

```ts type-equiv
/** One user-installed skill, plus the live-catalog skill that outranks it when one exists. */
interface InstalledSkillView {
  /** Kebab-case skill name. */
  name: string
  /** Frontmatter description. */
  description: string
  /** SHA-256 tree digest recorded at install time. */
  digest: string
  /** Origin path recorded at install time. */
  origin: string
  /** ISO 8601 install timestamp. */
  installedAt: string
  /**
   * Source of the same-named skill that currently wins over this installed
   * one in the registry's global snapshot, present only when such a skill is
   * live. Installed skills rank lowest, so any same-named runtime, bundled,
   * user, project, or custom skill shadows them. Preset-scoped overrides are
   * not part of the global snapshot.
   */
  shadowedBy?: SkillSource
}
```

```ts type-equiv
/**
 * Install outcome: a parked transaction with its confirm token, a core
 * refusal with the rollback report, or `unsupported` when this host has no
 * plugin-install owner (see {@link PluginMutations}); `unsupported` touches
 * nothing.
 */
type PluginAdminInstallOutcome =
  | { kind: 'parked'; transactionId: PluginTransactionId; preview: InstallPreview; confirmToken: PluginConfirmToken }
  | { kind: 'refused'; refusal: InstallRefusal; rollback: RollbackReport }
  | { kind: 'unsupported' }
```

```ts type-equiv
/**
 * Confirm outcome: the flat commit receipt (package name, version, restart
 * readiness) or the refusal with its rollback report.
 */
type PluginAdminConfirmOutcome =
  | ({ kind: 'committed' } & InstallCommitted)
  | { kind: 'refused'; refusal: InstallRefusal; rollback: RollbackReport }
```

## Bundle and row activation

`ProfileRuntimeControl` owns live application for the booted profile. The core reports selected and applied bundle membership independently, keeps malformed selected bundles visible, and separates a persisted preference from its effective value under higher-priority overlays. Activation does not delete package dependencies or feature runtime data. The [shared management decision](../../.agents/notes/implemented/architecture/2026-09-27-shared-plugin-activation.md) owns this separation from native setup and package installation.

```ts type-equiv
/** The mutations a pluginAdmin user gesture can authorize. */
type PluginAdminGestureVerb = 'install' | 'remove' | 'skill-add' | 'skill-remove'
  | 'bundle-enable' | 'bundle-disable' | 'plugin-enable' | 'plugin-disable'
```

```ts type-equiv
/**
 * Coordinates profile mutations with the running loader.
 *
 * Implementations must persist desired state before returning `saved`; a
 * restart-required result leaves the current loader active until the next
 * process start.
 */
interface ProfileRuntimeControl {
  /** Read available bundles and the current applied membership.
   * @returns current bundle metadata and membership.
   */
  listBundles(): Promise<ProfileBundleState[]>
  /** Persist bundle selection and reconcile the running composition.
   * @param name - installed or shipped package identity.
   * @param enabled - desired selection.
   * @param signal - operation cancellation from the caller.
   * @returns saved application state or expected refusal.
   */
  setBundleEnabled(
    name: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<ProfileActivationOutcome>
  /** Persist a row override and reconcile the running composition.
   * @param request - patch id, module identity, and desired enablement.
   * @param signal - operation cancellation from the caller.
   * @returns saved application state or expected refusal.
   */
  setPluginEnabled(
    request: { id: string; moduleName: string; enabled: boolean },
    signal: AbortSignal,
  ): Promise<ProfileActivationOutcome>
}
```

```ts type-equiv
/**
 * Reports one bundle's selected and active state to the plugin manager.
 *
 * `active` describes the running loader. It can therefore differ from
 * `selected` until a restart applies a saved manifest change.
 */
interface ProfileBundleState {
  name: string
  description?: string
  version?: string
  selected: boolean
  active: boolean
  shipped: boolean
  rows: readonly string[]
  readOnlyReason?: string
  error?: string
}
```

```ts type-equiv
/**
 * Describes the result of a profile mutation requested by the plugin manager.
 *
 * A saved mutation can require a process or browser restart when the live
 * loader cannot replace every affected host or client entry.
 */
type ProfileActivationOutcome =
  | {
      kind: 'saved'
      application: 'applied' | 'restart-required' | 'overridden'
      detail?: string
    }
  | {
      kind: 'refused'
      code:
        | 'unknown-bundle'
        | 'unknown-plugin'
        | 'management-required'
        | 'unaddressable'
        | 'invalid-composition'
      detail?: string
    }
  | {
      kind: 'unsupported'
    }
```
