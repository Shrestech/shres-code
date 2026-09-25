/**
 * The profile facts a host hands the app before the plugin tree mounts: which
 * profile directory it booted, which bundle layers it captured, and whether
 * the surface permits plugin mutations. Consumers such as the plugin-admin
 * Remote namespace inject `profileRuntime` to report plugin state and to
 * gate mutations per surface.
 * @module @shres-code/shres-code-app-boot/profile-runtime
 */

import type { Context } from '@shres-code/cordis'

/**
 * The boot-time profile facts an app provides before any tree entry mounts.
 * The values are frozen snapshots: later manifest edits apply after a
 * restart, which is exactly the readiness model the plugin states report.
 */
export interface ProfileRuntime {
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
}

/** The context key {@link provideProfileRuntime} provides under. */
export const PROFILE_RUNTIME_KEY = 'profileRuntime'

declare module '@shres-code/cordis' {
  interface Context {
    /** The booted profile's runtime facts; provided by a launcher before the tree mounts. */
    profileRuntime?: ProfileRuntime
  }
}

/**
 * Provide the profile runtime facts on a host context before any tree entry
 * mounts — the same launcher-owned pattern as `provideCmdline`. The bundle
 * list is copied and frozen, so a later mutation of the caller's array cannot
 * change what injected plugins observe.
 * @param ctx - the host context the tree will mount under.
 * @param value - the booted profile's directory, bundle layers, and mutation policy.
 */
export function provideProfileRuntime(ctx: Context, value: ProfileRuntime): void {
  ctx.provide(PROFILE_RUNTIME_KEY, Object.freeze({
    profileDir: value.profileDir,
    bootBundles: Object.freeze([...value.bootBundles]),
    pluginMutations: value.pluginMutations,
  }))
}
