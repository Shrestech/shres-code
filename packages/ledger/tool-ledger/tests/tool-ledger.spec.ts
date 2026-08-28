import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import ToolRuntime from '@shres-code/shres-code-tools'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import TrackerService from '@shres-code/shres-code-tracker'
import type { LogRunSpec, MetricPoint, RunFilter, TrackerDecisionRuleVerdict, TrackerRunId, TrackerRunRecord, TrackerRunResult, TrackerRunSummary } from '@shres-code/shres-code-tracker'
import FileLedgerService from '@shres-code/shres-code-ledger'
import { Session, SessionId } from '@shres-code/shres-code-session'

import * as tool from '../src/index.ts'
import type { QueryOutput, RecordDecisionOutput } from '../src/index.ts'

/** A scripted tracker provider: controllable known-run set for evidence resolution. */
class StubTracker extends TrackerService {
  knownRuns: TrackerRunId[] = []

  async postRun(runId: TrackerRunId, _spec: LogRunSpec): Promise<TrackerRunResult> {
    return { kind: 'landed', runId }
  }

  async postMetrics(_runId: TrackerRunId, _metrics: readonly MetricPoint[]): Promise<void> {}

  async queryRuns(_filter: RunFilter): Promise<TrackerRunSummary[]> {
    return this.knownRuns.map(runId => ({ runId, experiment: 'e', decisionRule: 'd', dataVersion: 'v', gitSha: 'g' }))
  }

  override async getRun(runId: TrackerRunId): Promise<TrackerRunRecord | undefined> {
    return this.knownRuns.includes(runId)
      ? { runId, experiment: 'e', decisionRule: 'd', dataVersion: 'v', gitSha: 'g' }
      : undefined
  }

  override async getMetrics(_runId: TrackerRunId): Promise<MetricPoint[]> {
    return []
  }

  override async verifyDecisionRule(runId: TrackerRunId): Promise<TrackerDecisionRuleVerdict> {
    return this.knownRuns.includes(runId)
      ? { status: 'satisfied', rule: { metric: 'val_bpb', op: '<', threshold: 1 }, actual: 0.5 }
      : { status: 'refused', reason: 'run-not-found', detail: runId }
  }
}

/** A parent Agent (as the tools see it) backed by a real Session. */
type FakeAgent = { session: Session }

/** A parent Agent backed by a real Session — the tools read `agent.session`. */
function agentWithSession(id = 'parent-1'): FakeAgent {
  const session = Session.create(SessionId(id))
  return { session }
}

async function setup(): Promise<{ ctx: Context; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tool-ledger-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubTracker)
  await ctx.plugin(FileLedgerService, { storagePath: join(dir, 'ledger.jsonl') })
  await ctx.plugin(tool)
  return { ctx, dir }
}

const testSignal = new AbortController().signal
let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, over: { agent?: FakeAgent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent: agent as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const recordArgs = {
  hypothesis: 'h',
  decision: 'accepted',
  evidence: { runIds: ['run-1'], gitSha: 'abc123', artifactUris: ['modelstore://a'] },
  rationale: 'r',
}

/** The same record without optional gitSha/artifactUris (covering the omit branches). */
const recordArgsMinimal = {
  hypothesis: 'h',
  decision: 'accepted',
  evidence: { runIds: ['run-1'] },
  rationale: 'r',
}

describe('shres-tool-ledger registration', () => {
  it('registers the two ledger tools with their schemas', async () => {
    const { ctx, dir } = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual(['ledger_query', 'ledger_record_decision'])
    const record = ctx.tools.get('ledger_record_decision')!
    const props = (record.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['decision', 'evidence', 'hypothesis', 'rationale'])
    await rm(dir, { recursive: true, force: true })
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-ledger')
    expect(tool.inject).toEqual(['tools', 'ledger'])
    expect(typeof tool.apply).toBe('function')
  })

  it('unregisters the tools when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubTracker)
    await ctx.plugin(FileLedgerService, { storagePath: join(await mkdtemp(join(tmpdir(), 'tool-ledger-hmr-')), 'ledger.jsonl') })
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(s => s.name === 'ledger_record_decision')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'ledger_record_decision')).toBe(false)
  })
})

