/**
 * Verifier for the stale-notes-handoff task.
 *
 * Resolved when (a) STATE.json records the migrated contract — delimiter `;`,
 * `header: false`, status `done`; (b) src/transform.js behaviorally honors the
 * new contract (semicolon splitting, no header skip, double-quoted fields on
 * input) and its aggregate mode emits `key;total` lines in first-seen order,
 * quoting emitted keys that contain the delimiter; (c) the retired decoy
 * tests were replaced and `node --test` passes in the scratch dir; and (d)
 * docs/NOTES.md is byte-identical to the fixture — the stale doc stays as
 * evidence. The probe values never appear in the phase instructions, so
 * canned answers fail.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fixture = fileURLToPath(new URL('./fixture/', import.meta.url))

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

const state = /** @type {Record<string, unknown> | null} */ (readJson('STATE.json'))
if (state?.delimiter !== ';') fail(`STATE.json delimiter is ${JSON.stringify(state?.delimiter)}`)
if (state?.header !== false) fail(`STATE.json header is ${JSON.stringify(state?.header)}`)
if (state?.status !== 'done') fail(`STATE.json status is ${JSON.stringify(state?.status)}`)

const transformFile = path.join(scratch, 'src/transform.js')
if (!existsSync(transformFile)) fail('src/transform.js is missing')
let mod
try {
  mod = await import(pathToFileURL(transformFile).href)
} catch {
  fail('src/transform.js failed to load')
}
if (typeof mod.transformLines !== 'function') fail('src/transform.js does not export transformLines')
if (typeof mod.aggregateLines !== 'function') fail('src/transform.js does not export aggregateLines')

/**
 * Call a transformer export and require exactly the expected output lines.
 * @param {string} label - probe name for the failure line.
 * @param {(lines: string[]) => string[]} fn - export under test.
 * @param {string[]} input - raw input lines.
 * @param {string[]} expected - exact expected output lines.
 * @returns {void}
 */
function probe(label, fn, input, expected) {
  let actual
  try {
    actual = fn(input)
  } catch (error) {
    fail(`${label} threw: ${/** @type {Error} */ (error).message}`)
  }
  if (!Array.isArray(actual) || actual.length !== expected.length
    || !actual.every((line, index) => line === expected[index])) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// New-contract probes. None of these values appear in the phase instructions,
// so hardcoded answers fail.
probe('transformLines splits on semicolons and parses quoted fields',
  mod.transformLines,
  ['ki;wi;3', 'solo', '"na;me";7', 'xu;"q;z";9'],
  ['["ki","wi","3"]', '["solo"]', '["na;me","7"]', '["xu","q;z","9"]'])
probe('aggregateLines sums the second column per key in first-seen order',
  mod.aggregateLines,
  ['xu;2', 'li;4.5', 'xu;5', 'li;0.5'],
  ['xu;7', 'li;5'])
probe('aggregateLines quotes emitted keys containing the delimiter',
  mod.aggregateLines,
  ['"a;b";2', '"a;b";3'],
  ['"a;b";5'])

// Trap checks: the stale docs/NOTES.md contract must be gone.
probe('transformLines must not treat the first line as a header',
  mod.transformLines, ['a', 'b'], ['["a"]', '["b"]'])
probe('transformLines must not split on commas',
  mod.transformLines, ['x,y'], ['["x,y"]'])

const testsFile = path.join(scratch, 'test/transform.test.js')
if (!existsSync(testsFile)) fail('test/transform.test.js is missing')
if (readFileSync(testsFile).equals(readFileSync(path.join(fixture, 'test/transform.test.js')))) {
  fail('test/transform.test.js still holds the retired old-contract tests')
}

const notesFile = path.join(scratch, 'docs/NOTES.md')
if (!existsSync(notesFile)
  || !readFileSync(notesFile).equals(readFileSync(path.join(fixture, 'docs/NOTES.md')))) {
  fail('docs/NOTES.md was modified')
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: STATE.json done, new contract honored, stale docs untouched, tests green')
