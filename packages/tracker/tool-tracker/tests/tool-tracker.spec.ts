import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import ToolRuntime from '@shres-code/shres-code-tools'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import TrackerService from '@shres-code/shres-code-tracker'
import type {
  LogRunSpec,
  MetricPoint,
  RunFilter,
  TrackerRunId,
  TrackerRunResult,
  TrackerRunSummary,
} from '@shres-code/shres-code-tracker'
import { Session, SessionId } from '@shres-code/shres-code-session'

import * as tool from '../src/index.ts'

/** A scripted tracker provider: controllable land/spool outcome and query results. */
class StubTracker extends TrackerService {
  spooled = false
  queryResults: TrackerRunSummary[] = []

  async postRun(runId: TrackerRunId, _spec: LogRunSpec): Promise<TrackerRunResult> {
    return this.spooled
      ? { kind: 'spooled', runId, reason: 'unreachable' }
      : { kind: 'landed', runId }
  }

  async postMetrics(_runId: TrackerRunId, _metrics: readonly MetricPoint[]): Promise<void> {}

  async queryRuns(_filter: RunFilter): Promise<TrackerRunSummary[]> {
    return this.queryResults
  }
}

/** A parent Agent (as the tools see it) backed by a real Session. */
type FakeAgent = { session: Session }

/** A parent Agent backed by a real Session — the tools read `agent.session`. */
function agentWithSession(id = 'parent-1'): FakeAgent {
  const session = Session.create(SessionId(id))
  return { session }
}

async function setup(): Promise<{ ctx: Context; tracker: StubTracker }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubTracker)
  await ctx.plugin(tool)
  return { ctx, tracker: ctx.tracker as StubTracker }
}

const testSignal = new AbortController().signal
let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, over: { agent?: FakeAgent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testSignal,
    callId: `call-${++callCounter}`,
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const runArgs = {
  experiment: 'study',
  hypothesis: 'h',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v3',
  gitSha: 'abc123',
  metrics: [{ name: 'loss', value: 0.5 }],
  artifacts: ['modelstore://a'],
}

/** The same run without optional metrics/artifacts (covering the omit branches). */
const runArgsMinimal = {
  experiment: 'study',
  hypothesis: 'h',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v3',
  gitSha: 'abc123',
}

describe('shres-tool-tracker registration', () => {
  it('registers the three experiment tools with their schemas', async () => {
    const { ctx } = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual(['experiment_log_metrics', 'experiment_log_run', 'experiment_query'])
    const run = ctx.tools.get('experiment_log_run')!
    const props = (run.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'artifacts', 'dataVersion', 'decisionRule', 'experiment', 'gitSha', 'hypothesis', 'metrics',
    ])
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-tracker')
    expect(tool.inject).toEqual(['tools', 'tracker'])
    expect(typeof tool.apply).toBe('function')
  })

  it('unregisters the tools when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubTracker)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(s => s.name === 'experiment_log_run')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'experiment_log_run')).toBe(false)
  })
})

