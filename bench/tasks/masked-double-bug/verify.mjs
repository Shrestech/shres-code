/**
 * Verifier for the masked-double-bug task.
 *
 * Resolved when src/money.js still exports the pinned round2/lineTotal API,
 * the pinned test file is byte-identical to the fixture — the agent must fix
 * the source, not weaken the oracle — and `node --test` passes in the
 * scratch dir.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** SHA-256 of the fixture's test/cart.test.js. */
const TEST_FILE_SHA256 = '37c5ffa648beee338b0009a08f4233ad12f6cdccc0cc46c01547cc141d4f735a'

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

const moneyFile = path.join(scratch, 'src/money.js')
if (!existsSync(moneyFile)) fail('src/money.js is missing')
const money = await import(pathToFileURL(moneyFile).href)
if (typeof money.round2 !== 'function' || typeof money.lineTotal !== 'function') {
  fail('src/money.js no longer exports the round2/lineTotal API')
}
if (money.round2(1.234) !== 1.23 || money.lineTotal(2.5, 4, 0) !== 10) {
  fail('src/money.js exported API behavior changed')
}

const testFile = path.join(scratch, 'test/cart.test.js')
if (!existsSync(testFile)) fail('test/cart.test.js is missing')
const hash = createHash('sha256').update(readFileSync(testFile)).digest('hex')
if (hash !== TEST_FILE_SHA256) fail('test/cart.test.js was modified')

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) {
  // The runner records the last output line as the detail, so the suite tail
  // goes first and the one-line verdict stays last.
  console.log(`${suite.stdout}${suite.stderr}`.trimEnd().split('\n').slice(-12).join('\n'))
  fail('node --test failed')
}

console.log('ok: cart totals fixed, pinned tests pass')
