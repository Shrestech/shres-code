/**
 * Verifier for compaction-pointer-follow.
 *
 * Resolved when the pinned tests are unchanged, `node --test` passes, the
 * issuer consumed its stamp, and `src/lease.js` exports the planted token.
 * Pointer-follow itself is scored separately from the trial session log
 * (`sessionQueryCalls` in `foldSessionLog`).
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LEASE_TOKEN } from './setup.mjs'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/**
 * @param {string} detail
 * @returns {never}
 */
function fail(detail) {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const testFiles = [
  'test/pad.test.js',
  'test/clip.test.js',
  'test/stamp.test.js',
  'test/wrap.test.js',
  'test/join.test.js',
  'test/lease.test.js',
]
for (const relative of testFiles) {
  const testFile = path.join(scratch, relative)
  if (!existsSync(testFile)) fail(`${relative} is missing`)
  const fixtureTest = readFileSync(new URL(`./fixture/${relative}`, import.meta.url))
  const scratchTest = readFileSync(testFile)
  if (!fixtureTest.equals(scratchTest)) fail(`${relative} was modified`)
}

if (existsSync(path.join(scratch, 'tools/.once'))) {
  fail('issuer stamp tools/.once was not consumed')
}
if (!existsSync(path.join(scratch, 'tools/.issued'))) {
  fail('issuer did not record tools/.issued')
}

const leaseFile = path.join(scratch, 'src/lease.js')
if (!existsSync(leaseFile)) fail('src/lease.js is missing')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

const { LEASE_TOKEN: shipped } = await import(pathToFileURL(leaseFile).href)
if (shipped !== LEASE_TOKEN) {
  fail(`LEASE_TOKEN must be the issued token, got ${JSON.stringify(shipped)}`)
}

console.log('ok: lease token matches the issued one-time stamp')
