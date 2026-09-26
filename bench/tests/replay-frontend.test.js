/** Physical JSONL replay frontend: class A/B/C, inspect-only recovery, hosted consults. @module */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context } from '../../vendor/cordis/lib/index.js'
import { SessionId, SessionStore } from '../../packages/core/session/lib/index.js'
import { JsonlSessionPersistence } from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { classifyArtifact, decodePhysicalJsonl, proposalFromHeader, replayTrialLog, TrialInputIncompleteError } from '../routing/replay-frontend.js'
import { coldPointAt } from '../../packages/llm/model-router/lib/index.js'
import { assertUnchangedSnapshots, countRoutersInDump, hostReplayRun, hostReplayTrial } from '../routing/replay-frontend-host.js'
import { computeReplayMetrics, validateReplayRow } from '../analysis/replay-metrics.js'
import { FRONTEND_METHOD_FIELDS, MethodUnpinnedError, parseReplayMethod } from '../routing/replay-method.js'
import { projectKey, encodeSegment } from '../runner/session-layout.js'
import { fixtureMethod, fixtureRow } from './replay-fixture-method.js'

const fixture = new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url)
const method = fixtureMethod()
const repo = join(fileURLToPath(new URL('../..', import.meta.url)))

async function withPersistence(bytes, fn) {
  const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
  const root = await mkdtemp(join(tmpdir(), 'bench-replay-front-'))
  const ctx = new Context()
  const load = { count: 0 }
  const prepare = { count: 0 }
  try {
    await ctx.plugin(SessionStore, {})
    await ctx.plugin(JsonlSessionPersistence, { root, packChunks: false, compression: 'none' })
    const dir = join(root, projectKey(header.cwd), encodeSegment(header.id))
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'session.jsonl')
    await writeFile(path, bytes)
    const persistence = {
      readFrom: (id, fromSeq) => ctx.sessionPersistence.readFrom(id, fromSeq),
      inspect: (id) => ctx.sessionPersistence.inspect(id),
      load: async (id) => {
        load.count++
        return ctx.sessionPersistence.load(id)
      },
      prepare: async (id) => {
        prepare.count++
        return ctx.sessionPersistence.prepare(id)
      },
    }
    return await fn({ ctx, persistence, path, header, load, prepare, root })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

function passthroughRuntime() {
  return {
    resolveModelInfo: async (provider, model) => ({
      provider, id: model, name: model, context: { contextWindow: 128_000 }, promptCacheTtlMs: 3_600_000,
    }),
    prepareCall: async (config) => ({ config }),
  }
}

function assertAllRows(rows, n, predicate) {
  if (!Array.isArray(rows) || rows.length !== n) {
    throw new TypeError('assertAllRows: expected ' + String(n) + ' rows, got ' + String(rows?.length ?? 'none'))
  }
  for (const row of rows) {
    if (!predicate(row)) throw new TypeError('assertAllRows: predicate failed')
  }
}

const composedFields = {
  routerConfig: {
    initialMode: 'on',
    candidates: [{ id: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash', description: 'small' }],
    routeFrom: [{ provider: 'anthropic', model: 'claude-opus-5-5', objective: 'quota' }],
    downgradeThreshold: 0.8,
    downgradeMargin: 0.1,
    routeInstructions: 'Pick the cheapest route that can finish this turn.',
    difficultyInstructions: 'Rate how much reasoning this turn needs.',
  },
  routeBase: { provider: 'anthropic', model: 'claude-opus-5-5' },
  trialOwnRoute: { provider: 'anthropic', model: 'claude-opus-5-5' },
  requestConfig: { provider: 'anthropic', model: 'claude-opus-5-5' },
  ttl: { ttlMs: 3_600_000, ttlSource: 'adapter' },
}

test('FRONTEND_METHOD_FIELDS are version, coldPointBasis, cRowRequestConfig', () => {
  assert.deepEqual([...FRONTEND_METHOD_FIELDS], ['version', 'coldPointBasis', 'cRowRequestConfig'])
})

test('the real 3-spawn fixture is class A and accepted without load/prepare', async () => {
  const bytes = await readFile(fixture)
  const provenance = JSON.parse(await readFile(new URL('../routing/fixtures/replay-c-label-windows.provenance.json', import.meta.url), 'utf8'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256)
  const before = await stat(fixture)
  await withPersistence(bytes, async ({ persistence, path, header, load, prepare }) => {
    const result = await replayTrialLog({
      trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
      path,
      persistence,
      runtime: passthroughRuntime(),
      ...composedFields,
      method,
      arm: 'C',
    })
    assert.equal(result.artifact, 'complete')
    assert.equal(load.count, 0)
    assert.equal(prepare.count, 0)
    const decoded = decodePhysicalJsonl(bytes, path)
    const readFrom = await persistence.readFrom(SessionId(header.id), 0)
    assert.deepEqual(decoded.events, readFrom.events)
  })
  const afterFixture = await stat(fixture)
  assert.equal(afterFixture.mtimeMs, before.mtimeMs)
  assert.equal(afterFixture.size, before.size)
})

test('an open final turn is class B and rows carry the diagnostic artifact', async () => {
  const original = (await readFile(fixture)).toString('utf8').trimEnd().split('\n')
  const truncated = original.slice(0, Math.max(20, original.length - 8)).join('\n') + '\n'
  await withPersistence(Buffer.from(truncated), async ({ persistence, path }) => {
    const result = await replayTrialLog({
      trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
      path,
      persistence,
      runtime: passthroughRuntime(),
      ...composedFields,
      method,
      arm: 'C',
    })
    assert.equal(result.artifact, 'open-final-turn')
    assert.equal(result.rows.length, 5)
    assertAllRows(result.rows, 5, row => row.artifact === 'open-final-turn')
  })
})

test('a torn last line is class C and refuses the whole replay', async () => {
  const original = (await readFile(fixture)).toString('utf8')
  const torn = original.trimEnd().slice(0, -10)
  await withPersistence(Buffer.from(torn), async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path, persistence, runtime: passthroughRuntime(), ...composedFields, method, arm: 'C',
      }),
      error => error instanceof TrialInputIncompleteError && /newline/.test(error.message),
    )
  })
})

