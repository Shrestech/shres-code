/**
 * The harness version reported on the wire: the running package's own
 * `package.json` version, which workspace constraints pin to the root
 * version every app shares.
 * @module @shres-code/shres-code-host-apiproxy
 */

import { createRequire } from 'node:module'

/** Resolved once per process; describe runs often and the manifest never changes mid-process. */
let cached: string | undefined

/**
 * Read the harness version for `host.describe` from the package manifest.
 * @returns the package version, or `'0.0.1'` when the manifest is unreadable
 *   (packs without the manifest beside the module, or transient test imports).
 */
export function hostVersion(): string {
  if (cached === undefined) {
    try {
      cached = (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? '0.0.1'
    } catch (error) {
      // A missing manifest still answers describe: the placeholder marks an
      // unpacked build instead of failing the whole endpoint.
      void error
      cached = '0.0.1'
    }
  }
  return cached
}
