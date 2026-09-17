/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveShresHome } from '@shres-code/shres-code-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly root: string
  readonly profile: string
  readonly lock: string
  readonly pnpm: {
    readonly root: string
    readonly store: string
    readonly cache: string
    readonly state: string
    readonly config: string
    readonly home: string
  }
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param shresHome - Harness home shared with an npm-installed shres.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(shresHome: string = resolveShresHome()): DesktopPaths {
  const root = join(shresHome, 'desktop')
  const pnpm = join(root, 'pnpm')
  return {
    root,
    profile: join(shresHome, 'profiles', 'desktop'),
    lock: join(shresHome, 'profiles', 'desktop', 'lock'),
    pnpm: {
      root: pnpm,
      store: join(pnpm, 'store'),
      cache: join(pnpm, 'cache'),
      state: join(pnpm, 'state'),
      config: join(pnpm, 'config'),
      home: join(pnpm, 'home'),
    },
  }
}
