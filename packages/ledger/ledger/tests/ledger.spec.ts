import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import TrackerService from '@shres-code/shres-code-tracker'
import type { LogRunSpec, MetricPoint, RunFilter, TrackerDecisionRuleVerdict, TrackerRunId, TrackerRunRecord, TrackerRunResult, TrackerRunSummary } from '@shres-code/shres-code-tracker'
import FileLedgerService, { LedgerService } from '@shres-code/shres-code-ledger'
import type { LedgerEntry, LedgerEntryId, LedgerRequest } from '@shres-code/shres-code-ledger'

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

/** A ledger provider whose persistRecord throws a non-LedgerError. */
class ThrowingLedger extends LedgerService {
  async persistRecord(): Promise<void> {
    throw new Error('boom')
  }

  async queryEntries(): Promise<LedgerEntry[]> {
    return []
  }

  hasEntry(): boolean {
    return false
  }
}

function runId(id: string): TrackerRunId {
  return id as TrackerRunId
}

function validRequest(overrides: Partial<LedgerRequest> = {}): LedgerRequest {
  return {
    hypothesis: 'h',
    decision: 'accepted',
    evidence: { runIds: [runId('run-1')] },
    rationale: 'r',
    ...overrides,
  }
}

/** Mount a session store, a tracker stub, and the file ledger on a fresh context. */
async function mount(): Promise<{ ctx: Context; session: Session; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-service-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(StubTracker)
  await ctx.plugin(FileLedgerService, { storagePath: join(dir, 'ledger.jsonl') })
  const session = ctx.sessions.create()
  return { ctx, session, dir }
}

describe('FileLedgerService mount', () => {
  it('fails loud at mount on an empty storagePath', async () => {
    const ctx = new Context()
    await ctx.plugin(StubTracker)
    await expect(ctx.plugin(FileLedgerService, { storagePath: '   ' }))
      .rejects.toThrow(/storagePath must be a non-empty string/)
  })
})

describe('LedgerService.record', () => {
  it('records a decision, persists it, and logs the event', async () => {
    const { ctx, session, dir } = await mount()
    ;(ctx.tracker as StubTracker).knownRuns = [runId('run-1')]
    const callId = CallId('call-1')
    const result = await ctx.ledger.record(session, validRequest(), callId)

    expect(result).toEqual({ kind: 'recorded', entryId: result.entryId })
    const entries = await ctx.ledger.query({})
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entryId).toBe(result.entryId)
    expect(entries[0]?.evidence.runIds).toEqual([runId('run-1')])

    const event = session.events.find(entry => entry.type === 'ledger/decision')
    expect(event?.data).toMatchObject({
      entryId: result.entryId,
      hypothesis: 'h',
      decision: 'accepted',
      runIds: [runId('run-1')],
      callId,
    })
    await rm(dir, { recursive: true, force: true })
  })

  it('returns failed with unresolved-run when a cited run id does not resolve', async () => {
    const { ctx, session, dir } = await mount()
    ;(ctx.tracker as StubTracker).knownRuns = []
    const result = await ctx.ledger.record(session, validRequest(), CallId('call-2'))
    expect(result).toEqual({ kind: 'failed', entryId: result.entryId, reason: 'unresolved-run' })
    expect(session.events.some(entry => entry.type === 'ledger/decision')).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it('returns failed with the validation reason when the request is invalid', async () => {
    const { ctx, session, dir } = await mount()
    const result = await ctx.ledger.record(session, validRequest({ hypothesis: '' }), CallId('call-3'))
    expect(result).toEqual({ kind: 'failed', entryId: result.entryId, reason: 'required-field' })
    expect(session.events.some(entry => entry.type === 'ledger/decision')).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it('returns failed with corrupt-store when the store has a corrupt line', async () => {
    const { ctx, session, dir } = await mount()
    ;(ctx.tracker as StubTracker).knownRuns = [runId('run-1')]
    await writeFile(join(dir, 'ledger.jsonl'), 'not-json\n', 'utf8')
    const result = await ctx.ledger.record(session, validRequest(), CallId('call-4'))
    expect(result).toEqual({ kind: 'failed', entryId: result.entryId, reason: 'corrupt-store' })
    await rm(dir, { recursive: true, force: true })
  })

  it('rethrows a non-LedgerError from the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(StubTracker)
    await ctx.plugin(ThrowingLedger)
    const session = ctx.sessions.create()
    ;(ctx.tracker as StubTracker).knownRuns = [runId('run-1')]
    await expect(ctx.ledger.record(session, validRequest(), CallId('call-5'))).rejects.toThrow('boom')
  })

  it('rethrows a non-LedgerError from resolveRecord', async () => {
    const { ctx, session, dir } = await mount()
    const badRequest = { hypothesis: 'h', decision: 'accepted', evidence: undefined, rationale: 'r' } as unknown as LedgerRequest
    await expect(ctx.ledger.record(session, badRequest, CallId('call-8'))).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('LedgerService.query', () => {
  it('queries entries from the store', async () => {
    const { ctx, session, dir } = await mount()
    ;(ctx.tracker as StubTracker).knownRuns = [runId('run-1')]
    await ctx.ledger.record(session, validRequest(), CallId('call-6'))
    const entries = await ctx.ledger.query({ decision: 'accepted' })
    expect(entries).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('LedgerService.hasEntry', () => {
  it('reports whether an entry id is present in the store', async () => {
    const { ctx, session, dir } = await mount()
    ;(ctx.tracker as StubTracker).knownRuns = [runId('run-1')]
    const result = await ctx.ledger.record(session, validRequest(), CallId('call-7'))
    expect(ctx.ledger.hasEntry(result.entryId)).toBe(true)
    expect(ctx.ledger.hasEntry('entry-unknown' as LedgerEntryId)).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})