test('a malformed JSON line is class C', async () => {
  const original = (await readFile(fixture)).toString('utf8').trimEnd().split('\n')
  original[5] = '{not json'
  await withPersistence(Buffer.from(original.join('\n') + '\n'), async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path, persistence, runtime: passthroughRuntime(), ...composedFields, method, arm: 'C',
      }),
      TrialInputIncompleteError,
    )
  })
})

test('a physically present interrupted turn/end is class C', async () => {
  const original = (await readFile(fixture)).toString('utf8').trimEnd().split('\n')
  const last = JSON.parse(original.at(-1))
  original.push(JSON.stringify({
    type: 'turn/end',
    seq: (last.seq ?? 0) + 1,
    time: 0,
    data: { turn: 99, reason: { kind: 'interrupted' } },
  }))
  await withPersistence(Buffer.from(original.join('\n') + '\n'), async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path, persistence, runtime: passthroughRuntime(), ...composedFields, method, arm: 'C',
      }),
      error => error instanceof TrialInputIncompleteError && /interrupted recovery/.test(error.message),
    )
  })
})

test('a skipped-verifier C trial labels unlabelled/task-outcome-unknown', async () => {
  const bytes = await readFile(fixture)
  await withPersistence(bytes, async ({ persistence, path }) => {
    const result = await replayTrialLog({
      trial: { resolved: false, status: 'error', verifier: { command: 'node verify.mjs', exitCode: 0, detail: 'skipped: provider error' } },
      path,
      persistence,
      runtime: passthroughRuntime(),
      ...composedFields,
      method,
      arm: 'C',
    })
    assertAllRows(result.rows, 5, row => row.label.status === 'unlabelled' && row.label.reason === 'task-outcome-unknown')
  })
})

test('missing frontend method fields refuse rather than consult', async () => {
  const bytes = await readFile(fixture)
  await withPersistence(bytes, async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'x', exitCode: 0 } },
        path, persistence, runtime: passthroughRuntime(), ...composedFields, method: { version: 'pr16-replay@1' }, arm: 'C',
      }),
      error => error instanceof MethodUnpinnedError
        && error.missing.includes('coldPointBasis')
        && error.missing.includes('cRowRequestConfig'),
    )
  })
})

test('assertAllRows throws on an empty array', () => {
  assert.throws(() => assertAllRows([], 3, () => true), /expected 3 rows/)
})

test('C requestConfig equals currentSelection with no maxTokens', () => {
  const selection = { provider: 'anthropic', model: 'claude-opus-5-5' }
  const requestConfig = structuredClone(selection)
  assert.deepEqual(requestConfig, selection)
  assert.equal('maxTokens' in requestConfig, false)
  assert.equal('adapterDefaults' in requestConfig, false)
})

