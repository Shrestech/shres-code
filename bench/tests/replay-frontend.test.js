/** Physical JSONL replay frontend: class A/B/C, inspect-only recovery, no HTTP. @module */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '../../vendor/cordis/lib/index.js'
import { SessionId, SessionStore } from '../../packages/core/session/lib/index.js'
import { JsonlSessionPersistence } from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { classifyArtifact, decodePhysicalJsonl, replayTrialLog, TrialInputIncompleteError } from '../routing/replay-frontend.js'
import { FRONTEND_METHOD_FIELDS, MethodUnpinnedError, parseReplayMethod } from '../routing/replay-method.js'
import { projectKey, encodeSegment } from '../runner/session-layout.js'
import { fixtureMethod } from './replay-fixture-method.js'

const fixture = new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url)
const method = fixtureMethod()

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

function fakeComposed() {
  let http = 0
  return {
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
    requestConfig: { provider: 'anthropic', model: 'claude-opus-5-5', adapterDefaults: { reasoningEffort: true } },
    ttl: { ttlMs: 3_600_000, ttlSource: 'adapter' },
    resolveModelInfo: async (provider, model) => {
      http++
      return { provider, id: model, name: model, context: { contextWindow: 128_000 }, promptCacheTtlMs: 3_600_000 }
    },
    http: () => http,
  }
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
    const composed = fakeComposed()
    const result = await replayTrialLog({
      trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
      path,
      persistence,
      composed,
      method,
      arm: 'C',
    })
    assert.equal(result.artifact, 'complete')
    assert.equal(result.header.id, header.id)
    assert.equal(result.events[0].seq, 0)
    assert.equal(result.events.at(-1).seq, result.events.length - 1)
    assert.equal(load.count, 0)
    assert.equal(prepare.count, 0)
    const after = await stat(path)
    assert.equal(after.size, bytes.length)
    assert.equal(after.mtimeMs, (await stat(path)).mtimeMs)
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
      composed: fakeComposed(),
      method,
      arm: 'C',
    })
    assert.equal(result.artifact, 'open-final-turn')
    assert.ok(result.rows.every(row => row.artifact === 'open-final-turn'))
    assert.ok(!result.events.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted'))
  })
})

test('a torn last line is class C and refuses the whole replay', async () => {
  const original = (await readFile(fixture)).toString('utf8')
  const torn = original.trimEnd().slice(0, -10)
  await withPersistence(Buffer.from(torn), async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
        path, persistence, composed: fakeComposed(), method, arm: 'C',
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
        path, persistence, composed: fakeComposed(), method, arm: 'C',
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
        path, persistence, composed: fakeComposed(), method, arm: 'C',
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
      composed: fakeComposed(),
      method,
      arm: 'C',
    })
    assert.ok(result.rows.length > 0)
    assert.ok(result.rows.every(row => row.label.status === 'unlabelled' && row.label.reason === 'task-outcome-unknown'))
  })
})

test('missing frontend method fields refuse rather than consult', async () => {
  const bytes = await readFile(fixture)
  await withPersistence(bytes, async ({ persistence, path }) => {
    await assert.rejects(
      () => replayTrialLog({
        trial: { resolved: true, verifier: { command: 'x', exitCode: 0 } },
        path, persistence, composed: fakeComposed(), method: { version: 'pr16-replay@1' }, arm: 'C',
      }),
      error => error instanceof MethodUnpinnedError
        && error.missing.includes('coldPointBasis')
        && error.missing.includes('cRowRequestConfig'),
    )
  })
})

test('C requestConfig strips adapterDefaults and does not invent maxTokens', () => {
  const composed = fakeComposed()
  const stripped = { ...composed.requestConfig }
  delete stripped.adapterDefaults
  assert.deepEqual(stripped, { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal('maxTokens' in stripped, false)
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
