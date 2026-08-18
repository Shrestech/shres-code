/**
 * Verifier for the multi-file-rename task.
 *
 * Resolved when the rename is complete: `src/url-slug.js` exists with its
 * original behavior, the old path `slugify.js` appears in no file, the test
 * file imports the new path, every single-line relative import specifier
 * resolves to an existing file, and `node --test` passes in the scratch dir.
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
 * List every file under a directory, skipping hidden entries and node_modules.
 * @param {string} dir - directory to walk.
 * @returns {string[]} absolute file paths.
 */
function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

/**
 * Extract single-line relative import/export specifiers from JS source.
 * @param {string} source - file contents.
 * @returns {string[]} specifiers starting with '.'.
 */
function relativeSpecifiers(source) {
  const pattern = /(?:import|export)\s[^'"]*?\bfrom\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]/g
  const specs = []
  for (const match of source.matchAll(pattern)) specs.push(match[1] ?? match[2])
  return specs
}

const newModule = path.join(scratch, 'src/url-slug.js')
if (!existsSync(newModule)) fail('src/url-slug.js is missing')
if (existsSync(path.join(scratch, 'src/slugify.js'))) fail('old module src/slugify.js still exists')

const files = walk(scratch)
for (const file of files) {
  if (readFileSync(file, 'utf8').includes('slugify.js')) {
    fail(`stale reference to slugify.js in ${path.relative(scratch, file)}`)
  }
}

const testFile = path.join(scratch, 'test/site.test.js')
if (!existsSync(testFile)) fail('test/site.test.js is missing')
if (!readFileSync(testFile, 'utf8').includes('url-slug.js')) {
  fail('test/site.test.js does not reference the renamed module')
}

for (const file of files) {
  if (!file.endsWith('.js')) continue
  for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
    if (!existsSync(path.resolve(path.dirname(file), spec))) {
      fail(`unresolved import '${spec}' in ${path.relative(scratch, file)}`)
    }
  }
}

const mod = await import(pathToFileURL(newModule).href)
if (typeof mod.slugify !== 'function' || typeof mod.isValidSlug !== 'function') {
  fail('src/url-slug.js no longer exports slugify/isValidSlug')
}
if (mod.slugify('Hello, World!') !== 'hello-world' || mod.isValidSlug('hello-world') !== true) {
  fail('renamed module behavior changed')
}

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: module renamed, references updated, tests pass')