test('proposalFromHeader named S cases', () => {
  const selection = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const ok = {
    config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 256000 },
    adapterDefaults: { reasoningEffort: true, maxTokens: true },
  }
  assert.deepEqual(proposalFromHeader(ok), selection)
  const explicit = {
    config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' },
  }
  const explicitSelection = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' }
  assert.deepEqual(proposalFromHeader(explicit), explicitSelection)
  const unmarked = {
    config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 256000 },
  }
  assert.notDeepEqual(proposalFromHeader(unmarked), selection)
  const extra = {
    config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', temperature: 0.2 },
    adapterDefaults: { maxTokens: true },
  }
  assert.notDeepEqual(proposalFromHeader(extra), selection)
  const drift = {
    config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 256000 },
    adapterDefaults: { reasoningEffort: true, maxTokens: true },
  }
  assert.notDeepEqual(proposalFromHeader(drift), selection)
})

test('S request-config-mismatch refuses the whole trial', async () => {
  const bytes = await readFile(fixture)
  await withPersistence(bytes, async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path, persistence, runtime: passthroughRuntime(), ...composedFields,
        requestConfig: { provider: 'anthropic', model: 'claude-opus-5-5' },
        method, arm: 'S',
      }),
      error => error instanceof TrialInputIncompleteError && error.message === 'request-config-mismatch',
    )
  })
})

test('hash-only snapshot difference is trial-artifact-mutated', () => {
  const before = { 'session.jsonl': { sha256: 'aa', size: 10, mtimeMs: 1 } }
  const after = { 'session.jsonl': { sha256: 'bb', size: 10, mtimeMs: 1 } }
  assert.throws(() => assertUnchangedSnapshots(before, after), /trial-artifact-mutated/)
})

test('dump-config router count is 1, 2, or 0 from YAML', () => {
  const one = '- name: "@shres-code/shres-code-model-router"\n  config: { initialMode: on }\n'
  assert.equal(countRoutersInDump(one).count, 1)
  const two = one + '- id: extra-router\n  name: "@shres-code/shres-code-model-router"\n  config: { initialMode: on }\n'
  assert.equal(countRoutersInDump(two).count, 2)
  const none = '- name: "@shres-code/shres-code-model-router"\n  disabled: true\n'
  assert.equal(countRoutersInDump(none).count, 0)
})

test('class-B artifact is ignored by metrics', () => {
  const base = fixtureRow({
    task: 't', arm: 'S', stratum: 'routine', coldPointId: 'c1',
    eligible: false, answered: false, truncated: null, headTokens: null,
    winner: null, confidence: null, margin: null, pCheap: null, difficultyScore: null,
    cheapSufficient: true,
  })
  base.arm = 'S'
  base.label = { status: 'unlabelled', reason: 'no-label-source-for-arm' }
  validateReplayRow(base, 'plain')
  validateReplayRow({ ...base, artifact: 'open-final-turn' }, 'b')
  const options = { method, gate: { aurocMin: 0, falseDowngradeMax: 1, coverageMin: 0 }, entry: { entryScoreCeiling: 2, candidateIds: ['flash'] } }
  const withB = computeReplayMetrics([base, { ...base, coldPointId: 'c2', artifact: 'open-final-turn' }], options)
  const without = computeReplayMetrics([base, { ...base, coldPointId: 'c2' }], options)
  assert.deepEqual(withB, without)
})

test('seeded headers are refused', () => {
  assert.throws(
    () => classifyArtifact({
      header: { type: 'session', id: 'x', seedLength: 3 },
      events: [],
      readFrom: { events: [] },
    }),
    /seeded bench logs/,
  )
})

