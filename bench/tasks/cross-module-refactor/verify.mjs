/**
 * Verifier for the cross-module-refactor task.
 *
 * Resolved when (a) src/validate.js exists and exports isValidEmail and
 * isValidId with correct behavior, (b) src/users.js, src/orders.js, and
 * src/products.js no longer contain inline validation definitions,
 * (c) the test file is unmodified, and (d) `node --test` passes.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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

const validatePath = path.join(scratch, 'src/validate.js')
if (!existsSync(validatePath)) fail('src/validate.js does not exist')

const validate = await import(pathToFileURL(validatePath).href)
if (typeof validate.isValidEmail !== 'function') fail('src/validate.js does not export isValidEmail')
if (typeof validate.isValidId !== 'function') fail('src/validate.js does not export isValidId')

if (validate.isValidEmail('a@b.com') !== true) fail('isValidEmail("a@b.com") should be true')
if (validate.isValidEmail('bad') !== false) fail('isValidEmail("bad") should be false')
if (validate.isValidId('abcd') !== true) fail('isValidId("abcd") should be true')
if (validate.isValidId('!') !== false) fail('isValidId("!") should be false')

const callerFiles = ['src/users.js', 'src/orders.js', 'src/products.js']
for (const rel of callerFiles) {
  const content = readFileSync(path.join(scratch, rel), 'utf8')
  if (/function isValidEmail\s*\(/.test(content)) {
    fail(`${rel} still defines isValidEmail inline`)
  }
  if (/function isValidId\s*\(/.test(content)) {
    fail(`${rel} still defines isValidId inline`)
  }
}

const testFile = path.join(scratch, 'test/modules.test.js')
if (!existsSync(testFile)) fail('test/modules.test.js is missing')
const fixtureTest = readFileSync(new URL('./fixture/test/modules.test.js', import.meta.url))
const scratchTest = readFileSync(testFile)
if (!fixtureTest.equals(scratchTest)) fail('test/modules.test.js was modified')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: validation extracted to shared module, all callers updated, tests pass')
