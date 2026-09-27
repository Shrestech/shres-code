/**
 * Keyless real two-spawn CLI regression through executeTrial against the
 * repo's mock:llm subprocess. No credentials, no routing, no product APIs.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { executeTrial } from '../runner/execute.js'
import { getArm, renderArmOverlay } from '../runner/arms.js'
import { foldSessionLog } from '../runner/metrics.js'
import { sessionLogPath } from '../runner/session-layout.js'
import { main } from '../runner/run.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STUB_OVERLAY = fileURLToPath(new URL('./fixtures/real-cli/stub-deepseek.patch.yml', import.meta.url))
const MOCK_BIN = join(REPO_ROOT, 'packages/test-support/llm-mock-server/src/bin.ts')
const GAP_MS = 1500
const SESSION_ID = 'bench-real-cli-two-spawn'
const KEEP = new Set()

function requireBuiltHarness() {
  const typert = join(REPO_ROOT, 'packages/typert/loader/lib')
  if (!existsSync(join(REPO_ROOT, 'node_modules')) || !existsSync(typert)) {
    throw new Error('cannot run the real-CLI two-spawn test: run `pnpm run build` in the harness repo first')
  }
}

function scrubEnv(base) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(key)) delete env[key]
  }
  return env
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function lastSeqOf(logText) {
  let max = null
  const lines = logText.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`session log line ${index + 1} is not valid JSON: ${/** @type {Error} */ (error).message}`)
    }
    if (typeof event.seq === 'number' && (max === null || event.seq > max)) max = event.seq
  }
  return max
}

/** Same suffix cut executeSpawn uses before foldSessionLog: seq missing or seq > prior last. */
function suffixText(logText, lastSeq) {
  const lines = logText.split('\n')
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`session log line ${index + 1} is not valid JSON: ${/** @type {Error} */ (error).message}`)
    }
    if (event.seq === undefined || event.seq > lastSeq) kept.push(line)
  }
  return kept.join('\n') + '\n'
}

function sessionEvents(logText) {
  const lines = logText.split('\n')
  const events = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`session log line ${index + 1} is not valid JSON: ${/** @type {Error} */ (error).message}`)
    }
    if (event.type !== 'session') events.push(event)
  }
  return events
}

function assistantUsages(events) {
  const usages = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || typeof usage !== 'object' || usage === null) {
      throw new Error('assistant/message is missing usage; cannot prove suffix-only metrics')
    }
    const inputTokens = usage.inputTokens
    const outputTokens = usage.outputTokens
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
      throw new Error('assistant/message usage is missing numeric inputTokens/outputTokens')
    }
    usages.push({ inputTokens, outputTokens })
  }
  return usages
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createJsonlParser(onRecord) {
  let pending = ''
  return {
    push(chunk, label) {
      pending += chunk
      while (true) {
        const nl = pending.indexOf('\n')
        if (nl === -1) break
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (line.trim() === '') continue
        let record
        try {
          record = JSON.parse(line)
        } catch (error) {
          throw new Error(`${label} JSONL is not valid JSON: ${/** @type {Error} */ (error).message}: ${line}`)
        }
        onRecord(record)
      }
    },
    finish(label) {
      if (pending.trim() !== '') {
        throw new Error(`${label} JSONL ended with an incomplete record: ${pending}`)
      }
    },
  }
}

async function startStub(sequence) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', MOCK_BIN,
    '--port', '0',
    '--api-key', 'bench-stub',
    '--sequence', sequence,
    '--success-text', 'STUB_ANSWER',
  ], {
    cwd: REPO_ROOT,
    env: {
      ...scrubEnv(process.env),
      TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const records = []
  let stdout = ''
  const parser = createJsonlParser(record => { records.push(record) })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock:llm never printed a ready record')), 15_000)
    const fail = error => {
      clearTimeout(timer)
      reject(error)
    }
    const onData = chunk => {
      stdout += chunk
      try {
        parser.push(chunk, 'mock:llm')
      } catch (error) {
        child.stdout.off('data', onData)
        fail(error)
        return
      }
      const readyRecord = records.find(record => record.type === 'ready' && typeof record.baseURL === 'string')
      if (readyRecord !== undefined) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stdout.on('data', later)
        resolve(readyRecord)
      }
    }
    const later = chunk => {
      stdout += chunk
      parser.push(chunk, 'mock:llm')
    }
    child.stdout.on('data', onData)
    child.once('error', fail)
    child.once('exit', code => {
      fail(new Error(`mock:llm exited ${code} before ready: ${stdout}`))
    })
  })
  return { child, ready, records, parser, stdout }
}

async function stopStub(stub) {
  if (stub.child.exitCode !== null || stub.child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stub.child.kill('SIGKILL') }, 5_000)
    stub.child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    stub.child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    stub.child.kill('SIGTERM')
  })
}

async function collectSessionFiles(root) {
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'session.jsonl') out.push(path)
    }
  }
  await walk(root)
  return out
}

after(async () => {
  await Promise.all([...KEEP].map(dir => rm(dir, { recursive: true, force: true })))
})

test('real CLI two-spawn resume through executeTrial against mock:llm', async () => {
  requireBuiltHarness()
  const root = await mkdtemp(join(tmpdir(), 'bench-real-cli-'))
  KEEP.add(root)
  const scratch = join(root, 'scratch')
  const home = join(root, 'home')
  const sessions = join(root, 'sessions')
  await mkdir(scratch)
  await mkdir(home)
  await mkdir(sessions)
  const stub = await startStub('success,success')
  let failed = false
  try {
    const overlayPath = join(root, 'arm-overlay.yml')
    await writeFile(overlayPath, renderArmOverlay(getArm('off'), { sessionLogRoot: sessions }))
    const env = {
      ...scrubEnv(process.env),
      SHRES_HOME: home,
      BENCH_STUB_BASE_URL: stub.ready.baseURL,
      BENCH_STUB_KEY: 'bench-stub',
    }
    const spawn1Args = ['--session-id', SESSION_ID]
    const first = await executeTrial({
      repoRoot: REPO_ROOT,
      overlayPath,
      extraPatchPaths: [STUB_OVERLAY],
      sessionArgs: spawn1Args,
      taskText: 'Reply with exactly: ONE',
      scratchDir: scratch,
      sessionLogRoot: sessions,
      timeoutMs: 120_000,
      env,
    })
    assert.equal(first.exitCode, 0, first.stderr)

    const logPath = first.sessionLogPath
    assert.notEqual(logPath, null)
    const predicted = sessionLogPath(sessions, realpathSync(scratch), SESSION_ID)
    assert.equal(logPath, predicted)
    const b1 = await readFile(/** @type {string} */ (logPath))
    const n1 = b1.length
    const s1 = lastSeqOf(b1.toString('utf8'))
    assert.notEqual(s1, null)

    const t0 = performance.now()
    await sleep(GAP_MS)
    const t1 = performance.now()
    assert.ok(t1 - t0 >= GAP_MS)

    const spawn2Args = ['--resume', SESSION_ID]
    const second = await executeTrial({
      repoRoot: REPO_ROOT,
      overlayPath,
      extraPatchPaths: [STUB_OVERLAY],
      sessionArgs: spawn2Args,
      taskText: 'Reply with exactly: TWO',
      scratchDir: scratch,
      sessionLogRoot: sessions,
      timeoutMs: 120_000,
      env,
    })
    assert.equal(second.exitCode, 0, second.stderr)

    const b2 = await readFile(/** @type {string} */ (logPath))
    assert.ok(b2.length > n1)
    assert.equal(sha256(b2.subarray(0, n1)), sha256(b1))

    const files = await collectSessionFiles(sessions)
    assert.equal(files.length, 1)
    assert.equal(files[0], logPath)
    const header = JSON.parse(b2.toString('utf8').split('\n', 1)[0])
    assert.equal(header.id, SESSION_ID)

    const events = sessionEvents(b2.toString('utf8'))
    const headers = events.filter(event => event.type === 'request/header')
    const reasons = headers.map(event => event.data?.reason)
    assert.equal(reasons.filter(reason => reason === 'initial').length, 1)
    assert.equal(reasons.filter(reason => reason === 'resume').length, 1)
    assert.ok(reasons.indexOf('initial') < reasons.indexOf('resume'))

    const usages = assistantUsages(events)
    assert.equal(usages.length, 2)
    const suffix = suffixText(b2.toString('utf8'), s1)
    const suffixMetrics = foldSessionLog(suffix, { expectsSessionQuery: false, expectsJspace: false })
    const fullMetrics = foldSessionLog(b2.toString('utf8'), { expectsSessionQuery: false, expectsJspace: false })
    assert.equal(suffixMetrics.turns, 1)
    assert.equal(fullMetrics.turns, 2)
    assert.equal(suffixMetrics.inputTokens, usages[1].inputTokens)
    assert.equal(suffixMetrics.outputTokens, usages[1].outputTokens)
    assert.equal(fullMetrics.inputTokens, usages[0].inputTokens + usages[1].inputTokens)
    assert.equal(fullMetrics.outputTokens, usages[0].outputTokens + usages[1].outputTokens)
    assert.ok(
      suffixMetrics.inputTokens !== fullMetrics.inputTokens
      || suffixMetrics.outputTokens !== fullMetrics.outputTokens
      || usages[0].inputTokens + usages[0].outputTokens === 0,
      'suffix fold must exclude turn-1 usage',
    )

    const lastSpawn1 = events.filter(event => typeof event.seq === 'number' && event.seq <= s1).at(-1)
    const firstStep2 = events.find(event => event.type === 'step/start' && event.seq > s1)
    assert.ok(lastSpawn1?.time !== undefined && firstStep2?.time !== undefined)
    assert.ok(firstStep2.time - lastSpawn1.time >= GAP_MS)

    stub.parser.finish('mock:llm')
    const requests = stub.records.filter(record => record.type === 'request')
    assert.equal(requests.length, 2)
    assert.match(second.stdout, /STUB_ANSWER/)
    assert.doesNotMatch(second.stdout, /\bONE\b/)
    assert.doesNotMatch(second.stdout, /Reply with exactly/)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await stopStub(stub)
    if (!failed) {
      await rm(root, { recursive: true, force: true })
      KEEP.delete(root)
    }
  }
})

test('real CLI three-turn multiturn path through main() against mock:llm', async () => {
  requireBuiltHarness()
  const benchRoot = await mkdtemp(join(REPO_ROOT, 'bench-real-cli-main-'))
  KEEP.add(benchRoot)
  const stub = await startStub('success,success,success')
  await mkdir(join(benchRoot, 'tasks', 'real-cli-three', 'fixture'), { recursive: true })
  await writeFile(join(benchRoot, 'tasks', 'real-cli-three', 'task.json'), JSON.stringify({
    taskId: 'real-cli-three',
    stratum: 'short',
    description: 'three stubbed turns',
    verify: 'node verify.mjs',
    timeoutMs: 120000,
    turns: ['Reply with exactly: ONE', 'Reply with exactly: TWO', 'Reply with exactly: THREE'],
  }))
  await writeFile(join(benchRoot, 'tasks', 'real-cli-three', 'verify.mjs'), 'process.exit(0)\n')
  let failed = false
  try {
    const env = {
      ...scrubEnv(process.env),
      SHRES_HOME: join(benchRoot, 'home'),
      BENCH_STUB_BASE_URL: stub.ready.baseURL,
      BENCH_STUB_KEY: 'bench-stub',
    }
    await mkdir(env.SHRES_HOME)
    const code = await main([
      '--experiment', 'real-cli',
      '--arms', 'off',
      '--repeats', '1',
      '--tier-patch', STUB_OVERLAY,
      '--api-key-env', 'BENCH_STUB_KEY',
      '--gap-cap-ms', '1500',
      '--gap-seed', '9',
      '--nonce',
      '--max-total-tokens', '1000000',
    ], {
      benchRoot,
      env,
      print: () => {},
    })
    assert.equal(code, 0)
    const trialsPath = join(benchRoot, 'runs', 'real-cli', 'off', 'trials.jsonl')
    const trials = (await readFile(trialsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(trials.length, 1)
    const [trial] = trials
    assert.equal(trial.phases.length, 3)
    assert.equal(trial.phases[1].resumedFrom, trial.phases[0].sessionFile)
    assert.equal(trial.phases[2].resumedFrom, trial.phases[1].sessionFile)
    assert.equal(trial.gaps.length, 2)
    assert.ok(trial.gaps.every(gap => gap.gapMs === 1500))
    for (const phase of trial.phases) {
      assert.equal(phase.metrics.turns, 1)
    }
    assert.equal(trial.integrity?.violations, undefined)
    stub.parser.finish('mock:llm')
    const requests = stub.records.filter(record => record.type === 'request')
    assert.equal(requests.length, 3)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await stopStub(stub)
    if (!failed) {
      await rm(benchRoot, { recursive: true, force: true })
      KEEP.delete(benchRoot)
    }
  }
})
