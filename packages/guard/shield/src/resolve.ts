/**
 * Locate the paid `@shrestech/shres-shield-plugin` payload without declaring it
 * as a workspace dependency. The engine stays in the shres-shield repo.
 * @module @shres-code/shres-code-shield/resolve
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ShieldEngine, ShieldEngineApply } from './types.ts'

/** The published npm name of the paid Shield plugin. */
export const PAYLOAD_SPECIFIER = '@shrestech/shres-shield-plugin'

/**
 * Shres-code repo root from this file, whether it is loaded from `src/` or `lib/`.
 * @returns the directory that contains `packages/` and `apps/`.
 */
export function repoRootFromSeat(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
}

/**
 * Sibling plugin entry the developer checkout uses for entitlement.
 * @param repoRoot - shres-code root from {@link repoRootFromSeat}.
 * @returns absolute path to `../shres-shield/packages/plugin/dist/index.js`.
 */
export function siblingPluginPath(repoRoot: string = repoRootFromSeat()): string {
  return resolve(repoRoot, '../shres-shield/packages/plugin/dist/index.js')
}

function asApply(mod: unknown): ShieldEngineApply | undefined {
  if (mod === null || typeof mod !== 'object') return undefined
  const apply = (mod as { apply?: unknown }).apply
  return typeof apply === 'function' ? apply as ShieldEngineApply : undefined
}

function asSnapshot(mod: unknown): ((cwd?: string | null) => unknown) | undefined {
  // asSnapshot is reached only after toEngine's asApply proved `mod` is an
  // object carrying a function `apply`, so this defensive null check can never
  // fire — it guards a call a future caller might route here directly.
  /* v8 ignore next 1 */
  if (mod === null || typeof mod !== 'object') return undefined
  const stats = (mod as { stats?: { snapshot?: unknown } }).stats
  if (stats !== undefined && typeof stats.snapshot === 'function') {
    return (cwd?: string | null) => (stats.snapshot as (cwd?: string | null) => unknown)(cwd)
  }
  const snapshot = (mod as { snapshot?: unknown }).snapshot
  return typeof snapshot === 'function' ? snapshot as (cwd?: string | null) => unknown : undefined
}

function toEngine(
  source: ShieldEngine['source'],
  mod: unknown,
  entry: string,
): ShieldEngine | undefined {
  const apply = asApply(mod)
  if (apply === undefined) return undefined
  const snapshot = asSnapshot(mod)
  return snapshot === undefined ? { source, apply, entry } : { source, apply, snapshot, entry }
}

async function importSpecifier(specifier: string): Promise<unknown> {
  try {
    const href = specifier.startsWith('file:')
      ? specifier
      : isAbsolute(specifier) || specifier.startsWith('.')
        ? pathToFileURL(resolve(specifier)).href
        : specifier
    return await import(href)
  } catch {
    return undefined
  }
}

/** Resolution anchors for {@link resolveShieldEngine}; every field optional with a production default. */
export interface ShieldResolveOptions {
  /**
   * Absolute active-profile directory whose `node_modules` may hold the paid
   * payload (installed by edition ensure). Omit to skip the profile-installed
   * leg — a seat not booted from a profile resolves only env, sibling, package.
   */
  profileDir?: string
  /** shres-code root for the sibling-checkout leg; defaults to {@link repoRootFromSeat}. */
  repoRoot?: string
}

/**
 * Resolve the paid payload's absolute entry path from a profile directory's
 * `node_modules`, using a `node:module` `createRequire` anchored at the
 * profile's `package.json` so the lookup starts exactly where pnpm installs
 * profile-local dependencies.
 * @param profileDir - the active profile directory.
 * @param specifier - the payload specifier; defaults to {@link PAYLOAD_SPECIFIER}.
 * @returns the resolved absolute module path, or `undefined` when the profile
 *   does not carry the package.
 */
export function resolveProfileSpecifier(
  profileDir: string,
  specifier: string = PAYLOAD_SPECIFIER,
): string | undefined {
  try {
    return createRequire(join(profileDir, 'package.json')).resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * Resolve the paid plugin in the documented order: env override (exclusive),
 * the active profile's installed payload, sibling checkout, then the
 * `@shrestech/shres-shield-plugin` package specifier. Profile precedes sibling
 * so a Settings → Update install takes effect on a machine that also has a
 * local `../shres-shield` checkout. Every leg stays fail-through (`undefined`
 * when nothing resolves); the seat owns the fail-soft contract when every
 * leg misses.
 * @param options - resolution anchors; `profileDir` enables the profile-installed leg.
 * @returns the loaded `apply`, or `undefined` when nothing resolved.
 */
export async function resolveShieldEngine(
  options: ShieldResolveOptions = {},
): Promise<ShieldEngine | undefined> {
  const fromEnv = process.env.SHRES_SHIELD_MODULE
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return toEngine('env', await importSpecifier(fromEnv), fromEnv)
  }

  if (options.profileDir !== undefined) {
    const profileSpec = resolveProfileSpecifier(options.profileDir)
    if (profileSpec !== undefined) {
      const engine = toEngine('profile', await importSpecifier(profileSpec), profileSpec)
      if (engine !== undefined) return engine
    }
  }

  const sibling = siblingPluginPath(options.repoRoot)
  if (existsSync(sibling)) {
    const engine = toEngine('sibling', await importSpecifier(sibling), sibling)
    if (engine !== undefined) return engine
  }

  return toEngine('package', await importSpecifier(PAYLOAD_SPECIFIER), PAYLOAD_SPECIFIER)
}
