/**
 * Verifier for the chain-env-propagate task.
 *
 * Resolved when (a) src/config.js exists and exports loadConfig, (b) loadConfig
 * returns correct defaults, respects env overrides, parses numbers, and
 * enforces required/optional semantics, and (c) `node --test` passes.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

const configPath = path.join(scratch, 'src/config.js')
if (!existsSync(configPath)) fail('src/config.js does not exist')

const mod = await import(pathToFileURL(configPath).href)
if (typeof mod.loadConfig !== 'function') fail('src/config.js does not export loadConfig')

const saved = { ...process.env }

try {
  delete process.env.PORT
  delete process.env.HOST
  delete process.env.DB_URL
  delete process.env.MAX_CONNECTIONS
  delete process.env.APP_SECRET
  delete process.env.LOG_LEVEL

  process.env.DB_URL = 'postgres://localhost/test'
  process.env.APP_SECRET = 'secret123'

  const cfg = mod.loadConfig()

  if (cfg.PORT !== 3000) fail(`PORT should be 3000, got ${cfg.PORT}`)
  if (cfg.MAX_CONNECTIONS !== 10 && cfg.MAX_CONNECTIONS !== null) fail(`MAX_CONNECTIONS should be 10 or null, got ${cfg.MAX_CONNECTIONS}`)
  if (cfg.DB_URL !== 'postgres://localhost/test') fail(`DB_URL should be overridden from env`)
  if (cfg.APP_SECRET !== 'secret123') fail(`APP_SECRET should be overridden from env`)

  if (typeof cfg.PORT !== 'number') fail(`PORT should be a number, got ${typeof cfg.PORT}`)

  delete process.env.DB_URL
  delete process.env.APP_SECRET
  let threw = false
  try { mod.loadConfig() } catch { threw = true }
  if (!threw) fail('loadConfig should throw when required vars are missing')

} finally {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, saved)
}

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: config loader with typed validation works, tests pass')
