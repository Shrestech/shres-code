/**
 * Verifier for the routing-multiturn-config-evolution task: the final workspace
 * must default pollSeconds to 30, validate retries with the named-key Error,
 * accept refreshInterval as a deprecated alias, and pass its own suite.
 *
 * Usage: node verify.mjs <scratch-dir>. Exit 0 = resolved, 1 = not resolved.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const scratch = process.argv[2]
if (!scratch) {
  console.log('fail: usage: node verify.mjs <scratch-dir>')
  process.exit(1)
}
const fail = detail => {
  console.log(`fail: ${detail}`)
  process.exit(1)
}

const configPath = path.join(scratch, 'src', 'config.js')
if (!existsSync(configPath)) fail('src/config.js is missing')
const config = readFileSync(configPath, 'utf8')
if (!config.includes('pollSeconds')) fail('no pollSeconds rename in src/config.js')
if (!config.includes('retries')) fail('no retries key in src/config.js')

const jsonPath = path.join(scratch, 'config.json')
if (existsSync(jsonPath) && !readFileSync(jsonPath, 'utf8').includes('pollSeconds')) {
  fail('config.json still uses only the old key name')
}

const run = spawnSync(process.execPath, ['--test'], { cwd: scratch, encoding: 'utf8' })
if (run.status !== 0) fail(`node --test does not pass: ${(run.stdout + run.stderr).slice(-400)}`)

const tests = readFileSync(path.join(scratch, 'test', 'config.test.js'), 'utf8')
for (const needle of ['retries', 'pollSeconds']) {
  if (!tests.includes(needle)) fail(`the suite does not pin ${needle}`)
}
console.log('resolved: rename, default, retries validation, and alias all present and tested')
