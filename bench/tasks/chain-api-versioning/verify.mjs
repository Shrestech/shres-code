/**
 * Verifier for the chain-api-versioning task.
 *
 * Resolved when (a) v2 routes work, (b) v1 routes return redirects,
 * (c) migration-log.json exists, (d) /v2/migration-status works,
 * (e) /v1/migration-status returns error, and (f) `node --test` passes.
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

const routerPath = path.join(scratch, 'src/router.js')
if (!existsSync(routerPath)) fail('src/router.js is missing')

const router = await import(pathToFileURL(routerPath).href)
if (typeof router.handleRequest !== 'function') fail('src/router.js does not export handleRequest')

const v2Users = router.handleRequest('GET', '/v2/users')
if (!v2Users || !v2Users.body || !Array.isArray(v2Users.body.users)) {
  fail('GET /v2/users should return users array')
}

const v1Users = router.handleRequest('GET', '/v1/users')
if (!v1Users || !v1Users.body || !v1Users.body.redirect) {
  fail('GET /v1/users should return a redirect')
}
if (!v1Users.body.redirect.includes('/v2/users')) {
  fail('v1 redirect should point to /v2/users')
}

const logPath = path.join(scratch, 'migration-log.json')
if (!existsSync(logPath)) fail('migration-log.json is missing')
const log = JSON.parse(readFileSync(logPath, 'utf8'))
if (!Array.isArray(log) || log.length === 0) fail('migration-log.json should be a non-empty array')
if (!log[0].from || !log[0].to) fail('migration-log entries need from/to fields')

const migStatus = router.handleRequest('GET', '/v2/migration-status')
if (!migStatus || !migStatus.body || typeof migStatus.body.migrated !== 'number') {
  fail('GET /v2/migration-status should return { migrated: <number> }')
}
if (migStatus.body.migrated !== log.length) {
  fail('migration-status.migrated should match migration-log.json length')
}

const v1MigStatus = router.handleRequest('GET', '/v1/migration-status')
if (!v1MigStatus || !v1MigStatus.body || !v1MigStatus.body.error) {
  fail('GET /v1/migration-status should return an error object')
}

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: API versioning with migration-status endpoint works, tests pass')