describe('ledger_record_decision', () => {
  it('records a decision, returns its id, and writes the ledger/decision event', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = ['run-1' as TrackerRunId]
    const agent = agentWithSession('runner')
    const result = await callTool(ctx, 'ledger_record_decision', recordArgs, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_record_decision success')
    const output = result.value as unknown as RecordDecisionOutput
    expect(output.status).toBe('recorded')
    expect(typeof output.entryId).toBe('string')
    expect(text(result)).toContain('Recorded decision')

    const event = agent.session.events.findLast(e => e.type === 'ledger/decision')
    expect(event?.data.entryId).toBe(output.entryId)
    expect(typeof event?.data.callId).toBe('string')
    expect(event?.data.hypothesis).toBe('h')
    expect(event?.data.decision).toBe('accepted')
    await rm(dir, { recursive: true, force: true })
  })

  it('records a decision with minimal evidence', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = ['run-1' as TrackerRunId]
    const result = await callTool(ctx, 'ledger_record_decision', recordArgsMinimal)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_record_decision success')
    expect((result.value as unknown as RecordDecisionOutput).status).toBe('recorded')
    await rm(dir, { recursive: true, force: true })
  })

  it('surfaces the failure taxonomy verbatim when the record is rejected', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = []
    const result = await callTool(ctx, 'ledger_record_decision', recordArgs)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_record_decision success')
    const output = result.value as unknown as RecordDecisionOutput
    expect(output.status).toBe('failed')
    expect(output.reason).toBe('unresolved-run')
    expect(text(result)).toContain('reason: unresolved-run')
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects a non-agent caller', async () => {
    const { ctx, dir } = await setup()
    const result = await callTool(ctx, 'ledger_record_decision', recordArgs, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
    await rm(dir, { recursive: true, force: true })
  })

  it('presents the call as a generic card titled by the hypothesis', async () => {
    const { ctx, dir } = await setup()
    const view = ctx.tools.get('ledger_record_decision')!.presentCall?.(recordArgs)
    expect(view).toEqual({ card: 'generic', title: 'h', kind: 'other', rawInput: 'h' })
    await rm(dir, { recursive: true, force: true })
  })

  it('presents the query call as a generic card', async () => {
    const { ctx, dir } = await setup()
    const view = ctx.tools.get('ledger_query')!.presentCall?.({})
    expect(view?.card).toBe('generic')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ledger_query', () => {
  it('returns recorded entries and renders them', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = ['run-1' as TrackerRunId]
    await callTool(ctx, 'ledger_record_decision', recordArgs)
    const result = await callTool(ctx, 'ledger_query', { decision: 'accepted' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_query success')
    const query = result.value as unknown as QueryOutput
    expect(query.entries).toHaveLength(1)
    expect(query.entries[0]?.runIds).toEqual(['run-1'])
    expect(text(result)).toContain('Ledger decisions:')
    await rm(dir, { recursive: true, force: true })
  })

  it('reports no entries found when the store is empty', async () => {
    const { ctx, dir } = await setup()
    const result = await callTool(ctx, 'ledger_query', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_query success')
    expect(text(result)).toContain('No ledger decisions found.')
    await rm(dir, { recursive: true, force: true })
  })

  it('passes filters through to the store', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = ['run-1' as TrackerRunId]
    await callTool(ctx, 'ledger_record_decision', recordArgs)
    const result = await callTool(ctx, 'ledger_query', { decision: 'rejected' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_query success')
    expect((result.value as unknown as QueryOutput).entries).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  it('passes hypothesisSubstring and since filters through to the store', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = ['run-1' as TrackerRunId]
    await callTool(ctx, 'ledger_record_decision', recordArgs)
    const result = await callTool(ctx, 'ledger_query', { hypothesisSubstring: 'h', since: 0 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_query success')
    expect((result.value as unknown as QueryOutput).entries).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })

  it('omits absent gitSha and artifactUris from query output', async () => {
    const { ctx, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = ['run-1' as TrackerRunId]
    await callTool(ctx, 'ledger_record_decision', recordArgsMinimal)
    const result = await callTool(ctx, 'ledger_query', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ledger_query success')
    const query = result.value as unknown as QueryOutput
    expect(query.entries).toHaveLength(1)
    expect(query.entries[0]?.gitSha).toBeUndefined()
    expect(query.entries[0]?.artifactUris).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('output formatters', () => {
  it('formats recorded and failed record outputs', () => {
    expect(tool.formatRecordOutput({ entryId: 'e', status: 'recorded' })).toContain('Recorded decision')
    expect(tool.formatRecordOutput({ entryId: 'e', status: 'failed', reason: 'unresolved-run' })).toContain('reason: unresolved-run')
    // A failed record with no reason reported falls back to "unknown".
    expect(tool.formatRecordOutput({ entryId: 'e', status: 'failed' })).toContain('reason: unknown')
  })
})
