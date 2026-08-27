/**
 * Plant the one-time lease token stamp in the trial scratch dir.
 *
 * The token is not in any fixture source file. The issuer reads `.once`,
 * prints it, and deletes the stamp. The verifier imports {@link LEASE_TOKEN}.
 *
 * Usage: node setup.mjs <scratch-dir> <session-log-root>
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Lease token the issuer prints once and the verifier requires. */
export const LEASE_TOKEN = 'K7M-LEASE-9F2A'

/**
 * Write the one-time stamp the issuer consumes.
 * @param {string} scratchDir - trial scratch dir.
 * @returns {Promise<string>} absolute path of the stamp file.
 */
export async function plantLeaseStamp(scratchDir) {
  const toolsDir = join(scratchDir, 'tools')
  await mkdir(toolsDir, { recursive: true })
  const stamp = join(toolsDir, '.once')
  await writeFile(stamp, `${LEASE_TOKEN}\n`)
  return stamp
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedAsScript) {
  const scratchDir = process.argv[2]
  if (!scratchDir) {
    console.log('fail: usage: node setup.mjs <scratch-dir> <session-log-root>')
    process.exit(1)
  }
  const dest = await plantLeaseStamp(scratchDir)
  console.log(`ok: planted ${dest}`)
}
