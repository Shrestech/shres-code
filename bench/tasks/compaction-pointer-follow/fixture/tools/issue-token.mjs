/**
 * Print a one-time lease token and consume the stamp.
 *
 * Usage: node tools/issue-token.mjs
 *
 * @module
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const stamp = fileURLToPath(new URL('./.once', import.meta.url))
const issued = fileURLToPath(new URL('./.issued', import.meta.url))
if (!existsSync(stamp)) {
  console.error('fail: lease token already issued')
  process.exit(1)
}
const token = readFileSync(stamp, 'utf8').trim()
unlinkSync(stamp)
writeFileSync(issued, '1\n')
console.log(token)
