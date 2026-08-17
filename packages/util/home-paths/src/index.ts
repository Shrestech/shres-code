/**
 * Shared filesystem path helpers for Shres Code user data.
 *
 * @module @shres-code/shres-code-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default Shres Code home under the OS home. */
export const SHRES_HOME_DIR_NAME = '.shres'

/** Stable user-facing display form for the default Shres Code home. */
export const DEFAULT_SHRES_HOME_DISPLAY = `~/${SHRES_HOME_DIR_NAME}`

/** Environment variable that overrides the default Shres Code home. */
export const SHRES_HOME_ENV = 'SHRES_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default Shres Code home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultShresHome(): string {
  return join(homedir(), SHRES_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root Shres Code home.
 *
 * Precedence, highest first: an explicit configured path, `$SHRES_HOME`, then
 * `~/.shres`. The harness keeps all user data under one root. An empty or
 * whitespace-only `$SHRES_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `SHRES_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveShresHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[SHRES_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultShresHome())
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved Shres Code home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function shresHomePath(...segments: string[]): string {
  return join(resolveShresHome(), ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.shres`, and any configured home is labelled `$SHRES_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveShresHome}.
 * @returns `~/.shres` for the default home, otherwise `$SHRES_HOME`.
 */
export function shresHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultShresHome()) ? DEFAULT_SHRES_HOME_DISPLAY : `$${SHRES_HOME_ENV}`
}
