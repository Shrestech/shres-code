import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import TrackerService, {
  TrackerError,
  newTrackerRunId,
  resolveLogRun,
} from '@shres-code/shres-code-tracker'
import type {
  LogRunRequest,
  LogRunSpec,
  MetricPoint,
  RunFilter,
  TrackerRunId,
  TrackerRunRecord,
} from '@shres-code/shres-code-tracker'

/** A scripted provider service for contract tests. */
class StubTracker extends TrackerService {
  /** Where each posted run lands: `landed` or `spooled`. */
  outcome: 'landed' | 'spooled' = 'landed'
  readonly posts: Array<{ runId: TrackerRunId; spec: LogRunSpec }> = []
  readonly metricPosts: Array<{ runId: TrackerRunId; metrics: MetricPoint[] }> = []
  /** Runs returned by {@link getRun}, keyed by run id. */
  runs = new Map<TrackerRunId, TrackerRunRecord>()
  /** Metrics returned by {@link getMetrics}, keyed by run id. */
  metrics = new Map<TrackerRunId, MetricPoint[]>()

  async postRun(runId: TrackerRunId, spec: LogRunSpec): ReturnType<TrackerService['postRun']> {
    this.posts.push({ runId, spec })
    return this.outcome === 'landed'
      ? { kind: 'landed', runId }
      : { kind: 'spooled', runId, reason: 'spooled' }
  }

  async postMetrics(runId: TrackerRunId, metrics: MetricPoint[]): Promise<void> {
    this.metricPosts.push({ runId, metrics })
  }

  async queryRuns(_filter: RunFilter): ReturnType<TrackerService['queryRuns']> {
    return []
  }

  async getRun(runId: TrackerRunId): Promise<TrackerRunRecord | undefined> {
    return this.runs.get(runId)
  }

  async getMetrics(runId: TrackerRunId): Promise<MetricPoint[]> {
    return this.metrics.get(runId) ?? []
  }
}

/** Mount a session store plus the stub tracker on a fresh root context. */
async function mount(): Promise<{ ctx: Context; tracker: StubTracker; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(StubTracker)
  const session = ctx.sessions.create()
  return { ctx, tracker: ctx.tracker as StubTracker, session }
}

function validRequest(overrides: Partial<LogRunRequest> = {}): LogRunRequest {
  return {
    experiment: 'study',
    hypothesis: 'h',
    decisionRule: 'val_bpb < 1.0',
    dataVersion: 'v3',
    gitSha: 'abc123',
    ...overrides,
  }
}

describe('newTrackerRunId', () => {
  it('returns a non-empty branded run id', () => {
    expect(newTrackerRunId().length).toBeGreaterThan(0)
  })
})

