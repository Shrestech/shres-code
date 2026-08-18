/**
 * Verifier for the chain-debug-resume task.
 *
 * Resolved when (a) DIAGNOSIS.md exists at the scratch root and is non-empty,
 * (b) every fixture test file is byte-identical in the scratch dir — the
 * agent must fix the source, not weaken the oracle — (c) at least one file
 * under src/ differs from the fixture, and (d) `node --test` passes in the
 * scratch dir. Fixture comparison is against the fixture/ directory next to
 * this verifier, so the check tracks fixture edits automatically.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * List every file under a directory, relative paths, skipping hidden entries.
 * @param {string} dir - directory to walk.
 * @param {string} [prefix] - path prefix for recursion.
 * @returns {string[]} relative file paths.
 */
function walk(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) files.push(...walk(full, rel))
    else files.push(rel)
  }
  return files
}

const diagnosis = path.join(scratch, 'DIAGNOSIS.md')
if (!existsSync(diagnosis) || readFileSync(diagnosis, 'utf8').trim().length === 0) {
  fail('DIAGNOSIS.md is missing or empty')
}

let srcChanged = false
for (const rel of walk(fixture)) {
  const target = path.join(scratch, rel)
  if (rel.startsWith('src/')) {
    if (!existsSync(target)) fail(`${rel} is missing`)
    if (!readFileSync(target).equals(readFileSync(path.join(fixture, rel)))) srcChanged = true
  } else if (rel.startsWith('test/')) {
    if (!existsSync(target)) fail(`${rel} is missing`)
    if (!readFileSync(target).equals(readFileSync(path.join(fixture, rel)))) {
      fail(`${rel} was modified`)
    }
  }
}
if (!srcChanged) fail('src/ is unchanged from the starting state')

// Scrub test-runner markers: a nested `node --test` skips all files when it
// sees them, which happens when this verifier is spawned from a test file.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: diagnosis recorded, bug fixed in src/, pinned tests pass')
