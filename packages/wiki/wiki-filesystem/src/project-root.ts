/**
 * `.git`-walk project root used to resolve a relative wiki root.
 *
 * @module @shres-code/shres-code-wiki-filesystem/project-root
 */

import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Walk from `cwd` toward the filesystem root and return the first directory
 * that contains `.git`. When none exists, `cwd` itself is the project root.
 * @param cwd - absolute directory to start from.
 * @returns the discovered project root.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Whether a host path exists.
 * @param path - candidate path.
 * @returns true when `access` succeeds.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // Missing host paths are expected while walking toward the filesystem root.
    return false
  }
}
