/**
 * Verifier for the noise-needle task.
 *
 * Resolved when pinned tests still match the fixture, `tools/diagnose.js` is
 * unchanged, `node --test` passes, and REPORT.json's three needle fields match
 * the values the fixture script prints (the verifier runs that script and
 * parses the `[runtime-config]` lines).
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

/**
 * Parse the three runtime-config needles from diagnose stdout.
 * @param {string} stdout - script output.
 * @returns {{ buildId: string, cacheKey: string, authRealm: string }}
 */
function parseNeedles(stdout) {
  const buildId = stdout.match(/\[runtime-config\] build_id = (\S+)/)?.[1]
  const cacheKey = stdout.match(/\[runtime-config\] cache_key = (\S+)/)?.[1]
  const authRealm = stdout.match(/\[runtime-config\] auth_realm = (\S+)/)?.[1]
  if (!buildId || !cacheKey || !authRealm) fail('diagnose output is missing runtime-config needles')
  return { buildId, cacheKey, authRealm }
}

for (const rel of walk(fixture)) {
  const target = path.join(scratch, rel)
  if (rel.startsWith('test/') || rel === 'tools/diagnose.js' || rel === 'src/constants.js') {
    if (!existsSync(target)) fail(`${rel} is missing`)
    if (!readFileSync(target).equals(readFileSync(path.join(fixture, rel)))) {
      fail(`${rel} was modified`)
    }
  } else if (rel.startsWith('src/')) {
    if (!existsSync(target)) fail(`${rel} is missing`)
  }
}
if (!existsSync(path.join(scratch, 'src/sku.js'))) fail('src/sku.js is missing')

const diagnose = spawnSync(process.execPath, [path.join(fixture, 'tools/diagnose.js')], {
  cwd: scratch,
  encoding: 'utf8',
})
if (diagnose.status !== 0) fail('tools/diagnose.js failed to run')
const lines = diagnose.stdout.split(/\r?\n/).filter(line => line.length > 0)
if (lines.length !== 2000) fail(`diagnose printed ${lines.length} lines; expected 2000`)
const needles = parseNeedles(diagnose.stdout)
const needleAt = lines.findIndex(line => line.startsWith('[runtime-config]'))
if (needleAt < 1400 || needleAt > 1600) fail('runtime-config needles are not in the mid-dump window')

const reportFile = path.join(scratch, 'REPORT.json')
if (!existsSync(reportFile)) fail('REPORT.json is missing')
let report
try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'))
} catch {
  fail('REPORT.json is not valid JSON')
}
if (report?.buildId !== needles.buildId) fail(`REPORT.json buildId does not match diagnose output`)
if (report?.cacheKey !== needles.cacheKey) fail(`REPORT.json cacheKey does not match diagnose output`)
if (report?.authRealm !== needles.authRealm) fail(`REPORT.json authRealm does not match diagnose output`)
if (report?.ok !== true) fail('REPORT.json ok must be true')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: needles recorded, pinned tests pass')
