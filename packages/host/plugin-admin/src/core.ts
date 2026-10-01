/**
 * The core-operation seam of the pluginAdmin gateway. The gateway is a
 * consumer of the shared W1/W2 install core — it never reimplements pnpm,
 * journaling, or skill-copy logic. `nodePluginAdminCore` is the production
 * wiring that resolves the shared functions and their pnpm runner; tests
 * fabricate the interface instead of spawning anything.
 * @module @shres-code/shres-code-host-plugin-admin/core
 */

import {
  listProfileBundles,
  setBundleEnabled,
  setPluginEnabled,
  beginPluginInstall,
  nodePnpmRunner,
  pluginStates,
  removePlugin,
} from '@shres-code/shres-code-app-boot'
import type {
  ProfileRuntime,
  InstallBegin,
  PluginStateEntry,
  RemoveOutcome,
} from '@shres-code/shres-code-app-boot'
import {
  addInstalledSkill,
  defaultSkillInstallRoots,
  listInstalledSkills,
  removeInstalledSkill,
} from '@shres-code/shres-code-skill-filesystem/install'
import type { SkillInstallRoots } from '@shres-code/shres-code-skill-filesystem/install'
import type {
  ManagedBundle,
  PluginActivationOutcome,
  SkillInstallOutcome,
  SkillRemoveOutcome,
} from './types.ts'

/** Per-operation options the gateway supplies to the core. */
export interface PluginAdminCoreOptions {
  /** Aborts the core operation when the gateway's disposal or a timeout cancels it. */
  readonly signal: AbortSignal
  /** Working directory relative install specs anchor against. */
  readonly invokingCwd: string
}

/** One installed skill row as the shared core reports it, before the gateway projects shadowing onto it. */
export interface InstalledSkillRow {
  name: string
  description: string
  digest: string
  origin: string
  installedAt: string
}

/**
 * The shared install-core functions the gateway consumes, one member per
 * core operation. Signatures mirror the owning packages' contracts; the
 * pnpm runner is resolved here so gateway callers never handle it.
 */
export interface PluginAdminCore {
  listBundles(runtime: ProfileRuntime): Promise<ManagedBundle[]>
  setBundleEnabled(
    runtime: ProfileRuntime, name: string, enabled: boolean, options: PluginAdminCoreOptions,
  ): Promise<PluginActivationOutcome>
  setPluginEnabled(
    runtime: ProfileRuntime, request: { id: string; moduleName: string; enabled: boolean }, options: PluginAdminCoreOptions,
  ): Promise<PluginActivationOutcome>
  beginPluginInstall(profileDir: string, spec: string, options: PluginAdminCoreOptions): Promise<InstallBegin>
  removePlugin(profileDir: string, name: string, options: PluginAdminCoreOptions): Promise<RemoveOutcome>
  pluginStates(profileDir: string, bootBundles: readonly string[]): Promise<PluginStateEntry[]>
  addInstalledSkill(sourceDir: string, roots: SkillInstallRoots, options?: { signal?: AbortSignal }): Promise<SkillInstallOutcome>
  removeInstalledSkill(name: string, roots: SkillInstallRoots): Promise<SkillRemoveOutcome>
  listInstalledSkills(roots: SkillInstallRoots): Promise<InstalledSkillRow[]>
}

/**
 * Resolve the host's skill install roots around one working directory.
 * @param cwd - workspace used for project-skill collision checks.
 * @param override - complete deployment-owned roots when supplied.
 * @returns explicit roots used for every skill operation in this host.
 */
export function resolveSkillRoots(cwd: string, override?: SkillInstallRoots): SkillInstallRoots {
  return override ?? defaultSkillInstallRoots(cwd)
}

/** Production core: the shared app-boot plugin core plus the shared skill-filesystem installer. */
export const nodePluginAdminCore: PluginAdminCore = {
  listBundles: async (runtime) => {
    const rows = runtime.control !== undefined ? await runtime.control.listBundles()
      : runtime.installAnchor === undefined ? [] : await listProfileBundles(runtime.profileDir, runtime.bootBundles, {
        installAnchor: runtime.installAnchor, ...runtime.shippedBundles === undefined ? {} : { shippedBundles: runtime.shippedBundles },
      })
    return runtime.pluginMutations === 'enabled' ? rows : rows.map(row => ({ ...row, readOnlyReason: 'Plugin changes are unavailable on this host.' }))
  },
  setBundleEnabled: (runtime, name, enabled, options) => runtime.control !== undefined
    ? runtime.control.setBundleEnabled(name, enabled, options.signal)
    : runtime.installAnchor === undefined ? Promise.resolve({ kind: 'unsupported' })
      : setBundleEnabled(runtime.profileDir, name, enabled, {
        ...options, runner: nodePnpmRunner, installAnchor: runtime.installAnchor,
        ...runtime.shippedBundles === undefined ? {} : { shippedBundles: runtime.shippedBundles },
      }),
  setPluginEnabled: (runtime, request, options) => runtime.control !== undefined
    ? runtime.control.setPluginEnabled(request, options.signal)
    : runtime.installAnchor === undefined ? Promise.resolve({ kind: 'unsupported' })
      : setPluginEnabled(runtime.profileDir, request, {
        ...options, runner: nodePnpmRunner, installAnchor: runtime.installAnchor,
        ...runtime.shippedBundles === undefined ? {} : { shippedBundles: runtime.shippedBundles },
      }),
  beginPluginInstall: (profileDir, spec, options) =>
    beginPluginInstall(profileDir, spec, { runner: nodePnpmRunner, signal: options.signal, invokingCwd: options.invokingCwd }),
  removePlugin: (profileDir, name, options) =>
    removePlugin(profileDir, name, { runner: nodePnpmRunner, signal: options.signal, invokingCwd: options.invokingCwd }),
  pluginStates,
  addInstalledSkill,
  removeInstalledSkill,
  listInstalledSkills,
}
