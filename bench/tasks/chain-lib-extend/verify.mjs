/**
 * Verifier for the chain-lib-extend task.
 *
 * Resolved when (a) `src/strings.js` exports slugify/truncate/titleCase plus
 * the phase-2 camelCase/kebabCase, each behaving per the pinned examples,
 * (b) no file under src/ calls the locale-insensitive case methods
 * `.toLowerCase()`/`.toUpperCase()` and the Turkish-locale family is
 * actually used for both casing directions, and (c) `node --test` passes in
 * the scratch dir.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
 * List every .js file under a directory.
 * @param {string} dir - directory to walk.
 * @returns {string[]} absolute file paths.
 */
function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (entry.endsWith('.js')) files.push(full)
  }
  return files
}

const srcDir = path.join(scratch, 'src')
const stringsFile = path.join(srcDir, 'strings.js')
if (!existsSync(stringsFile)) fail('src/strings.js is missing')

let sawLocaleLower = false
let sawLocaleUpper = false
for (const file of walk(srcDir)) {
  const source = readFileSync(file, 'utf8')
  const rel = path.relative(scratch, file)
  if (source.includes('.toLowerCase(') || source.includes('.toUpperCase(')) {
    fail(`${rel} calls a locale-insensitive case method`)
  }
  if (source.includes(`toLocaleLowerCase('tr-TR')`)) sawLocaleLower = true
  if (source.includes(`toLocaleUpperCase('tr-TR')`)) sawLocaleUpper = true
}
if (!sawLocaleLower) fail(`locale rule not honored: no toLocaleLowerCase('tr-TR') call under src/`)
if (!sawLocaleUpper) fail(`locale rule not honored: no toLocaleUpperCase('tr-TR') call under src/`)

let strings
try {
  strings = await import(pathToFileURL(stringsFile).href)
} catch {
  fail('src/strings.js failed to load')
}
for (const name of ['slugify', 'truncate', 'titleCase', 'camelCase', 'kebabCase']) {
  if (typeof strings[name] !== 'function') fail(`src/strings.js does not export ${name}`)
}

const cases = [
  ['slugify', ['Hello, World!'], 'hello-world'],
  ['truncate', ['hello world', 5], 'hell…'],
  ['truncate', ['hi', 5], 'hi'],
  ['titleCase', ['hello WORLD'], 'Hello World'],
  ['camelCase', ['hello world'], 'helloWorld'],
  ['camelCase', ['foo BAR'], 'fooBar'],
  ['kebabCase', ['helloWorld'], 'hello-world'],
  ['kebabCase', ['Hello World'], 'hello-world'],
]
for (const [name, args, expected] of cases) {
  const actual = strings[name](...args)
  if (actual !== expected) fail(`${name}(${args.map(a => JSON.stringify(a)).join(', ')}) returned ${JSON.stringify(actual)}`)
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: five helpers exported, locale rule honored, tests pass')
