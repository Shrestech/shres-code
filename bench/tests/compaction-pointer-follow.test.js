/**
 * Discrimination tests for compaction-pointer-follow: the fixture fails, a
 * perfect end state that consumed the issuer stamp passes, a guessed token
 * that satisfies the format still fails, and weakened tests fail.
 *
 * @module bench/tests/compaction-pointer-follow
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadTaskCatalog } from '../runner/run.js'
import { LEASE_TOKEN, plantLeaseStamp } from '../tasks/compaction-pointer-follow/setup.mjs'

const tasksDir = fileURLToPath(new URL('../tasks/', import.meta.url))
const TASK_ID = 'compaction-pointer-follow'
const taskDir = path.join(tasksDir, TASK_ID)

/**
 * Copy the task fixture into a fresh temp dir.
 * @returns {string} absolute path of the scratch dir.
 */
function copyFixture() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `bench-${TASK_ID}-`))
  cpSync(path.join(taskDir, 'fixture'), scratch, { recursive: true })
  return scratch
}

/**
 * Run the task verifier against a scratch dir.
 * @param {string} scratch - scratch dir to verify.
 * @returns {{ status: number | null, output: string }} exit status and combined output.
 */
function runVerifier(scratch) {
  const result = spawnSync(process.execPath, [path.join(taskDir, 'verify.mjs'), scratch], {
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * Write a correct helper implementation into scratch.
 * @param {string} scratch - scratch dir.
 * @returns {void}
 */
function writeHelpers(scratch) {
  writeFileSync(path.join(scratch, 'src/pad.js'), `export function padLeft(text, width) {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}
`)
  writeFileSync(path.join(scratch, 'src/clip.js'), `export function clip(text, max) {
  return text.length <= max ? text : text.slice(0, max)
}
`)
  writeFileSync(path.join(scratch, 'src/stamp.js'), `export function stamp(prefix, body) {
  return prefix + ':' + body
}
`)
  writeFileSync(path.join(scratch, 'src/wrap.js'), `export function wrap(text, left, right) {
  return left + text + right
}
`)
  writeFileSync(path.join(scratch, 'src/join.js'), `export function joinParts(parts, sep) {
  return parts.join(sep)
}
`)
}

/**
 * Consume the issuer stamp the way a successful trial does.
 * @param {string} scratch - scratch dir that already has tools/.once.
 * @returns {void}
 */
function consumeIssuer(scratch) {
  const result = spawnSync(process.execPath, [path.join(scratch, 'tools/issue-token.mjs')], {
    encoding: 'utf8',
    cwd: scratch,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), LEASE_TOKEN)
}

test('compaction-pointer-follow is in the catalog with setup', async () => {
  const tasks = await loadTaskCatalog(tasksDir)
  const task = tasks.find(entry => entry.taskId === TASK_ID)
  assert.ok(task, 'compaction-pointer-follow is in the catalog')
  assert.equal(task.setup, 'node setup.mjs')
  assert.equal(task.phases, null)
  const definition = JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf8'))
  assert.equal(definition.stratum, 'pressure')
})

test('compaction-pointer-follow: fixture and prompt omit the issued token', () => {
  const instruction = JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf8')).instruction
  assert.ok(!instruction.includes(LEASE_TOKEN), 'prompt must not contain the token')
  assert.ok(!instruction.includes('session_event_read'), 'prompt must not name the read tool')
  const fixtureText = [
    readFileSync(path.join(taskDir, 'fixture/src/lease.js'), 'utf8'),
    readFileSync(path.join(taskDir, 'fixture/tools/issue-token.mjs'), 'utf8'),
  ].join('\n')
  assert.ok(!fixtureText.includes(LEASE_TOKEN), 'fixture source must not contain the token')
})

test('compaction-pointer-follow: fixture fails, issued token passes', async (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  assert.equal(runVerifier(scratch).status, 1)

  await plantLeaseStamp(scratch)
  consumeIssuer(scratch)
  writeHelpers(scratch)
  writeFileSync(path.join(scratch, 'src/lease.js'), `export const LEASE_TOKEN = '${LEASE_TOKEN}'\n`)

  assert.equal(runVerifier(scratch).status, 0, runVerifier(scratch).output)
  assert.equal(runVerifier(scratch).status, 0)
})

test('compaction-pointer-follow: a guessed token that satisfies the tests still fails', async (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  await plantLeaseStamp(scratch)
  consumeIssuer(scratch)
  writeHelpers(scratch)
  writeFileSync(path.join(scratch, 'src/lease.js'), "export const LEASE_TOKEN = 'STATION-1'\n")

  const result = runVerifier(scratch)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /LEASE_TOKEN must be the issued token/)
})

test('compaction-pointer-follow: helpers without the issuer stamp fail', async (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  writeHelpers(scratch)
  writeFileSync(path.join(scratch, 'src/lease.js'), `export const LEASE_TOKEN = '${LEASE_TOKEN}'\n`)

  const result = runVerifier(scratch)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /tools\/\.issued/)
})

test('compaction-pointer-follow: an unconsumed stamp fails even with the right token', async (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  await plantLeaseStamp(scratch)
  writeHelpers(scratch)
  writeFileSync(path.join(scratch, 'src/lease.js'), `export const LEASE_TOKEN = '${LEASE_TOKEN}'\n`)

  const result = runVerifier(scratch)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /tools\/\.once/)
})

test('compaction-pointer-follow: weakening the pinned tests fails', async (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  await plantLeaseStamp(scratch)
  consumeIssuer(scratch)
  writeHelpers(scratch)
  writeFileSync(path.join(scratch, 'src/lease.js'), `export const LEASE_TOKEN = '${LEASE_TOKEN}'\n`)
  writeFileSync(path.join(scratch, 'test/lease.test.js'), 'import { test } from \'node:test\'\ntest(\'skip\', () => {})\n')

  const result = runVerifier(scratch)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /was modified/)
})

test('compaction-pointer-follow: setup plants the stamp and the issuer consumes it once', async (t) => {
  const scratch = copyFixture()
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), 'bench-pointer-sessions-'))
  t.after(() => rmSync(sessionRoot, { recursive: true, force: true }))

  const setup = spawnSync(
    process.execPath,
    [path.join(taskDir, 'setup.mjs'), scratch, sessionRoot],
    { encoding: 'utf8' },
  )
  assert.equal(setup.status, 0, setup.stderr)
  assert.match(setup.stdout, /ok: planted/)
  consumeIssuer(scratch)
  const second = spawnSync(process.execPath, [path.join(scratch, 'tools/issue-token.mjs')], {
    encoding: 'utf8',
    cwd: scratch,
  })
  assert.notEqual(second.status, 0)
  assert.match(`${second.stdout}${second.stderr}`, /already issued/)
})