test('arm R (route-coldpoint) hosted consults replayTrialLog through the live plugin', async () => {
  const bytes = await readFile(fixture)
  const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
  const plant = await mkdtemp(join(tmpdir(), 'bench-replay-plant-'))
  const dir = join(plant, projectKey(header.cwd), encodeSegment(header.id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  await writeFile(path, bytes)
  const before = await stat(path)
  try {
    const hosted = await hostReplayTrial({
      repoRoot: repo,
      trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
      path,
      arm: 'C',
      method,
      trialOwnRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    assert.equal(hosted.status.ok, true)
    assert.equal(hosted.routerCount, 1, 'named R coverage: route-coldpoint dump-config has exactly one model-router')
    assert.equal(hosted.sink, 0)
    assert.equal(hosted.summary.http, 0)
    assert.equal(hosted.summary.artifact, 'complete')
    assert.deepEqual(hosted.summary.routeBase, { provider: 'anthropic', model: 'claude-opus-5-5' })
    assert.equal('adapterDefaults' in hosted.summary.requestConfig, false)
    assert.equal('maxTokens' in hosted.summary.requestConfig, false)
    const judged = hosted.summary.kinds.ask + hosted.summary.kinds.ineligible
    assert.equal(hosted.summary.counts.prepareCall, judged * 2)
    assert.equal(hosted.consults.length > 0, true)
    const events = decodePhysicalJsonl(bytes, path).events
    const starts = events.filter(event => event.type === 'step/start')
    assert.equal(hosted.consults.length, starts.length)
    for (const [index, entry] of hosted.consults.entries()) {
      assert.equal(entry.now, starts[index].time)
    }
    const judgedConsults = hosted.consults.filter(entry => entry.result.kind === 'ask' || entry.result.kind === 'ineligible')
    assert.equal(judgedConsults.length, judged)
    for (const entry of judgedConsults) {
      const assessments = entry.result.eligibility?.assessments ?? []
      const flash = assessments.find(item => item.candidateId === 'flash' || item.id === 'flash' || item.model === 'deepseek-v4-flash')
        ?? assessments[0]
      assert.equal(flash?.reasoningEffort, 'high', JSON.stringify(flash))
      assert.ok(typeof flash?.effectiveMaxTokens === 'number' && flash.effectiveMaxTokens > 0)
    }
    const after = await stat(path)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
  } finally {
    await rm(plant, { recursive: true, force: true })
  }
})


test('corrupt input publishes no accepted out file or rows', async () => {
  const bytes = await readFile(fixture)
  const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
  const plant = await mkdtemp(join(tmpdir(), 'bench-replay-corrupt-'))
  const dir = join(plant, projectKey(header.cwd), encodeSegment(header.id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  const torn = Buffer.from(bytes.toString('utf8').trimEnd().slice(0, -10))
  await writeFile(path, torn)
  try {
    await assert.rejects(
      () => hostReplayTrial({
        repoRoot: repo,
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path,
        arm: 'C',
        method,
        trialOwnRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      TrialInputIncompleteError,
    )
  } finally {
    await rm(plant, { recursive: true, force: true })
  }
})

test('step/start missing time is malformed-event and publishes no rows', async () => {
  const bytes = await readFile(fixture)
  const lines = bytes.toString('utf8').trimEnd().split('\n')
  const patched = lines.map((line) => {
    const parsed = JSON.parse(line)
    if (parsed.type === 'step/start') {
      const copy = { ...parsed }
      delete copy.time
      return JSON.stringify(copy)
    }
    return line
  }).join('\n') + '\n'
  await withPersistence(Buffer.from(patched), async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path, persistence, runtime: passthroughRuntime(), ...composedFields, method, arm: 'C',
      }),
      error => error instanceof TrialInputIncompleteError && /malformed-event/.test(error.message),
    )
  })
})

test('coldPointAt public result is warm at TTL and TTL-1, idle only after TTL', () => {
  const selection = { provider: 'anthropic', model: 'claude-opus-5-5' }
  const ttl = { ttlMs: 300_000, ttlSource: 'adapter' }
  const t0 = 1_000_000
  const events = [
    { type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: t0, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: t0 + 1, data: { turn: 1, step: 1, message: { source: selection } } },
  ]
  assert.equal(coldPointAt(events, selection, ttl, t0 + ttl.ttlMs - 1, false), undefined)
  assert.equal(coldPointAt(events, selection, ttl, t0 + ttl.ttlMs, false), undefined)
  const idle = coldPointAt(events, selection, ttl, t0 + ttl.ttlMs + 1, false)
  assert.equal(idle?.kind, 'idle')
  assert.equal(idle?.idleMs, ttl.ttlMs + 1)
})

test('quota consults use each step/start.time so a job-wide clock cannot hide expiry', async () => {
  const t0 = 1_000_000
  const ttlMs = 300_000
  const warmAt = t0 + 60_000
  const expiredAt = t0 + 400_000
  const selection = { provider: 'anthropic', model: 'claude-opus-5-5' }
  const header = { type: 'session', version: 0, id: 'bench-quota-clock', createdAt: t0, cwd: '/tmp/quota-clock', delegationDepth: 0 }
  const user = (text, id) => ({ role: 'user', id, content: [{ type: 'text', text }], source: { kind: 'user' } })
  const events = [
    { type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: t0, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: t0 + 1, data: user('one', 'u1'), surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, time: t0 + 2, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', ...selection } } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 4, time: t0 + 3, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 5, time: warmAt, data: { turn: 2 } },
    { type: 'step/start', seq: 6, time: warmAt, data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: 7, time: warmAt + 1, data: user('two', 'u2'), surfaceOp: 'append' },
    { type: 'turn/end', seq: 8, time: warmAt + 2, data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 9, time: expiredAt, data: { turn: 3 } },
    { type: 'step/start', seq: 10, time: expiredAt, data: { turn: 3, step: 1 } },
    { type: 'user/message', seq: 11, time: expiredAt + 1, data: user('three', 'u3'), surfaceOp: 'append' },
  ]
  const body = [JSON.stringify(header), ...events.map(event => JSON.stringify(event)), ''].join('\n')
  await withPersistence(Buffer.from(body), async ({ persistence, path }) => {
    const quotaConfig = {
      ...composedFields.routerConfig,
      routeFrom: [{ provider: selection.provider, model: selection.model, objective: 'quota' }],
    }
    const result = await replayTrialLog({
      trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
      path,
      persistence,
      runtime: {
        resolveModelInfo: async (provider, model) => ({
          provider, id: model, name: model, context: { contextWindow: 128_000 }, promptCacheTtlMs: ttlMs,
        }),
        prepareCall: async (config) => ({ config }),
      },
      routerConfig: quotaConfig,
      routeBase: selection,
      trialOwnRoute: selection,
      requestConfig: selection,
      ttl: { ttlMs, ttlSource: 'adapter' },
      method,
      arm: 'C',
    })
    assert.equal(result.consults.length, 3)
    assert.equal(result.consults[0].now, t0)
    assert.equal(result.consults[1].now, warmAt)
    assert.equal(result.consults[2].now, expiredAt)
    assert.equal(result.consults[1].result.kind, 'warm')
    assert.notEqual(result.consults[2].result.kind, 'warm')
    const constantKinds = result.consults.map(entry => entry.result.kind)
    assert.notDeepEqual(constantKinds, ['ask', 'warm', 'warm'])
  })
})

async function plantFixture(bytes, tag) {
  const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
  const plant = await mkdtemp(join(tmpdir(), 'bench-replay-run-' + tag + '-'))
  const dir = join(plant, projectKey(header.cwd), encodeSegment(header.id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  await writeFile(path, bytes)
  return { plant, path }
}

const ownRoute = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const tasks = { 'task-a': { stratum: 'routine' } }

function trialOf(id, path, extra = {}) {
  return {
    id, taskId: 'task-a', trialIndex: extra.trialIndex ?? 0, arm: 'C', path,
    trialOwnRoute: ownRoute,
    trial: extra.trial ?? { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
  }
}

test('hostReplayRun missing stratum TypeError does not spawn', async () => {
  await assert.rejects(
    () => hostReplayRun({
      repoRoot: repo, method, tasks: { 'task-a': {} },
      trials: [trialOf('t1', '/nope')],
    }),
    error => error instanceof TypeError && /has no preregistered stratum/.test(error.message),
  )
})

test('hostReplayRun empty trials or duplicate id TypeError does not spawn', async () => {
  await assert.rejects(
    () => hostReplayRun({ repoRoot: repo, method, tasks, trials: [] }),
    /non-empty trials/,
  )
  const bytes = await readFile(fixture)
  const { plant, path } = await plantFixture(bytes, 'dup-id')
  try {
    await assert.rejects(
      () => hostReplayRun({
        repoRoot: repo, method, tasks,
        trials: [trialOf('same', path), trialOf('same', path, { trialIndex: 1 })],
      }),
      /duplicate trial id/,
    )
  } finally {
    await rm(plant, { recursive: true, force: true })
  }
})

test('hostReplayRun two class-C trials plus one good names both and returns no rows', async () => {
  const bytes = await readFile(fixture)
  const torn = Buffer.from(bytes.toString('utf8').trimEnd().slice(0, -10))
  const good = await plantFixture(bytes, 'good')
  const bad1 = await plantFixture(torn, 'bad1')
  const bad2 = await plantFixture(torn, 'bad2')
  try {
    let caught
    try {
      await hostReplayRun({
        repoRoot: repo, method, tasks,
        trials: [
          trialOf('bad-first', bad1.path, { trialIndex: 0 }),
          trialOf('good-mid', good.path, { trialIndex: 1 }),
          trialOf('bad-last', bad2.path, { trialIndex: 2 }),
        ],
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof TrialInputIncompleteError)
    assert.match(caught.message, /replay run refused: 2 trial\(s\) class C/)
    assert.equal(caught.trials.length, 2)
    assert.deepEqual(caught.trials.map(entry => entry.id), ['bad-first', 'bad-last'])
    assert.equal(caught.rows, undefined)
  } finally {
    await rm(good.plant, { recursive: true, force: true })
    await rm(bad1.plant, { recursive: true, force: true })
    await rm(bad2.plant, { recursive: true, force: true })
  }
})

test('hostReplayRun non-class-C error propagates before later trials', async () => {
  const bytes = await readFile(fixture)
  const later = await plantFixture(bytes, 'later')
  try {
    await assert.rejects(
      () => hostReplayRun({
        repoRoot: join(repo, 'does-not-exist-launcher'), method, tasks,
        trials: [
          trialOf('boom', later.path, { trialIndex: 0 }),
          trialOf('later', later.path, { trialIndex: 1 }),
        ],
      }),
      error => !(error instanceof TrialInputIncompleteError),
    )
  } finally {
    await rm(later.plant, { recursive: true, force: true })
  }
})

test('hostReplayRun all-good rows validate with task, stratum, and eligible from consults', async () => {
  const bytes = await readFile(fixture)
  const planted = await plantFixture(bytes, 'all-good')
  try {
    const result = await hostReplayRun({
      repoRoot: repo, method, tasks,
      trials: [trialOf('good', planted.path)],
    })
    assert.equal(result.rows.length, 5)
    assert.equal(result.consults.length, 1)
    assert.equal(result.summaries.length, 1)
    for (const row of result.rows) {
      validateReplayRow(row, 'all-good ' + row.coldPointId)
      assert.equal(row.task, 'task-a')
      assert.equal(row.stratum, 'routine')
      assert.equal(row.trialIndex, 0)
      assert.equal(row.answered, false)
      assert.equal(row.winner, null)
      const consult = result.consults[0].consults.find(entry => entry.turn === row.turn && entry.step === row.step)
      assert.ok(consult)
      assert.equal(row.eligible, consult.result.kind === 'ask')
    }
  } finally {
    await rm(planted.plant, { recursive: true, force: true })
  }
})

test('hostReplayRun shared arm/taskId/trialIndex is TypeError with no spawn', async () => {
  await assert.rejects(
    () => hostReplayRun({
      repoRoot: repo, method, tasks,
      trials: [trialOf('a', '/nope', { trialIndex: 0 }), trialOf('b', '/nope', { trialIndex: 0 })],
    }),
    error => error instanceof TypeError && /duplicate \(arm, taskId, trialIndex\)/.test(error.message),
  )
})

test('hostReplayRun two valid repeats same task and arm keep both trials rows', async () => {
  const bytes = await readFile(fixture)
  const a = await plantFixture(bytes, 'rep-a')
  const b = await plantFixture(bytes, 'rep-b')
  try {
    const result = await hostReplayRun({
      repoRoot: repo, method, tasks,
      trials: [trialOf('a', a.path, { trialIndex: 0 }), trialOf('b', b.path, { trialIndex: 1 })],
    })
    assert.equal(result.summaries.length, 2)
    assert.equal(result.rows.length, 10)
    const zeros = result.rows.filter(row => row.trialIndex === 0)
    const ones = result.rows.filter(row => row.trialIndex === 1)
    assert.equal(zeros.length, 5)
    assert.equal(ones.length, 5)
    for (const row of result.rows) validateReplayRow(row, 'repeat ' + row.trialIndex + ' ' + row.coldPointId)
    assert.ok(result.rows.some(row => row.coldPointId === 'turn:1/step:1' && row.trialIndex === 0))
    assert.ok(result.rows.some(row => row.coldPointId === 'turn:1/step:1' && row.trialIndex === 1))
  } finally {
    await rm(a.plant, { recursive: true, force: true })
    await rm(b.plant, { recursive: true, force: true })
  }
})