describe('resolveLogRun', () => {
  it('defaults metrics and artifacts to empty lists', () => {
    const spec = resolveLogRun(validRequest())
    expect(spec.metrics).toEqual([])
    expect(spec.artifacts).toEqual([])
  })

  it('carries supplied metrics and artifacts through', () => {
    const spec = resolveLogRun(validRequest({ metrics: [{ name: 'loss', value: 1 }], artifacts: ['modelstore://a'] }))
    expect(spec.metrics).toEqual([{ name: 'loss', value: 1 }])
    expect(spec.artifacts).toEqual(['modelstore://a'])
  })

  it('keeps string values exactly as supplied', () => {
    const spec = resolveLogRun(validRequest())
    expect(spec.experiment).toBe('study')
    expect(spec.hypothesis).toBe('h')
    expect(spec.decisionRule).toBe('val_bpb < 1.0')
  })

  it.each([
    ['experiment', { experiment: '' }],
    ['experiment', { experiment: '   ' }],
    ['experiment', { experiment: undefined }],
    ['decisionRule', { decisionRule: '' }],
    ['dataVersion', { dataVersion: '' }],
    ['gitSha', { gitSha: '' }],
  ])('rejects a missing required %s', (field, overrides) => {
    expect(() => resolveLogRun(validRequest({ ...overrides } as LogRunRequest)))
      .toThrow(new RegExp(`requires a non-empty ${field}`))
  })

  it('carries a valid machineRule through to the spec', () => {
    const spec = resolveLogRun(validRequest({ machineRule: { metric: 'val_bpb', op: '<', threshold: 1.0 } }))
    expect(spec.machineRule).toEqual({ metric: 'val_bpb', op: '<', threshold: 1.0 })
  })

  it('leaves machineRule undefined when the request omits it', () => {
    const spec = resolveLogRun(validRequest())
    expect(spec.machineRule).toBeUndefined()
  })

  it.each([
    ['metric', { metric: '' }],
    ['metric', { metric: '   ' }],
    ['op', { op: '!=' }],
    ['threshold', { threshold: Number.NaN }],
    ['threshold', { threshold: Number.POSITIVE_INFINITY }],
  ])('rejects an invalid machineRule %s', (_field, overrides) => {
    expect(() => resolveLogRun(validRequest({
      machineRule: { metric: 'val_bpb', op: '<', threshold: 1.0, ...overrides },
    } as LogRunRequest)))
      .toThrow(TrackerError)
  })

  it('rejects an invalid machineRule with the machine code', () => {
    let caught: unknown
    try {
      resolveLogRun(validRequest({ machineRule: { metric: '', op: '<', threshold: 1.0 } }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TrackerError)
    expect((caught as TrackerError).code).toBe('TRACKER_INVALID_MACHINE_RULE')
  })
})

describe('TrackerError', () => {
  it('carries its machine code', () => {
    const error = new TrackerError('boom', 'TRACKER_REQUIRED_FIELD')
    expect(error.code).toBe('TRACKER_REQUIRED_FIELD')
    expect(error.name).toBe('TrackerError')
  })
})

describe('TrackerService.logRun', () => {
  it('resolves the request, delegates to the provider, and logs a landed run event', async () => {
    const { tracker, session } = await mount()
    const request = validRequest({ metrics: [{ name: 'loss', value: 0.5 }] })
    const callId = CallId('call-1')
    const result = await tracker.logRun(session, request, callId)

    expect(result).toEqual({ kind: 'landed', runId: result.runId })
    expect(tracker.posts).toHaveLength(1)
    expect(tracker.posts[0]?.runId).toBe(result.runId)
    expect(tracker.posts[0]?.spec.experiment).toBe('study')
    expect(tracker.posts[0]?.spec.metrics).toEqual([{ name: 'loss', value: 0.5 }])

    const event = session.events.find(entry => entry.type === 'tracker/run')
    expect(event?.data).toMatchObject({
      runId: result.runId,
      callId,
      experiment: 'study',
      decisionRule: 'val_bpb < 1.0',
      gitSha: 'abc123',
    })
  })

  it('logs a spooled run event and returns the reason when the provider spools', async () => {
    const { tracker, session } = await mount()
    tracker.outcome = 'spooled'
    const result = await tracker.logRun(session, validRequest(), CallId('call-2'))
    expect(result).toEqual({ kind: 'spooled', runId: result.runId, reason: 'spooled' })
    const event = session.events.find(entry => entry.type === 'tracker/run')
    expect(event?.data).toMatchObject({ runId: result.runId })
  })

  it('rejects an invalid request before calling the provider or writing an event', async () => {
    const { tracker, session } = await mount()
    await expect(tracker.logRun(session, validRequest({ gitSha: '' }), CallId('call-3'))).rejects.toThrow(TrackerError)
    expect(tracker.posts).toHaveLength(0)
    expect(session.events.some(entry => entry.type === 'tracker/run')).toBe(false)
  })
})

describe('TrackerService.logMetrics', () => {
  it('delegates to the provider and logs the metrics event', async () => {
    const { tracker, session } = await mount()
    const runId = newTrackerRunId()
    const metrics = [{ name: 'loss', value: 0.25 }]
    await tracker.logMetrics(session, runId, metrics)
    expect(tracker.metricPosts).toEqual([{ runId, metrics }])
    const event = session.events.find(entry => entry.type === 'tracker/metrics')
    expect(event?.data).toEqual({ runId, metrics })
  })
})

describe('TrackerService.queryRuns', () => {
  it('delegates to the provider', async () => {
    const { tracker } = await mount()
    await expect(tracker.queryRuns({ experiment: 'study' })).resolves.toEqual([])
  })
})

describe('TrackerService.verifyDecisionRule', () => {
  /** A run record with a machine rule, ready to seed the stub store. */
  function seededRun(overrides: Partial<TrackerRunRecord> = {}): TrackerRunRecord {
    return {
      runId: 'run-1' as TrackerRunId,
      experiment: 'study',
      decisionRule: 'val_bpb < 1.0',
      dataVersion: 'v3',
      gitSha: 'abc123',
      machineRule: { metric: 'val_bpb', op: '<', threshold: 1.0 },
      ...overrides,
    }
  }

  function seededRunWithoutMachineRule(): TrackerRunRecord {
    const run = seededRun()
    return {
      runId: run.runId,
      experiment: run.experiment,
      decisionRule: run.decisionRule,
      dataVersion: run.dataVersion,
      gitSha: run.gitSha,
    }
  }

  it('refuses a run that is not stored', async () => {
    const { tracker } = await mount()
    const verdict = await tracker.verifyDecisionRule('run-missing' as TrackerRunId)
    if (verdict.status !== 'refused') throw new Error('expected a refusal')
    expect(verdict.reason).toBe('run-not-found')
    expect(verdict.detail).toContain('run-missing')
  })

  it('refuses a run with no machine rule (fail-loud, never guessed)', async () => {
    const { tracker } = await mount()
    const run = seededRunWithoutMachineRule()
    tracker.runs.set(run.runId, run)
    const verdict = await tracker.verifyDecisionRule(run.runId)
    if (verdict.status !== 'refused') throw new Error('expected a refusal')
    expect(verdict.reason).toBe('no-machine-rule')
    expect(verdict.detail).toContain(run.runId)
  })

  it('refuses a run with zero logged metrics', async () => {
    const { tracker } = await mount()
    const run = seededRun()
    tracker.runs.set(run.runId, run)
    tracker.metrics.set(run.runId, [])
    const verdict = await tracker.verifyDecisionRule(run.runId)
    if (verdict.status !== 'refused') throw new Error('expected a refusal')
    expect(verdict.reason).toBe('metrics-missing')
    expect(verdict.detail).toContain(run.runId)
  })

  it('refuses a run whose machine rule names a metric never logged', async () => {
    const { tracker } = await mount()
    const run = seededRun()
    tracker.runs.set(run.runId, run)
    tracker.metrics.set(run.runId, [{ name: 'loss', value: 0.5 }])
    const verdict = await tracker.verifyDecisionRule(run.runId)
    if (verdict.status !== 'refused') throw new Error('expected a refusal')
    expect(verdict.reason).toBe('metric-not-in-run')
    expect(verdict.detail).toContain('val_bpb')
  })

  it.each([
    ['>', 2, 1, true],
    ['>', 1, 1, false],
    ['>=', 1, 1, true],
    ['>=', 0.5, 1, false],
    ['<', 0.5, 1, true],
    ['<', 1, 1, false],
    ['<=', 1, 1, true],
    ['<=', 2, 1, false],
    ['==', 1, 1, true],
    ['==', 1.5, 1, false],
  ] as const)('applies op %s against the latest value', async (op, value, threshold, satisfied) => {
    const { tracker } = await mount()
    const run = seededRun({ machineRule: { metric: 'val_bpb', op, threshold } })
    tracker.runs.set(run.runId, run)
    tracker.metrics.set(run.runId, [{ name: 'val_bpb', value }])
    const verdict = await tracker.verifyDecisionRule(run.runId)
    expect(verdict.status).toBe(satisfied ? 'satisfied' : 'unsatisfied')
    if (verdict.status === 'satisfied' || verdict.status === 'unsatisfied') {
      expect(verdict.rule).toEqual(run.machineRule)
      expect(verdict.actual).toBe(value)
    }
  })

  it('uses the latest append of the named metric, not the first', async () => {
    const { tracker } = await mount()
    const run = seededRun({ machineRule: { metric: 'val_bpb', op: '<', threshold: 1.0 } })
    tracker.runs.set(run.runId, run)
    tracker.metrics.set(run.runId, [
      { name: 'val_bpb', value: 0.2 },
      { name: 'loss', value: 0.5 },
      { name: 'val_bpb', value: 1.5 },
    ])
    const verdict = await tracker.verifyDecisionRule(run.runId)
    expect(verdict).toEqual({ status: 'unsatisfied', rule: run.machineRule, actual: 1.5 })
  })

  it('resolves a spool-only (un-landed) run and verifies its rule', async () => {
    const { tracker } = await mount()
    const run = seededRun({ reason: 'spooled' })
    tracker.runs.set(run.runId, run)
    tracker.metrics.set(run.runId, [{ name: 'val_bpb', value: 0.5 }])
    const verdict = await tracker.verifyDecisionRule(run.runId)
    expect(verdict).toEqual({ status: 'satisfied', rule: run.machineRule, actual: 0.5 })
  })
})
