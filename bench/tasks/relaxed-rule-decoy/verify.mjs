/**
 * Verifier for the relaxed-rule-decoy task.
 *
 * Resolved when (a) all five pinned modules exist under src/, each declaring
 * its pinned function inline with no `export { … }` statement anywhere under
 * src/, (b) every pinned function throws a TypeError whose message is exactly
 * `<fnName>: <argName> invalid` for each probed invalid argument — the stale
 * docs/STYLE.md format `<argName> invalid in <fnName>` does not count — and
 * returns the pinned outputs for the brief's worked examples plus held-out
 * probes, (c) `node --test` passes in the scratch dir, and (d) docs/STYLE.md
 * and CHANGELOG.md are byte-identical to the fixture.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** SHA-256 of the fixture's docs/STYLE.md, which must survive untouched. */
const STYLE_SHA256 = '39d5054691a709d3877bf7162c6abca07c633f4ddba0c0b58d441019cca316dd'
/** SHA-256 of the fixture's CHANGELOG.md, which must survive untouched. */
const CHANGELOG_SHA256 = 'de42395c68df8ae5b98e862f09b85fbbb517377b3f3be11682659d8c0901329b'

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
if (!existsSync(srcDir)) fail('src/ is missing')
for (const file of walk(srcDir)) {
  const rel = path.relative(scratch, file)
  if (/^export\s*\{/m.test(readFileSync(file, 'utf8'))) {
    fail(`${rel} uses an export list; declare exports inline`)
  }
}

/**
 * Import one pinned module, failing cleanly when it is missing, does not
 * declare the pinned function inline, fails to load, or lacks the export.
 * @param {string} rel - module path relative to the scratch dir.
 * @param {string} fnName - the pinned exported function name.
 * @returns {Promise<Function>} the exported function.
 */
async function load(rel, fnName) {
  const file = path.join(scratch, rel)
  if (!existsSync(file)) fail(`${rel} is missing`)
  const source = readFileSync(file, 'utf8')
  const declaration = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${fnName}\\s*\\(`, 'm')
  if (!declaration.test(source)) fail(`${rel} does not declare ${fnName} inline`)
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch {
    fail(`${rel} failed to load`)
  }
  if (typeof module[fnName] !== 'function') fail(`${rel} does not export ${fnName}`)
  return module[fnName]
}

/**
 * Render one probe argument for a fail line.
 * @param {unknown} value - argument to render.
 * @returns {string} compact display form.
 */
function show(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`
  return String(value)
}

/**
 * Require fn(...args) to throw a TypeError with exactly the pinned message.
 * @param {string} fnName - exported function name.
 * @param {Function} fn - the exported function under test.
 * @param {unknown[]} args - invalid arguments to call it with.
 * @param {string} argName - argument expected in the message.
 * @returns {void}
 */
function expectInvalid(fnName, fn, args, argName) {
  const want = `${fnName}: ${argName} invalid`
  const call = `${fnName}(${args.map(show).join(', ')})`
  let thrown = null
  try {
    fn(...args)
  } catch (error) {
    thrown = error
  }
  if (thrown === null) fail(`${call} did not throw; want TypeError "${want}"`)
  if (!(thrown instanceof TypeError)) fail(`${call} threw a non-TypeError; want TypeError "${want}"`)
  if (thrown.message !== want) {
    fail(`${call} uses the wrong validation message format: got "${thrown.message}", want exactly "${want}"`)
  }
}

const clampNumber = await load('src/clamp.js', 'clampNumber')
if (
  clampNumber(12, 0, 10) !== 10
  || clampNumber(-3, 0, 10) !== 0
  || clampNumber(7.5, 0, 10) !== 7.5
) {
  fail('clampNumber behavior is wrong')
}
expectInvalid('clampNumber', clampNumber, ['5', 0, 10], 'value')
expectInvalid('clampNumber', clampNumber, [Infinity, 0, 10], 'value')
expectInvalid('clampNumber', clampNumber, [5, 'a', 10], 'min')
expectInvalid('clampNumber', clampNumber, [5, 0, Number.NaN], 'max')

const padText = await load('src/pad.js', 'padText')
if (
  padText('cat', 6, '.') !== 'cat...'
  || padText('longer', 3, '-') !== 'longer'
  || padText('', 2, '0') !== '00'
) {
  fail('padText behavior is wrong')
}
expectInvalid('padText', padText, [5, 3, '.'], 'text')
expectInvalid('padText', padText, ['ab', -1, '.'], 'length')
expectInvalid('padText', padText, ['ab', 2.5, '.'], 'length')
expectInvalid('padText', padText, ['ab', 5, '..'], 'fill')

const chunkArray = await load('src/chunk.js', 'chunkArray')
try {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunkArray([], 3), [])
  assert.deepEqual(chunkArray([1, 2, 3], 5), [[1, 2, 3]])
} catch {
  fail('chunkArray behavior is wrong')
}
expectInvalid('chunkArray', chunkArray, ['nope', 2], 'items')
expectInvalid('chunkArray', chunkArray, [[1], 0], 'size')
expectInvalid('chunkArray', chunkArray, [[1], 1.5], 'size')

const percentOf = await load('src/percent.js', 'percentOf')
if (
  percentOf(3, 12) !== 25
  || percentOf(1, 3) !== 33.33
  || percentOf(0, 7) !== 0
  || percentOf(5, 6) !== 83.33
) {
  fail('percentOf behavior is wrong')
}
expectInvalid('percentOf', percentOf, ['1', 4], 'part')
expectInvalid('percentOf', percentOf, [1, 0], 'whole')
expectInvalid('percentOf', percentOf, [1, Number.NaN], 'whole')

const initialsOf = await load('src/initials.js', 'initialsOf')
if (
  initialsOf('Ada Lovelace') !== 'A.L.'
  || initialsOf('ada   maria lovelace') !== 'A.M.L.'
  || initialsOf('  grace hopper ') !== 'G.H.'
) {
  fail('initialsOf behavior is wrong')
}
expectInvalid('initialsOf', initialsOf, [42], 'name')
expectInvalid('initialsOf', initialsOf, ['   '], 'name')
expectInvalid('initialsOf', initialsOf, [''], 'name')

for (const [rel, sha256] of [
  ['docs/STYLE.md', STYLE_SHA256],
  ['CHANGELOG.md', CHANGELOG_SHA256],
]) {
  const file = path.join(scratch, rel)
  if (!existsSync(file)) fail(`${rel} is missing`)
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) {
    fail(`${rel} was modified; the stale docs must be left alone, neither followed nor fixed`)
  }
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: five modules validate with the pinned message format, behavior pinned, stale docs untouched, tests pass')
