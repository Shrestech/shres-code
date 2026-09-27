/** Managed profile-plugin transaction results shared by CLI and host consumers. */
import type { PnpmRunner } from './profile-pnpm.ts'

/** Explicit process dependencies for a profile operation. */
export interface CoreOptions {
  runner: PnpmRunner
  signal: AbortSignal
  invokingCwd: string
}
/** Package identity and consequences presented before activation. */
export interface InstallPreview {
  spec: string
  name: string
  version: string
  source: 'registry' | 'git' | 'path' | 'tarball'
  stagedFrom?: string
  clientHalf: boolean
  addedPackages: string[]
}
/** Expected refusal; details contain diagnostics, never a runnable command. */
export interface InstallRefusal {
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
/** Metadata restoration is exact; package-directory restoration is best effort. */
export interface RollbackReport {
  filesRestored: true
  reinstall: 'ok' | 'failed' | 'skipped'
  detail?: string
}
/** A consented manifest commit takes effect on the next profile boot. */
export interface InstallCommitted {
  name: string
  version: string
  readiness: 'restart-required'
}
/** Install failure with the completed rollback outcome. */
export interface InstallRefused {
  kind: 'refused'
  refusal: InstallRefusal
  rollback: RollbackReport
}
/** Exactly one terminal decision owns a parked install; repeating that decision joins its promise. */
export interface ParkedInstall {
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
/** A staged package remains inactive until its returned transaction is confirmed. */
export type InstallBegin = { kind: 'parked'; install: ParkedInstall } | InstallRefused
/** Removal deactivates the bundle before dependency cleanup. */
export type RemoveOutcome = { kind: 'removed'; pnpm: 'ok' | 'failed'; detail?: string }
  | { kind: 'refused'; code: 'not-installed' | 'template-bundle' | 'unsupported-platform' }
/** Completed recovery can preserve a consented install or roll a removal forward without rollback. */
export type RecoveredProfile = { kind: 'none' }
  | { kind: 'recovered'; op: 'install' | 'remove'; rollback?: RollbackReport }
/** Another live process or in-process transaction prevents recovery. */
export type RecoveryOutcome = RecoveredProfile | { kind: 'owner-alive'; pid: number }
/** Desired profile membership compared with this process's boot snapshot. */
export interface PluginStateEntry {
  name: string
  version?: string
  state: 'active' | 'installed-restart-required' | 'removed-restart-required'
  /**
   * Whether the core accepts a removal for this name: desired membership that
   * is not a shipped template bundle. Removed-restart rows are never removable.
   */
  removable: boolean
}

/**
 * Describes the result of a profile mutation requested by the plugin manager.
 *
 * A saved mutation can require a process or browser restart when the live
 * loader cannot replace every affected host or client entry.
 */
export type ProfileActivationOutcome =
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

/**
 * Reports one bundle's selected and active state to the plugin manager.
 *
 * `active` describes the running loader. It can therefore differ from
 * `selected` until a restart applies a saved manifest change.
 */
export interface ProfileBundleState {
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
/** Lock/recovery failures that callers must not reinterpret as package refusals. */
export class ProfilePluginError extends Error {
  override readonly name = 'ProfilePluginError'
  constructor(
    readonly code: 'lock-timeout' | 'transaction-pending' | 'restore-failed',
    message: string,
    readonly pid?: number,
  ) { super(message) }
}
