import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import ShrestechTrackerService from '@shres-code/shres-code-tracker-shrestech'
import type { Config } from '@shres-code/shres-code-tracker-shrestech'
import type { LogRunSpec, TrackerFailureReason, TrackerRunId } from '@shres-code/shres-code-tracker'

/** A provider whose transport lands a post without HTTP (spool/no-spool seam test). */
class LandingShrestechTracker extends ShrestechTrackerService {
  protected async attemptPost(_runId: TrackerRunId, _spec: LogRunSpec, _token: string): Promise<'landed' | TrackerFailureReason> {
    return 'landed'
  }
}

/** In-memory credentials stub so the provider can resolve a bearer token in tests. */
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

/** One recorded fake-fetch call. */
interface FetchCall { url: string; token: string | undefined; body: string }

const spec: LogRunSpec = {
  experiment: 'study',
  hypothesis: 'h',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v3',
  gitSha: 'abc123',
  metrics: [],
  artifacts: [],
}

const BASE_URL = 'https://tracker.example.com'

/** A scratch directory plus isolated spool/index paths inside it. */
async function scratch(): Promise<{ dir: string; spoolPath: string; indexPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-provider-'))
  return { dir, spoolPath: join(dir, 'spool.jsonl'), indexPath: join(dir, 'landed.jsonl') }
}

/** Mount a credentials stub plus a tracker provider on a fresh context. */
async function mount(
  Service: typeof ShrestechTrackerService,
  overrides: Partial<Config> = {},
  opts: { credentials?: boolean; seed?: Record<string, string> } = {},
): Promise<{ ctx: Context; dir: string }> {
  const { dir, spoolPath, indexPath } = await scratch()
  const ctx = new Context()
  if (opts.credentials !== false) {
    await ctx.plugin(MemoryCredentials, opts.seed ?? { 'TRACKER_TOKEN': 'secret-value' })
  }
  await ctx.plugin(Service, {
    baseUrl: BASE_URL,
    lane: 'research',
    spoolPath,
    indexPath,
    ...overrides,
  })
  return { ctx, dir }
}

/** Return a fake fetch that always answers with the given status and body. */
function fakeFetch(status: number, body?: unknown): { fetch: (typeof globalThis)['fetch']; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch = vi.fn(async (input: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url: input, token: init.headers.authorization, body: init.body })
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body ?? {},
    }
  })
  return { fetch: fetch as unknown as (typeof globalThis)['fetch'], calls }
}

/** Resolve the tracker's postRun for one run on the mounted context. */
function post(ctx: Context, runId: string, s: LogRunSpec = spec) {
  return ctx.tracker.postRun(runId as TrackerRunId, s)
}

