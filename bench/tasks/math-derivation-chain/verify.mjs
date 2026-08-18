/**
 * Verifier for the math-derivation-chain task.
 *
 * Resolved when (a) `src/evaluate.js` exports an `evaluate` that matches the
 * pinned examples, (b) `node --test` passes in the scratch dir, (c)
 * INTERMEDIATE.json holds the three correct intermediates (a=29, b=9, c=5),
 * and (d) answer.json holds `a * b + c / a` within 1e-9.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Correct values of the three pinned expressions. */
const EXPECTED = { a: 29, b: 9, c: 5 }
/** Expected final answer: a * b + c / a for the pinned intermediates. */
const EXPECTED_RESULT = EXPECTED.a * EXPECTED.b + EXPECTED.c / EXPECTED.a

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

/**
 * Read and parse a JSON file in the scratch dir.
 * @param {string} rel - path relative to the scratch dir.
 * @returns {unknown} parsed JSON.
 */
function readJson(rel) {
  const file = path.join(scratch, rel)
  if (!existsSync(file)) fail(`${rel} is missing`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    fail(`${rel} is not valid JSON`)
  }
}

const evaluateFile = path.join(scratch, 'src/evaluate.js')
if (!existsSync(evaluateFile)) fail('src/evaluate.js is missing')
let mod
try {
  mod = await import(pathToFileURL(evaluateFile).href)
} catch {
  fail('src/evaluate.js failed to load')
}
if (typeof mod.evaluate !== 'function') fail('src/evaluate.js does not export evaluate')

const cases = [
  ['2 + 3 * (4 + 5)', 29],
  ['(18 - 6) / 4 + 2 * 3', 9],
  ['100 / (2 + 3) / 4', 5],
  ['-(2 + 3) * 4', -20],
  [' 10 /4 ', 2.5],
]
for (const [expression, expected] of cases) {
  const actual = mod.evaluate(expression)
  if (Math.abs(actual - expected) > 1e-9) {
    fail(`evaluate(${JSON.stringify(expression)}) returned ${actual}`)
  }
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

const intermediate = readJson('INTERMEDIATE.json')
for (const key of ['a', 'b', 'c']) {
  if (typeof intermediate?.[key] !== 'number'
    || Math.abs(intermediate[key] - EXPECTED[key]) > 1e-9) {
    fail(`INTERMEDIATE.json has wrong ${key}: ${JSON.stringify(intermediate?.[key])}`)
  }
}

const answer = readJson('answer.json')
if (typeof answer?.result !== 'number'
  || Math.abs(answer.result - EXPECTED_RESULT) > 1e-9) {
  fail(`answer.json has wrong result: ${JSON.stringify(answer?.result)} (expected ${EXPECTED_RESULT})`)
}

console.log('ok: evaluator built, intermediates recorded, final answer correct')
