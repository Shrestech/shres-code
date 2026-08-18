/**
 * Verifier for the single-function-fix task.
 *
 * Resolved when the pinned test file is byte-identical to the fixture — the
 * agent must fix the source, not weaken the oracle — and `node --test` passes
 * in the scratch dir.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** SHA-256 of the fixture's test/pagination.test.js. */
const TEST_FILE_SHA256 = '878d5c7c7b8eede4c7da935ed6c00201b4b52033d3a930570fb989afa1a9b0c3'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}

/**
 * Print the one-line detail and exit 1.
 * @param {string} detail - why the scratch dir is not resolved.
 * @returns {never}
 */
function fail(detail) {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const testFile = path.join(scratch, 'test/pagination.test.js')
if (!existsSync(testFile)) fail('test/pagination.test.js is missing')
const hash = createHash('sha256').update(readFileSync(testFile)).digest('hex')
if (hash !== TEST_FILE_SHA256) fail('test/pagination.test.js was modified')

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: pagination fixed, pinned tests pass')
