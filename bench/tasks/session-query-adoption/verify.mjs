/**
 * Verifier for session-query-adoption.
 *
 * Resolved when the pinned tests are unchanged, `node --test` passes, and
 * `src/origin.js` exports the origin-station code recorded in the planted
 * prior session (not a guessed substitute). Session-query adoption itself is
 * scored separately from the trial session log (`sessionQueryCalls` in
 * `foldSessionLog`).
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ORIGIN_STATION } from './setup.mjs'

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

const testFile = path.join(scratch, 'test/quote.test.js')
if (!existsSync(testFile)) fail('test/quote.test.js is missing')
const fixtureTest = readFileSync(new URL('./fixture/test/quote.test.js', import.meta.url))
const scratchTest = readFileSync(testFile)
if (!fixtureTest.equals(scratchTest)) fail('test/quote.test.js was modified')

const originFile = path.join(scratch, 'src/origin.js')
if (!existsSync(originFile)) fail('src/origin.js is missing')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

const { ORIGIN_STATION: shipped } = await import(pathToFileURL(originFile).href)
if (shipped !== ORIGIN_STATION) {
  fail(`ORIGIN_STATION must be the recorded prior-session code, got ${JSON.stringify(shipped)}`)
}

console.log('ok: origin station matches the prior-session record')
