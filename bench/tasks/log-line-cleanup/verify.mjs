/**
 * Verifier for the log-line-cleanup task.
 *
 * Resolved when (a) no console.log statements remain in src/ files,
 * (b) the test file is unmodified, and (c) `node --test` passes.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Recursively list JS files in a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function walkJs(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walkJs(full))
    else if (full.endsWith('.js')) files.push(full)
  }
  return files
}

const srcDir = path.join(scratch, 'src')
if (!existsSync(srcDir)) fail('src/ directory is missing')

for (const file of walkJs(srcDir)) {
  const content = readFileSync(file, 'utf8')
  if (/console\.log\s*\(/.test(content)) {
    fail(`console.log found in ${path.relative(scratch, file)}`)
  }
}

const testFile = path.join(scratch, 'test/main.test.js')
if (!existsSync(testFile)) fail('test/main.test.js is missing')
const fixtureTest = readFileSync(new URL('./fixture/test/main.test.js', import.meta.url))
const scratchTest = readFileSync(testFile)
if (!fixtureTest.equals(scratchTest)) fail('test/main.test.js was modified')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: all console.log removed from src/, tests pass')
