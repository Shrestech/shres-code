/**
 * The profile facts a host hands the app before the plugin tree mounts: which
 * profile directory it booted, which bundle layers it captured, and whether
 * the surface permits plugin mutations. Consumers such as the plugin-admin
 * Remote namespace inject `profileRuntime` to report plugin state and to
 * gate mutations per surface.
 * @module @shres-code/shres-code-app-boot/profile-runtime
 */

import type { Context } from '@shres-code/cordis'
import type {
  ProfileActivationOutcome,
  ProfileBundleState,
} from './profile-plugin-types.ts'

/**
 * The boot-time profile facts an app provides before any tree entry mounts.
 * Boot facts are frozen; optional controls own the current applied composition.
 * Hosts without controls save supported changes for their next restart.
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
  /** Package anchor used to resolve installed profile bundles. */
  readonly installAnchor?: string
  /** Required and optional bundles available from the running installation. */
  readonly shippedBundles?: readonly string[]
  /** Live profile controls exposed by a launcher that supports reconciliation. */
  readonly control?: ProfileRuntimeControl
}

/**
 * Coordinates profile mutations with the running loader.
 *
 * Implementations must persist desired state before returning `saved`; a
 * restart-required result leaves the current loader active until the next
 * process start.
 */
export interface ProfileRuntimeControl {
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
    ...value.installAnchor === undefined ? {} : { installAnchor: value.installAnchor },
    ...value.shippedBundles === undefined ? {} : { shippedBundles: Object.freeze([...value.shippedBundles]) },
    ...value.control === undefined ? {} : { control: value.control },
  }))
}
