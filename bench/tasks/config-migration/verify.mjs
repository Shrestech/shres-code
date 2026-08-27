/**
 * Verifier for the config-migration task.
 *
 * Resolved when (a) config.json has the nested structure with no flat keys,
 * (b) the test file is byte-identical to the fixture, and (c) `node --test`
 * passes in the scratch dir.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

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

const configPath = path.join(scratch, 'config.json')
if (!existsSync(configPath)) fail('config.json is missing')
const config = JSON.parse(readFileSync(configPath, 'utf8'))

if (typeof config.database !== 'object' || config.database === null) fail('config.json missing database section')
if (config.database.host !== 'localhost') fail('database.host wrong')
if (config.database.port !== 5432) fail('database.port wrong')
if (config.database.name !== 'appdb') fail('database.name wrong')

if (typeof config.cache !== 'object' || config.cache === null) fail('config.json missing cache section')
if (config.cache.ttl !== 3600) fail('cache.ttl wrong')
if (config.cache.maxSize !== 1000) fail('cache.maxSize wrong')

if (typeof config.app !== 'object' || config.app === null) fail('config.json missing app section')
if (config.app.name !== 'my-service') fail('app.name wrong')
if (config.app.port !== 8080) fail('app.port wrong')

const flatKeys = ['db_host', 'db_port', 'db_name', 'cache_ttl', 'cache_max_size', 'app_name', 'app_port']
for (const key of flatKeys) {
  if (key in config) fail(`flat key "${key}" still present in config.json`)
}

const testFile = path.join(scratch, 'test/config.test.js')
if (!existsSync(testFile)) fail('test/config.test.js is missing')
const fixtureTest = readFileSync(new URL('./fixture/test/config.test.js', import.meta.url))
const scratchTest = readFileSync(testFile)
if (!fixtureTest.equals(scratchTest)) fail('test/config.test.js was modified')

const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID
const suite = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8', env })
if (suite.status !== 0) fail('node --test failed')

console.log('ok: config migrated to nested structure, all code updated, tests pass')
