/**
 * Record or structurally verify the real CLI's keyless tool-error fixture.
 * Requires installed workspace links and build outputs. Three real CLI spawns
 * use the repository mock server and never edit the produced session bytes.
 * Only --record replaces the checked-in fixture; --check compares behavior.
 * @module
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { executeTrial, resolveHarnessLaunch } from '../../runner/execute.js'
import { getArm, renderArmOverlay } from '../../runner/arms.js'
import { decodeStorageRecord } from '../../../packages/core/session/lib/index.js'
import { ESCALATION_TRIGGERS, foldEscalationTriggers } from '../../../packages/team/progress-signals/lib/index.js'

const mode = process.argv[2]
if (!['--record', '--check'].includes(mode)) throw new Error('use --record or --check with the built harness')
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./replay-c-label-windows.session.jsonl', import.meta.url))
const sequence = 'success,tool_call_success,tool_call_success,success,success'
const tool = { name: 'read', arguments: JSON.stringify({ file_path: 'missing-replay-fixture.txt' }) }
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(key)))
const launch = resolveHarnessLaunch(repo)
const root = await mkdtemp(join(tmpdir(), 'bench-label-real-cli-'))
const records = []
let parseError
let stderr = ''
const stubArgs = [...launch.argsPrefix.slice(0, 2), join(repo, 'packages/test-support/llm-mock-server/src/bin.ts'), '--port', '0', '--api-key', 'bench-stub', '--sequence', sequence, '--tool-name', tool.name, '--tool-arguments', tool.arguments]
const child = spawn(launch.command, stubArgs, { cwd: repo, env: { ...env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
const closed = new Promise(resolve => child.once('close', resolve))
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536) })
let resolveReady
let rejectReady
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
const timer = setTimeout(() => rejectReady(new Error('mock server did not become ready')), 15000)
child.once('error', rejectReady)
child.once('close', code => rejectReady(new Error('mock server exited before ready: ' + code)))
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  try {
    const record = JSON.parse(line)
    records.push(record)
    if (record.type === 'ready') resolveReady(record)
  } catch (error) {
    parseError = error
    rejectReady(error)
  }
})
function decode(bytes) {
  return bytes.toString('utf8').trimEnd().split(String.fromCharCode(10)).flatMap(line => {
    const value = JSON.parse(line)
    return value.type === 'session' ? [] : decodeStorageRecord(value)
  })
}
const triggers = Object.fromEntries(ESCALATION_TRIGGERS.map(name => [name, { enabled: name === 'errorBurst', threshold: 2 }]))
function structure(events) {
  const starts = events.filter(e => e.type === 'step/start' && e.data.step === 1)
  assert.equal(starts.length, 3)
  assert.equal(events.filter(e => e.type === 'turn/end').length, 3)
  const turns = starts.map(e => e.data.turn)
  const tools = turns.map(turn => events.filter(e => e.type === 'tool/call' && e.data.turn === turn))
  const results = turns.map(turn => events.filter(e => e.type === 'tool/result' && e.data.turn === turn))
  assert.deepEqual(tools.map(items => items.length), [0, 2, 0])
  assert.deepEqual(results.map(items => items.length), [0, 2, 0])
  assert.ok(tools[1].every(e => e.data.name === tool.name))
  assert.ok(results[1].every(e => e.data.message.content[0].isError === true))
  assert.ok(results[1].every(e => JSON.stringify(e.data.message).includes('missing-replay-fixture.txt')))
  const before = events.filter(e => e.seq < starts[1].seq)
  assert.equal(foldEscalationTriggers(before, triggers, -1).find(v => v.trigger === 'errorBurst').fired, false)
  const middle = events.filter(e => e.seq < starts[2].seq)
  const burst = foldEscalationTriggers(middle, triggers, -1).find(v => v.trigger === 'errorBurst')
  assert.equal(burst.fired, true)
  assert.ok(burst.triggerSeq >= starts[1].seq && burst.triggerSeq < starts[2].seq)
  assert.ok(!events.some(e => e.type.startsWith('escalation/') || e.type.startsWith('model-routing/')))
  return { turns: starts.length, tools: tools.map(items => items.length), errors: results.map(items => items.filter(e => e.data.message.content[0].isError).length) }
}
try {
  const server = await ready
  clearTimeout(timer)
  const cwd = join(root, 'cwd')
  const home = join(root, 'home')
  const sessionRoot = join(root, 'sessions')
  await mkdir(cwd)
  await mkdir(home)
  const overlayPath = join(root, 'off.patch.yml')
  await writeFile(overlayPath, renderArmOverlay(getArm('off'), { sessionLogRoot: sessionRoot }))
  const extraPatchPaths = [join(repo, 'bench/tests/fixtures/real-cli/stub-deepseek.patch.yml')]
  let logPath
  for (let index = 0; index < 3; index++) {
    const result = await executeTrial({ repoRoot: repo, overlayPath, extraPatchPaths, sessionArgs: [index === 0 ? '--session-id' : '--resume', 'bench-replay-c-label-windows'], taskText: 'Run fixture turn ' + (index + 1), scratchDir: cwd, sessionLogRoot: sessionRoot, timeoutMs: 60000, env: { ...env, SHRES_HOME: home, BENCH_STUB_BASE_URL: server.baseURL, BENCH_STUB_KEY: 'bench-stub' } })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.timedOut, false)
    if (index > 0) assert.equal(result.sessionLogPath, logPath)
    logPath = result.sessionLogPath
  }
  assert.ifError(parseError)
  assert.equal(records.filter(record => record.type === 'request').length, 5)
  const bytes = await readFile(logPath)
  const summary = structure(decode(bytes))
  if (mode === '--check') {
    assert.deepEqual(structure(decode(await readFile(fixture))), summary)
  } else {
    await cp(logPath, fixture)
    assert.ok(bytes.equals(await readFile(fixture)))
    const provenance = { source: 'real-cli/off-arm/loopback-stub', sequence, tool, commands: { stub: stubArgs, harness: launch.argsPrefix, sessionFlags: ['--session-id', '--resume', '--resume'] }, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), node: process.version, sha256: createHash('sha256').update(bytes).digest('hex'), summary }
    await writeFile(fixture.replace('.session.jsonl', '.provenance.json'), JSON.stringify(provenance, null, 2) + String.fromCharCode(10))
  }
  console.log(JSON.stringify({ mode, ...summary, requests: 5 }))
} finally {
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await closed
  clearTimeout(killTimer)
  lines.close()
  await rm(root, { recursive: true, force: true })
}
