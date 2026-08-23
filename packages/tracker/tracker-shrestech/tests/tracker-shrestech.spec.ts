import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import SessionStore from '@shres-code/shres-code-session'
import ShrestechTrackerService from '@shres-code/shres-code-tracker-shrestech'
import type { Config } from '@shres-code/shres-code-tracker-shrestech'
import type { LogRunSpec, TrackerFailureReason, TrackerRunId } from '@shres-code/shres-code-tracker'

/** A provider whose transport lands a post (stage-2 posture, tested now). */
class LandingShrestechTracker extends ShrestechTrackerService {
  protected async attemptPost(_runId: TrackerRunId, _spec: LogRunSpec): Promise<'landed' | TrackerFailureReason> {
    return 'landed'
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

/** A scratch directory plus a spool path inside it. */
async function scratch(): Promise<{ dir: string; spoolPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-provider-'))
  return { dir, spoolPath: join(dir, 'spool.jsonl') }
}

/** Mount a tracker provider on a fresh context with an isolated spool. */
async function mount(Service: typeof ShrestechTrackerService, overrides: Partial<Config> = {}): Promise<{
  ctx: Context
  scratchDir: string
}> {
  const { dir, spoolPath } = await scratch()
  const ctx = new Context()
  await ctx.plugin(Service, {
    baseUrl: 'https://tracker.example.com',
    lane: 'research',
    spoolPath,
    ...overrides,
  })
  return { ctx, scratchDir: dir }
}

describe('ShrestechTrackerService mount', () => {
  it('fails loud at mount on an empty baseUrl', async () => {
    const { spoolPath, dir } = await scratch()
    await expect(new Context().plugin(ShrestechTrackerService, { baseUrl: '   ', lane: 'research', spoolPath }))
      .rejects.toThrow(/baseUrl must be a non-empty string/)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails loud at mount on an empty lane', async () => {
    const { spoolPath, dir } = await scratch()
    await expect(new Context().plugin(ShrestechTrackerService, { baseUrl: 'https://x', lane: '', spoolPath }))
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

describe('ShrestechTrackerService.postRun', () => {
  it('spool-only mode holds a run with a spooled reason when no credential reference is set', async () => {
    const { ctx, scratchDir } = await mount(ShrestechTrackerService)
    const result = await ctx.tracker.postRun('run-1' as TrackerRunId, spec)
    expect(result).toEqual({ kind: 'spooled', runId: 'run-1', reason: 'spooled' })
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('spools an attempted run with an unreachable reason when the transport is unavailable', async () => {
    const { ctx, scratchDir } = await mount(ShrestechTrackerService, { credentialRef: 'tracker-token' })
    const result = await ctx.tracker.postRun('run-2' as TrackerRunId, spec)
    expect(result).toEqual({ kind: 'spooled', runId: 'run-2', reason: 'unreachable' })
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('returns landed when the transport reports a delivered post', async () => {
    const { ctx, scratchDir } = await mount(LandingShrestechTracker, { credentialRef: 'tracker-token' })
    const result = await ctx.tracker.postRun('run-3' as TrackerRunId, spec)
    expect(result).toEqual({ kind: 'landed', runId: 'run-3' })
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('logMetrics resolves without persisting (stage-1 no-op)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const { dir, spoolPath } = await scratch()
    await ctx.plugin(ShrestechTrackerService, {
      baseUrl: 'https://tracker.example.com',
      lane: 'research',
      spoolPath,
    })
    const session = ctx.sessions.create()
    await expect(ctx.tracker.logMetrics(session, 'run-1' as TrackerRunId, [{ name: 'loss', value: 0.5 }]))
      .resolves.toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ShrestechTrackerService.queryRuns', () => {
  it('filters spooled runs by experiment, git sha, and since', async () => {
    const { ctx, scratchDir } = await mount(ShrestechTrackerService)
    // Two runs spooled at distinct times, one in a different experiment.
    await ctx.tracker.postRun('run-a' as TrackerRunId, spec)
    await ctx.tracker.postRun('run-b' as TrackerRunId, { ...spec, experiment: 'other' })
    const all = await ctx.tracker.queryRuns({})
    expect(all).toHaveLength(2)
    expect(all[0]?.reason).toBe('spooled')

    const filtered = await ctx.tracker.queryRuns({ experiment: 'study' })
    expect(filtered.map(r => r.experiment)).toEqual(['study'])

    const bySha = await ctx.tracker.queryRuns({ gitSha: 'abc123' })
    expect(bySha).toHaveLength(2)

    const since = await ctx.tracker.queryRuns({ since: '2999-01-01T00:00:00.000Z' })
    expect(since).toHaveLength(0)

    const past = await ctx.tracker.queryRuns({ since: '2000-01-01T00:00:00.000Z' })
    expect(past).toHaveLength(2)

    await rm(scratchDir, { recursive: true, force: true })
  })
})