describe('experiment_log_run', () => {
  it('logs a landed run, returns its id, and writes the tracker/run event', async () => {
    const { ctx } = await setup()
    const agent = agentWithSession('runner')
    const result = await callTool(ctx, 'experiment_log_run', runArgs, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected experiment_log_run success')
    expect(result.value.status).toBe('landed')
    expect(typeof result.value.runId).toBe('string')
    expect(text(result)).toContain('Logged experiment run')

    const event = agent.session.events.findLast(e => e.type === 'tracker/run')
    expect(event?.data).toMatchObject({
      runId: result.value.runId,
      callId: expect.any(String),
      experiment: 'study',
      decisionRule: 'val_bpb < 1.0',
      gitSha: 'abc123',
    })
  })

  it('surfaces the failure taxonomy verbatim when the run is spooled', async () => {
    const { ctx, tracker } = await setup()
    tracker.spooled = true
    const result = await callTool(ctx, 'experiment_log_run', runArgsMinimal)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected experiment_log_run success')
    expect(result.value.status).toBe('spooled')
    expect(result.value.reason).toBe('unreachable')
    expect(text(result)).toContain('reason: unreachable')
  })

  it('rejects a non-agent caller', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'experiment_log_run', runArgs, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('presents the call as a generic card titled by the experiment', async () => {
    const { ctx } = await setup()
    const view = ctx.tools.get('experiment_log_run')!.presentCall?.(runArgs)
    expect(view).toEqual({ card: 'generic', title: 'study', kind: 'other', rawInput: 'study' })
  })

  it('presents the metrics and query calls as generic cards', async () => {
    const { ctx } = await setup()
    const metricsView = ctx.tools.get('experiment_log_metrics')!.presentCall?.({ runId: 'run-1', metrics: [{ name: 'loss', value: 0.5 }] })
    expect(metricsView?.card).toBe('generic')
    const queryView = ctx.tools.get('experiment_query')!.presentCall?.({})
    expect(queryView?.card).toBe('generic')
  })
})

describe('experiment_log_metrics', () => {
  it('appends metrics and returns the count', async () => {
    const { ctx } = await setup()
    const agent = agentWithSession('metrics')
    const metrics = [{ name: 'loss', value: 0.5 }, { name: 'val_bpb', value: 0.9 }]
    const result = await callTool(ctx, 'experiment_log_metrics', { runId: 'run-1', metrics }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected experiment_log_metrics success')
    expect(result.value).toEqual({ runId: 'run-1', metricsCount: 2 })
    expect(text(result)).toContain('Appended 2 metric points to run run-1')

    const event = agent.session.events.findLast(e => e.type === 'tracker/metrics')
    expect(event?.data).toEqual({ runId: 'run-1', metrics })
  })
})

describe('experiment_query', () => {
  it('returns filtered run summaries and renders them', async () => {
    const { ctx, tracker } = await setup()
    tracker.queryResults = [{
      runId: 'run-1' as TrackerRunId,
      experiment: 'study',
      decisionRule: 'val_bpb < 1.0',
      dataVersion: 'v3',
      gitSha: 'abc123',
    }, {
      runId: 'run-2' as TrackerRunId,
      experiment: 'study',
      decisionRule: 'val_bpb < 1.0',
      dataVersion: 'v3',
      gitSha: 'abc123',
      reason: 'spooled',
    }]
    const result = await callTool(ctx, 'experiment_query', { experiment: 'study' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected experiment_query success')
    expect(result.value.runs).toHaveLength(2)
    expect(result.value.runs[1]?.reason).toBe('spooled')
    expect(text(result)).toContain('(not landed: spooled)')
  })

  it('reports no runs found when the store is empty', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'experiment_query', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected experiment_query success')
    expect(text(result)).toContain('No experiment runs found.')
  })

  it('passes gitSha and since filters through to the store', async () => {
    const { ctx, tracker } = await setup()
    tracker.queryResults = [{
      runId: 'run-1' as TrackerRunId,
      experiment: 'study',
      decisionRule: 'val_bpb < 1.0',
      dataVersion: 'v3',
      gitSha: 'abc123',
    }]
    const result = await callTool(ctx, 'experiment_query', { gitSha: 'abc123', since: '2026-01-01T00:00:00.000Z' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected experiment_query success')
    expect(result.value.runs).toHaveLength(1)
  })
})

describe('output formatters', () => {
  it('formats landed and spooled run outputs', () => {
    expect(tool.formatRunOutput({ runId: 'r', status: 'landed' })).toContain('Logged experiment run')
    expect(tool.formatRunOutput({ runId: 'r', status: 'spooled', reason: 'auth' })).toContain('reason: auth')
    // A spooled run with no reason reported falls back to "unknown".
    expect(tool.formatRunOutput({ runId: 'r', status: 'spooled' })).toContain('reason: unknown')
  })

  it('formats a single metric point with singular grammar', () => {
    expect(tool.formatMetricsOutput({ runId: 'r', metricsCount: 1 })).toContain('1 metric point')
  })
})
