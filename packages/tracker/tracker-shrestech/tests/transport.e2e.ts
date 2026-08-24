/**
 * Proves PR #38: the tracker's live HTTP transport against a real node:http
 * server. A run lands over POST /api/runs, a 500 holds it in the spool as
 * unreachable, and a healthy sync drains the spool through POST /api/sync.
 * Keyless: always runs, no model, no API key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import ShrestechTrackerService from '@shres-code/shres-code-tracker-shrestech'
import type { LogRunSpec, TrackerRunId } from '@shres-code/shres-code-tracker'

/** In-memory credentials stub so the provider can resolve a bearer token. */
class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0 ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = (this.store.get(ref)?.length ?? 0) > 0
    return Promise.resolve({ configured, ...configured ? { source: 'memory' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
    return Promise.resolve()
  }
}

const spec: LogRunSpec = {
  experiment: 'study',
  hypothesis: 'h',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v3',
  gitSha: 'abc123',
  metrics: [],
  artifacts: [],
}

/** What the real server has observed so far. */
interface ServerState {
  runs: unknown[]
  syncBatches: unknown[]
  failRuns: boolean
}

/**
 * Start a real node:http server on an ephemeral 127.0.0.1 port.
 * @returns The server, its bound port, and the state it records.
 */
async function startServer(): Promise<{ server: Server; port: number; state: ServerState }> {
  const state: ServerState = { runs: [], syncBatches: [], failRuns: false }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = body === '' ? {} : JSON.parse(body)
      if (req.url === '/api/runs' && req.method === 'POST') {
        state.runs.push(parsed)
        if (state.failRuns) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'boom' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.url === '/api/sync' && req.method === 'POST') {
        state.syncBatches.push(parsed)
        const runs = (parsed as { runs?: { runId?: string }[] }).runs ?? []
        const landedRunIds = runs.map(run => run.runId).filter((id): id is string => id !== undefined)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ landedRunIds }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  return { server, port: address.port, state }
}

/**
 * Mount the tracker provider against a live server on the given port.
 * @returns The context, its scratch dir, and the provider for sync().
 */
async function mount(port: number): Promise<{ ctx: Context; dir: string; provider: ShrestechTrackerService }> {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-e2e-'))
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, { 'TRACKER_TOKEN': 'secret-value' })
  await ctx.plugin(ShrestechTrackerService, {
    baseUrl: `http://127.0.0.1:${port}`,
    lane: 'research',
    spoolPath: join(dir, 'spool.jsonl'),
    indexPath: join(dir, 'landed.jsonl'),
    credentialRef: 'TRACKER_TOKEN',
  })
  return { ctx, dir, provider: ctx.tracker as ShrestechTrackerService }
}

describe('tracker-shrestech real-fetch transport (e2e)', () => {
  let server: Server
  let state: ServerState
  let ctx: Context
  let dir: string
  let provider: ShrestechTrackerService

  beforeEach(async () => {
    const started = await startServer()
    server = started.server
    state = started.state
    const mounted = await mount(started.port)
    ctx = mounted.ctx
    dir = mounted.dir
    provider = mounted.provider
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('lands a run over real HTTP, spools on a 500, and drains via sync', async () => {
    // Healthy server: a run lands, the server saw it, and the index holds it.
    const landed = await ctx.tracker.postRun('run-1' as TrackerRunId, spec)
    expect(landed).toEqual({ kind: 'landed', runId: 'run-1' })
    expect(state.runs).toHaveLength(1)
    expect((state.runs[0] as { runId?: string }).runId).toBe('run-1')
    const afterLand = await ctx.tracker.queryRuns({})
    expect(afterLand.find(run => run.runId === 'run-1')?.reason).toBeUndefined()

    // Server returns 500: the run is held in the spool as unreachable.
    state.failRuns = true
    const spooled = await ctx.tracker.postRun('run-2' as TrackerRunId, spec)
    expect(spooled).toEqual({ kind: 'spooled', runId: 'run-2', reason: 'unreachable' })
    const afterFail = await ctx.tracker.queryRuns({})
    expect(afterFail.find(run => run.runId === 'run-2')?.reason).toBe('unreachable')

    // Server healthy again: sync drains the spool, the server saw the batch,
    // and the index now holds the previously spooled run.
    state.failRuns = false
    const result = await provider.sync()
    expect(result.landedRunIds).toEqual(['run-2'])
    expect(state.syncBatches).toHaveLength(1)
    const batch = state.syncBatches[0] as { runs?: { runId?: string }[] }
    expect(batch.runs?.map(run => run.runId)).toEqual(['run-2'])
    const afterSync = await ctx.tracker.queryRuns({})
    expect(afterSync.find(run => run.runId === 'run-2')?.reason).toBeUndefined()
  })
})
