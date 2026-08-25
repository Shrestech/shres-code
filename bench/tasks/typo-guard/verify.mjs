/**
 * Verifier for the typo-guard task.
 *
 * Resolved when the test file is byte-identical to the fixture and
 * `node --test` passes in the scratch dir.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

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

const testFile = path.join(scratch, 'test/labels.test.js')
if (!existsSync(testFile)) fail('test/labels.test.js is missing')
const fixtureTest = readFileSync(new URL('./fixture/test/labels.test.js', import.meta.url))
const scratchTest = readFileSync(testFile)
if (!fixtureTest.equals(scratchTest)) fail('test/labels.test.js was modified')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: typos fixed, tests pass')
