/** Initialize a desktop-owned profile without replacing the user's configuration. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bundles in a new desktop profile, in composition order. */
export const DESKTOP_PROFILE_BUNDLES = ['@shres-code/shres-code-base', '@shres-code/shres-code-web-app'] as const

/**
 * Create a missing profile manifest. Existing manifests are validated by the host loader.
 * @param profileDir - writable desktop profile directory.
 * @param version - installed application version.
 * @returns nothing; filesystem errors other than an existing manifest propagate.
 */
export function ensureDesktopProfile(profileDir: string, version: string): void {
  mkdirSync(profileDir, { recursive: true })
  const manifest = {
    name: '@shres-code/shres-code-desktop-profile',
    version,
    private: true,
    dependencies: {},
    shres: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // The host loader owns validation of a profile that is already present.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
}
