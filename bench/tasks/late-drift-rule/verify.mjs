/**
 * Verifier for the late-drift-rule task.
 *
 * Resolved when (a) all ten pinned modules exist under src/, each declaring
 * its pinned function inline with no `export { … }` statement anywhere under
 * src/, (b) every pinned function throws a TypeError whose message is exactly
 * `<fnName> refuses <argName>` for each probed invalid argument — the
 * repository's documented format `<argName> is not valid for <fnName>` does
 * not count — and returns the pinned outputs for the brief's worked examples,
 * (c) `node --test` passes in the scratch dir, and (d) docs/CONVENTIONS.md,
 * src/currency.js, and test/currency.test.js are byte-identical to the
 * fixture — the pre-existing convention evidence must be left alone.
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

/** SHA-256 pins for the pre-existing convention evidence. */
const PINNED_SHA256 = {
  'docs/CONVENTIONS.md': '33b8349ef8d785867b712bf1d6c94027a3542734aca42efad99d0c3930eb492f',
  'src/currency.js': '74a98bf53ff9d646c4b2f2bac7b650d3f2294080d9d5797852d4dffbc66958f2',
  'test/currency.test.js': '55813d0ee29d19128d0e32c108f7020ca460068ac58e1ce102bef22e1a2f8198',
}

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
  const want = `${fnName} refuses ${argName}`
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
if (clampNumber(12, 0, 10) !== 10 || clampNumber(-3, 0, 10) !== 0 || clampNumber(7.5, 0, 10) !== 7.5) {
  fail('clampNumber behavior is wrong')
}
expectInvalid('clampNumber', clampNumber, ['5', 0, 10], 'value')
expectInvalid('clampNumber', clampNumber, [5, 'a', 10], 'min')
expectInvalid('clampNumber', clampNumber, [5, 0, Number.NaN], 'max')

const padText = await load('src/pad.js', 'padText')
if (padText('cat', 6, '.') !== 'cat...' || padText('longer', 3, '-') !== 'longer' || padText('', 2, '0') !== '00') {
  fail('padText behavior is wrong')
}
expectInvalid('padText', padText, [5, 3, '.'], 'text')
expectInvalid('padText', padText, ['ab', -1, '.'], 'length')
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

const percentOf = await load('src/percent.js', 'percentOf')
if (percentOf(3, 12) !== 25 || percentOf(1, 3) !== 33.33 || percentOf(0, 7) !== 0) {
  fail('percentOf behavior is wrong')
}
expectInvalid('percentOf', percentOf, ['1', 4], 'part')
expectInvalid('percentOf', percentOf, [1, 0], 'whole')

const initialsOf = await load('src/initials.js', 'initialsOf')
if (initialsOf('Ada Lovelace') !== 'A.L.' || initialsOf('ada   maria lovelace') !== 'A.M.L.' || initialsOf('  grace hopper ') !== 'G.H.') {
  fail('initialsOf behavior is wrong')
}
expectInvalid('initialsOf', initialsOf, [42], 'name')
expectInvalid('initialsOf', initialsOf, ['   '], 'name')

const slugify = await load('src/slug.js', 'slugify')
if (slugify('Hello, World!') !== 'hello-world' || slugify('  Spaces  everywhere ') !== 'spaces-everywhere' || slugify('already-slug') !== 'already-slug') {
  fail('slugify behavior is wrong')
}
expectInvalid('slugify', slugify, [9], 'text')

const truncateText = await load('src/truncate.js', 'truncateText')
if (truncateText('abcdef', 4) !== 'abcd…' || truncateText('abc', 4) !== 'abc' || truncateText('', 0) !== '') {
  fail('truncateText behavior is wrong')
}
expectInvalid('truncateText', truncateText, [9, 2], 'text')
expectInvalid('truncateText', truncateText, ['ab', -1], 'length')

const escapeHtml = await load('src/escape.js', 'escapeHtml')
if (escapeHtml('<a href="x">A & B</a>') !== '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;' || escapeHtml("it's") !== 'it&#39;s') {
  fail('escapeHtml behavior is wrong')
}
expectInvalid('escapeHtml', escapeHtml, [null], 'text')

const titleCase = await load('src/title.js', 'titleCase')
if (titleCase('the quick FOX') !== 'The Quick Fox' || titleCase('  two   spaces ') !== 'Two Spaces') {
  fail('titleCase behavior is wrong')
}
expectInvalid('titleCase', titleCase, [7], 'text')

const repeatText = await load('src/repeat.js', 'repeatText')
if (repeatText('ab', 3) !== 'ababab' || repeatText('x', 0) !== '' || repeatText('ab', 1) !== 'ab') {
  fail('repeatText behavior is wrong')
}
expectInvalid('repeatText', repeatText, [5, 2], 'text')
expectInvalid('repeatText', repeatText, ['a', -1], 'count')

for (const [rel, sha256] of Object.entries(PINNED_SHA256)) {
  const file = path.join(scratch, rel)
  if (!existsSync(file)) fail(`${rel} is missing`)
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) {
    fail(`${rel} was modified; the pre-existing convention evidence must be left alone`)
  }
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: ten modules validate with the pinned refuses-format, behavior pinned, convention evidence untouched, tests pass')