/** Resolve the mounted provider for its provider-specific sync method. */
function provider(ctx: Context): ShrestechTrackerService {
  return ctx.tracker as ShrestechTrackerService
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ShrestechTrackerService mount', () => {
  it('fails loud at mount on an empty baseUrl', async () => {
    const { spoolPath, indexPath, dir } = await scratch()
    await expect(new Context().plugin(ShrestechTrackerService, { baseUrl: '   ', lane: 'research', spoolPath, indexPath }))
      .rejects.toThrow(/baseUrl must be a non-empty string/)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud at mount on an empty lane', async () => {
    const { spoolPath, indexPath, dir } = await scratch()
    await expect(new Context().plugin(ShrestechTrackerService, { baseUrl: 'https://x', lane: '', spoolPath, indexPath }))
      .rejects.toThrow(/lane must be a non-empty string/)
    await rm(dir, { recursive: true, force: true })
  })

  it('mounts with a default spool path under SHRES_HOME when spoolPath is omitted', async () => {
    const { dir } = await scratch()
    const previous = process.env.SHRES_HOME
    process.env.SHRES_HOME = dir
    try {
      const ctx = new Context()
      await ctx.plugin(ShrestechTrackerService, { baseUrl: 'https://x', lane: 'research' })
      const result = await ctx.tracker.postRun('run-1' as TrackerRunId, spec)
      expect(result).toEqual({ kind: 'spooled', runId: 'run-1', reason: 'spooled' })
    } finally {
      if (previous === undefined) delete process.env.SHRES_HOME
      else process.env.SHRES_HOME = previous
    }
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ShrestechTrackerService.postRun (live HTTP)', () => {
  it('spool-only mode holds a run with a spooled reason when no credential reference is set', async () => {
    const { ctx, dir } = await mount(ShrestechTrackerService, {}, { credentials: false })
    const result = await post(ctx, 'run-1')
    expect(result).toEqual({ kind: 'spooled', runId: 'run-1', reason: 'spooled' })
    await rm(dir, { recursive: true, force: true })
  })

  it('posts a run to POST /api/runs with the bearer token and marks it landed', async () => {
    const { fetch, calls } = fakeFetch(200)
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    const result = await post(ctx, 'run-1')
    expect(result).toEqual({ kind: 'landed', runId: 'run-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/runs`)
    expect(calls[0]?.token).toBe('Bearer secret-value')
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ runId: 'run-1', experiment: 'study', gitSha: 'abc123' })
    // A landed run is not spooled; a query returns it from the landed index.
    const runs = await ctx.tracker.queryRuns({})
    expect(runs).toEqual([{ runId: 'run-1', experiment: 'study', decisionRule: 'val_bpb < 1.0', dataVersion: 'v3', gitSha: 'abc123' }])
    await rm(dir, { recursive: true, force: true })
  })

  it('spools a run with an unreachable reason when the transport returns a 5xx', async () => {
    const { fetch } = fakeFetch(503)
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    const result = await post(ctx, 'run-2')
    expect(result).toEqual({ kind: 'spooled', runId: 'run-2', reason: 'unreachable' })
    await rm(dir, { recursive: true, force: true })
  })

  it('spools a run with an auth reason when the service returns a 401', async () => {
    const { fetch } = fakeFetch(401)
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    const result = await post(ctx, 'run-3')
    expect(result).toEqual({ kind: 'spooled', runId: 'run-3', reason: 'auth' })
    await rm(dir, { recursive: true, force: true })
  })

  it('spools a run with an auth reason when the credential reference resolves to no value', async () => {
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' }, { seed: {} })
    const result = await post(ctx, 'run-4')
    expect(result).toEqual({ kind: 'spooled', runId: 'run-4', reason: 'auth' })
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud when a credential reference is set but no credentials service is loaded', async () => {
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' }, { credentials: false })
    await expect(post(ctx, 'run-5')).rejects.toThrow(/no ctx.credentials service loaded/)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud when the transport reports an unexpected status', async () => {
    const { fetch } = fakeFetch(404)
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    await expect(post(ctx, 'run-6')).rejects.toThrow(/unexpected tracker response status 404/)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud when the transport cannot reach the tracker', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('network down') }) as unknown as (typeof globalThis)['fetch']
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    const result = await post(ctx, 'run-7')
    expect(result).toEqual({ kind: 'spooled', runId: 'run-7', reason: 'unreachable' })
    await rm(dir, { recursive: true, force: true })
  })

  it('returns landed when the transport lands a post (subclass seam)', async () => {
    const { ctx, dir } = await mount(LandingShrestechTracker, { credentialRef: 'TRACKER_TOKEN' })
    const result = await ctx.tracker.postRun('run-8' as TrackerRunId, spec)
    expect(result).toEqual({ kind: 'landed', runId: 'run-8' })
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ShrestechTrackerService.postMetrics', () => {
  it('spools a metric append for the sync drain', async () => {
    const { ctx, dir } = await mount(ShrestechTrackerService)
    const metrics = [{ name: 'loss', value: 0.5 }]
    await expect(ctx.tracker.postMetrics('run-1' as TrackerRunId, metrics)).resolves.toBeUndefined()
    await expect(ctx.tracker.queryRuns({})).resolves.toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ShrestechTrackerService.queryRuns', () => {
  it('returns landed runs from the index plus spooled runs, applying filters', async () => {
    const { fetch } = fakeFetch(200)
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    await post(ctx, 'run-a')            // lands
    await post(ctx, 'run-b', { ...spec, experiment: 'other' }) // lands
    // A run held spooled for an unreachable transport.
    const { fetch: failFetch } = fakeFetch(503)
    vi.stubGlobal('fetch', failFetch)
    await post(ctx, 'run-c')

    const all = await ctx.tracker.queryRuns({})
    expect(all).toHaveLength(3)
    expect(all.find(r => r.runId === 'run-c')?.reason).toBe('unreachable')

    const filtered = await ctx.tracker.queryRuns({ experiment: 'study' })
    expect(filtered.map(r => r.runId)).toEqual(['run-a', 'run-c'])

    const bySha = await ctx.tracker.queryRuns({ gitSha: 'abc123' })
    expect(bySha).toHaveLength(3)

    const since = await ctx.tracker.queryRuns({ since: '2999-01-01T00:00:00.000Z' })
    expect(since).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })
})

describe('ShrestechTrackerService.sync', () => {
  it('is a no-op in spool-only mode (no credential reference)', async () => {
    const { ctx, dir } = await mount(ShrestechTrackerService, {}, { credentials: false })
    await expect(provider(ctx).sync()).resolves.toEqual({ landedRunIds: [], failedRunIds: [] })
    await rm(dir, { recursive: true, force: true })
  })

  it('is a no-op when the credential reference is set but unconfigured', async () => {
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' }, { seed: {} })
    await expect(provider(ctx).sync()).resolves.toEqual({ landedRunIds: [], failedRunIds: [] })
    await rm(dir, { recursive: true, force: true })
  })

  it('drains the run spool through /api/sync, marking landed runs in the index and re-spooling rejected runs', async () => {
    const { fetch: failFetch } = fakeFetch(503)
    vi.stubGlobal('fetch', failFetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    // Two runs held in the spool, plus a metric append for one of them.
    await post(ctx, 'run-1')
    await post(ctx, 'run-2')
    await ctx.tracker.postMetrics('run-1' as TrackerRunId, [{ name: 'loss', value: 0.5 }])

    // Server accepts run-1 only.
    const { fetch } = fakeFetch(200, { landedRunIds: ['run-1'] })
    vi.stubGlobal('fetch', fetch)
    const result = await provider(ctx).sync()
    expect(result.landedRunIds).toEqual(['run-1'])
    expect(result.failedRunIds).toEqual(['run-2'])

    const runs = await ctx.tracker.queryRuns({})
    expect(runs.find(r => r.runId === 'run-1')?.reason).toBeUndefined()
    expect(runs.find(r => r.runId === 'run-2')?.reason).toBe('spooled')
    await rm(dir, { recursive: true, force: true })
  })

  it('re-spools every drained run and metric append when the sync transport fails', async () => {
    const { fetch } = fakeFetch(503)
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    await post(ctx, 'run-1')
    await ctx.tracker.postMetrics('run-1' as TrackerRunId, [{ name: 'loss', value: 0.5 }])
    const result = await provider(ctx).sync()
    expect(result).toEqual({ landedRunIds: [], failedRunIds: ['run-1'] })
    // Both the run and its metric remain spooled.
    const runs = await ctx.tracker.queryRuns({})
    expect(runs.find(r => r.runId === 'run-1')?.reason).toBe('unreachable')
    await rm(dir, { recursive: true, force: true })
  })

  it('re-enqueues metrics whose run did not land and drops metrics for landed runs', async () => {
    const { fetch: failFetch } = fakeFetch(503)
    vi.stubGlobal('fetch', failFetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    await post(ctx, 'run-1')
    await post(ctx, 'run-2')
    await ctx.tracker.postMetrics('run-1' as TrackerRunId, [{ name: 'a', value: 1 }])
    await ctx.tracker.postMetrics('run-2' as TrackerRunId, [{ name: 'b', value: 2 }])
    const { fetch } = fakeFetch(200, { landedRunIds: ['run-1'] })
    vi.stubGlobal('fetch', fetch)
    await provider(ctx).sync()
    const runs = await ctx.tracker.queryRuns({})
    expect(runs.find(r => r.runId === 'run-1')?.reason).toBeUndefined()
    expect(runs.find(r => r.runId === 'run-2')?.reason).toBe('spooled')
    await rm(dir, { recursive: true, force: true })
  })

  it('does not POST when the spool is empty', async () => {
    const { fetch, calls } = fakeFetch(200, { landedRunIds: [] })
    vi.stubGlobal('fetch', fetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    await expect(provider(ctx).sync()).resolves.toEqual({ landedRunIds: [], failedRunIds: [] })
    expect(calls).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud when a sync response body is malformed', async () => {
    const { fetch: failFetch } = fakeFetch(503)
    vi.stubGlobal('fetch', failFetch)
    const { ctx, dir } = await mount(ShrestechTrackerService, { credentialRef: 'TRACKER_TOKEN' })
    await post(ctx, 'run-1')
    const { fetch } = fakeFetch(200, { notLanded: true })
    vi.stubGlobal('fetch', fetch)
    await expect(provider(ctx).sync()).rejects.toThrow(/landedRunIds/)
    await rm(dir, { recursive: true, force: true })
  })
})
