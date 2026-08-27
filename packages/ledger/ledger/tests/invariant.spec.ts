import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import TrackerService from '@shres-code/shres-code-tracker'
import type { LogRunSpec, MetricPoint, RunFilter, TrackerRunId, TrackerRunResult, TrackerRunSummary, TrackerRunRecord } from '@shres-code/shres-code-tracker'
import FileLedgerService from '@shres-code/shres-code-ledger'
import type { LedgerEntryId, LedgerRequest } from '@shres-code/shres-code-ledger'
import * as LedgerInvariantCompanion from '@shres-code/shres-code-ledger/invariant'
import InvariantRegistry, { InvariantError } from '@shres-code/shres-code-invariants'

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
}

function runId(id: string): TrackerRunId {
  return id as TrackerRunId
}

function validRequest(): LedgerRequest {
  return {
    hypothesis: 'h',
    decision: 'accepted',
    evidence: { runIds: [runId('run-1')] },
    rationale: 'r',
  }
}

async function setup(): Promise<{ ctx: Context; session: Session; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-invariant-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(StubTracker)
  await ctx.plugin(FileLedgerService, { storagePath: join(dir, 'ledger.jsonl') })
  await ctx.plugin(LedgerInvariantCompanion)
  const session = ctx.sessions.create()
  return { ctx, session, dir }
}

describe('ledger store invariant', () => {
  it('accepts a recorded decision whose entry is present in the store', async () => {
    const { ctx, session, dir } = await setup()
    ;(ctx.tracker as StubTracker).knownRuns = [runId('run-1')]
    await expect(ctx.ledger.record(session, validRequest(), CallId('call-1'))).resolves.toMatchObject({ kind: 'recorded' })
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects a ledger/decision event whose entry is not in the store', async () => {
    const { session, dir } = await setup()
    expect(() => {
      session.append('ledger/decision', {
        entryId: 'entry-unknown' as LedgerEntryId,
        hypothesis: 'h',
        decision: 'accepted',
        runIds: [],
        callId: CallId('call-2'),
      }, { ignorable: true })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@shres-code/shres-code-ledger',
    }))
    await rm(dir, { recursive: true, force: true })
  })

  it('ignores non-ledger/decision events', async () => {
    const { session, dir } = await setup()
    expect(() => {
      session.append('todo/write', { todos: [] }, { ignorable: true })
    }).not.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})
