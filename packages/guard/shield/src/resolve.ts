/**
 * Locate the paid `@shrestech/shres-shield-plugin` payload without declaring it
 * as a workspace dependency. The engine stays in the shres-shield repo.
 * File-leg `import()` URLs carry a content-scoped query, and an ESM resolve
 * hook copies that query onto child `file:` URLs, so a remount after an
 * in-place profile overwrite loads a new module graph instead of the
 * process's cached one.
 * @module @shres-code/shres-code-shield/resolve
 */

import { createRequire, registerHooks } from 'node:module'
import type { ResolveFnOutput, ResolveHookContext } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ShieldEngine, ShieldEngineApply } from './types.ts'

/** The published npm name of the paid Shield plugin. */
export const PAYLOAD_SPECIFIER = '@shrestech/shres-shield-plugin'

/**
 * ESM cache key on file-leg payload imports. Distinct from Vite's `v` query
 * so this hook copies the token only across the Shield payload graph.
 */
export const PAYLOAD_IMPORT_BUST_PARAM = 'shresShieldBust'

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

/**
 * Absolute filesystem path for a file-leg specifier. Bare package names and
 * malformed `file:` URLs return `undefined`.
 * @param specifier - absolute path, relative path, `file:` URL, or bare name.
 * @returns the resolved path, or `undefined` when `specifier` is not a file.
 */
function toAbsoluteFilePath(specifier: string): string | undefined {
  if (specifier.startsWith('file:')) {
    try {
      return fileURLToPath(specifier)
    } catch {
      return undefined
    }
  }
  if (isAbsolute(specifier) || specifier.startsWith('.')) return resolve(specifier)
  return undefined
}

/**
 * `mtimeMs.size` of `absolutePath`, used as the ESM cache generation. A
 * rewrite or `pnpm add` at the same specifier path changes at least one
 * field. Missing files return `undefined` and import without a query.
 * @param absolutePath - filesystem path of the payload entry.
 * @returns the query token, or `undefined` when `stat` fails.
 */
function payloadBustToken(absolutePath: string): string | undefined {
  try {
    const st = statSync(absolutePath)
    if (!st.isFile()) return undefined
    return `${String(st.mtimeMs)}.${String(st.size)}`
  } catch {
    return undefined
  }
}

/**
 * `import()` href for a payload specifier. File legs get a
 * {@link PAYLOAD_IMPORT_BUST_PARAM} query from the entry's mtime and size so
 * a remount after an in-place overwrite does not reuse the previous ESM
 * module. Bare specifiers are unchanged. {@link ShieldEngine.entry} stays the
 * resolved filesystem path; this href is only the `import()` argument.
 * @param specifier - absolute path, relative path, `file:` URL, or bare name.
 * @returns the href to pass to `import()`.
 */
export function fileImportHref(specifier: string): string {
  const absolute = toAbsoluteFilePath(specifier)
  if (absolute === undefined) return specifier
  const href = specifier.startsWith('file:') ? specifier : pathToFileURL(absolute).href
  // `toAbsoluteFilePath` already accepted this `file:` URL or `pathToFileURL`
  // produced it, so `new URL` cannot throw here.
  const url = new URL(href)
  const token = payloadBustToken(absolute)
  if (token === undefined) return url.href
  url.searchParams.set(PAYLOAD_IMPORT_BUST_PARAM, token)
  return url.href
}

/**
 * Copy {@link PAYLOAD_IMPORT_BUST_PARAM} from the parent file URL onto child
 * `file:` URLs. The paid payload is a multi-file graph (`dist/index.js`
 * imports `dist/harness/adapter.js`); a query on the entry alone leaves
 * children keyed by the un-queried path and the process keeps the old
 * adapter. Node builtins and parents without the param pass through.
 * @param specifier - unresolved child specifier.
 * @param context - resolve context; `parentURL` carries the entry query.
 * @param nextResolve - the rest of the resolve chain.
 * @returns the resolved URL, with the bust param copied when the parent has one.
 */
export function propagateShieldImportBust(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput,
): ResolveFnOutput {
  const resolved = nextResolve(specifier, context)
  const parent = context.parentURL
  if (parent === undefined || !resolved.url.startsWith('file:')) return resolved
  let token: string | null
  try {
    token = new URL(parent).searchParams.get(PAYLOAD_IMPORT_BUST_PARAM)
  } catch {
    return resolved
  }
  if (token === null || token.length === 0) return resolved
  const url = new URL(resolved.url)
  url.searchParams.set(PAYLOAD_IMPORT_BUST_PARAM, token)
  if (url.href === resolved.url) return resolved
  return { ...resolved, url: url.href }
}

registerHooks({ resolve: propagateShieldImportBust })

/**
 * `exports['.'].import` or `main` from a package.json object. The paid
 * payload publishes only the ESM `import` condition (no CJS `main`), so
 * `createRequire().resolve` misses it. String `exports` maps are left to
 * CJS resolve, which already accepts them.
 * @param pkg - parsed package.json object.
 * @returns the relative entry path, or `undefined` when none is declared.
 */
function packageImportEntry(pkg: object): string | undefined {
  const exportsField = (pkg as { exports?: unknown }).exports
  if (exportsField !== null && typeof exportsField === 'object') {
    const dot = (exportsField as { '.'?: unknown })['.']
    if (dot !== null && typeof dot === 'object') {
      const imp = (dot as { import?: unknown }).import
      if (typeof imp === 'string') return imp
    }
  }
  const main = (pkg as { main?: unknown }).main
  return typeof main === 'string' ? main : undefined
}

/**
 * Resolve an ESM-only payload from `profileDir/node_modules/<specifier>` by
 * reading that package's `exports['.'].import` (or `main`). Used when CJS
 * `createRequire().resolve` fails because the package has no `main`.
 * @param profileDir - the active profile directory.
 * @param specifier - the payload specifier.
 * @returns the absolute entry path, or `undefined` when the package or entry is missing.
 */
function resolveProfileExportEntry(profileDir: string, specifier: string): string | undefined {
  const pkgDir = join(profileDir, 'node_modules', ...specifier.split('/'))
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  try {
    const raw: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (raw === null || typeof raw !== 'object') return undefined
    if ((raw as { name?: unknown }).name !== specifier) return undefined
    const entry = packageImportEntry(raw)
    if (entry === undefined) return undefined
    const resolved = resolve(pkgDir, entry)
    return existsSync(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
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

/**
 * Un-queried `file:` href. {@link importSpecifier} retries this when the
 * busted URL throws, so a loader that rejects the query still loads the file.
 * @param specifier - the original specifier passed to {@link importSpecifier}.
 * @returns a `file:` href, or `specifier` when it is not a file.
 */
function rawFileHref(specifier: string): string {
  if (specifier.startsWith('file:')) return specifier
  const absolute = toAbsoluteFilePath(specifier)
  if (absolute === undefined) return specifier
  return pathToFileURL(absolute).href
}

async function importSpecifier(specifier: string): Promise<unknown> {
  const href = fileImportHref(specifier)
  try {
    return await import(href)
  } catch {
    const raw = rawFileHref(specifier)
    if (raw === href) return undefined
    try {
      return await import(raw)
    } catch {
      return undefined
    }
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
 * profile-local dependencies. When that CJS resolve fails (the paid package
 * publishes `exports.import` and no `main`), read the ESM export entry from
 * the profile-local `package.json`.
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
    return resolveProfileExportEntry(profileDir, specifier)
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
