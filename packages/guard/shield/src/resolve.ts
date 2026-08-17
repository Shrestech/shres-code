/**
 * Locate the paid `@shres-shield/plugin` payload without declaring it as a
 * workspace dependency. The engine stays in the shres-shield repo.
 * @module @shres-code/shres-code-shield/resolve
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ShieldEngine, ShieldEngineApply } from './types.ts'

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

async function importSpecifier(specifier: string): Promise<ShieldEngineApply | undefined> {
  try {
    const href = specifier.startsWith('file:')
      ? specifier
      : isAbsolute(specifier) || specifier.startsWith('.')
        ? pathToFileURL(resolve(specifier)).href
        : specifier
    return asApply(await import(href))
  } catch {
    return undefined
  }
}

/**
 * Resolve the paid plugin in the documented order: env override, sibling
 * checkout, then the `@shres-shield/plugin` package specifier.
 * @returns the loaded `apply`, or `undefined` when nothing resolved.
 */
export async function resolveShieldEngine(): Promise<ShieldEngine | undefined> {
  const fromEnv = process.env.SHRES_SHIELD_MODULE
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const apply = await importSpecifier(fromEnv)
    return apply === undefined ? undefined : { source: 'env', apply }
  }

  const sibling = siblingPluginPath()
  if (existsSync(sibling)) {
    const apply = await importSpecifier(sibling)
    if (apply !== undefined) return { source: 'sibling', apply }
  }

  const fromPackage = await importSpecifier('@shres-shield/plugin')
  if (fromPackage !== undefined) return { source: 'package', apply: fromPackage }
  return undefined
}
