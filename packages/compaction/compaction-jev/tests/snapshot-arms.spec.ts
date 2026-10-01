/**
 * Keyless two-arm transcript snapshot: one forced compaction through the real
 * Loader composition whose judgment row mounts the test-only fixture plugin, and
 * the plain \`compaction-basic\` twin over the same seeded history.
 *
 * The committed expected outputs are the normalized durable records of each arm,
 * so a review reads the verified transcript (both companion events, the bracket,
 * and the checkpoint replacement) beside the twin's unchanged one. The twin's
 * records are asserted to be the Jev arm's records minus the two companion
 * events, which is the same claim the degradation suite makes about a degraded
 * run.
 *
 * Record with \`SHRES_SNAPSHOT=refresh npx vitest run packages/compaction/compaction-jev/tests/snapshot-arms.spec.ts\`;
 * every other run replays and compares. The repository's \`test:snapshot\` lane
 * discovers only the snapshot modules under an example's tests directory, and a
 * new scenario there needs a recorded model transcript, so this suite keeps the
 * same contract inside the package.
 *
 * TEST DOUBLES: the judgment fixture at ./fixtures/compaction-jev-judgment.ts,
 * mounted by a composition row exactly as a provider is, and
 * {@link ContextAdapter} for the summarizer's one-shot call. Nothing here dials a
 * socket, so a replayed fixture pins the composition and not a server's timing.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId, isReplacementSurfaceEvent } from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import { ContextAdapter } from './harness.ts'
import {
  basicRows,
  CONTEXT_WINDOW,
  jevRows,
  loadTree,
  ROUTE,
  ROUTE_MODEL,
  scriptedRows,
  seedHistory,
  unloadTree,
} from './loader-harness.ts'
import type { LoadedTree } from './loader-harness.ts'

/** The two companion events, which only the Jev arm writes. */
const COMPANION = ['compaction/selection', 'compaction/verification']
/** Random compaction identity, tokenized so a replay is stable. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
/** Signal one forced compaction runs under. */
const SIGNAL = new AbortController().signal
const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots', 'compaction-jev')
const refreshing = process.env['SHRES_SNAPSHOT'] === 'refresh'

let tree: LoadedTree | undefined

afterEach(async () => {
  await unloadTree(tree)
  tree = undefined
})

/** One normalized durable record. */
interface Record_ {
  /** Durable event type. */
  type: string
  /** Durable payload, with every random identity tokenized. */
  data: unknown
}

/**
 * Normalize one session's durable log: the record order, each event's type and
 * payload, and a placeholder for every random compaction identity. Position,
 * timestamp, and event-cross-reference seqs are deliberately excluded, because
 * the two arms necessarily number their bracket events differently.
 */
function normalizeLog(session: Session): string {
  const records: Record_[] = session.events.map(event => ({ type: event.type, data: normalizeData(event.data) }))
  return `${JSON.stringify(records).replaceAll(UUID, '{{compactionId}}')}\n`
}

/** Drop a judgment call's wall-clock duration, which no replay can pin. */
function normalizeData(data: unknown): unknown {
  if (typeof data !== 'object' || data === null || !('latencyMs' in data)) return data
  const { latencyMs, ...rest } = data as Record<string, unknown>
  void latencyMs
  return rest
}

/** The records of one normalized log, parsed back. */
function recordsOf(log: string): Record_[] {
  return JSON.parse(log) as Record_[]
}

/** One normalized log without its companion events. */
function withoutCompanion(log: string): string {
  return `${JSON.stringify(recordsOf(log).filter(record => !COMPANION.includes(record.type)))}\n`
}

/** One arm: the scripted judgment row, the seeded history, one forced compaction. */
async function arm(rows: readonly string[], sessionId: string): Promise<{ log: string; session: Session }> {
  tree = await loadTree(scriptedRows(rows))
  // TEST DOUBLE: the summarizer's one-shot call streams one fixed draft.
  tree.ctx.llm.registerAdapter([ROUTE], new ContextAdapter(CONTEXT_WINDOW))
  const agent = tree.ctx.agentLoop.create(SessionId(sessionId), { provider: ROUTE, model: ROUTE_MODEL })
  seedHistory(agent.session)

  await tree.ctx.compaction.compactIfNeeded(agent, 'context-overflow', SIGNAL)

  return { log: normalizeLog(agent.session), session: agent.session }
}

/** Compare one arm's log with its committed expected output, writing it in refresh mode. */
async function expectFixture(name: string, log: string): Promise<string> {
  const file = join(snapshotsDir, `${name}.expected.jsonl`)
  if (refreshing) {
    await mkdir(snapshotsDir, { recursive: true })
    await writeFile(file, log)
    return log
  }
  const expected = await readFile(file, 'utf8')
  expect(log, `${name} transcript`).toBe(expected)
  return expected
}

describe('keyless compaction transcript arms', () => {
  it('records the verified compaction transcript', { timeout: 60_000 }, async () => {
    const verified = await arm(jevRows(), 'snapshot-verified')
    await expectFixture('verified', verified.log)

    const types = recordsOf(verified.log).map(record => record.type)
    expect(types.filter(type => type === 'compaction/selection')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/verification')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/start')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/summary')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/end')).toHaveLength(1)
    expect(types.indexOf('compaction/selection')).toBeLessThan(types.indexOf('compaction/summary'))
    expect(types.indexOf('compaction/verification')).toBeLessThan(types.indexOf('compaction/end'))

    const verification = recordsOf(verified.log)
      .find(record => record.type === 'compaction/verification')?.data
    expect(verification).toMatchObject({
      attempt: 1,
      provider: ROUTE,
      model: ROUTE_MODEL,
      verdict: 'accepted',
      degraded: false,
      engine: 'scripted-judgment',
    })
    const replacement = verified.session.events.find(event =>
      event.type === 'user/message' && isReplacementSurfaceEvent(event))
    expect(replacement !== undefined).toBe(true)
    expect(JSON.stringify(replacement?.data)).toContain('conversation draft')
  })

  it('replays the compaction-basic twin unchanged and byte-identical apart from the companions', { timeout: 60_000 }, async () => {
    const verified = await arm(jevRows(), 'snapshot-verified')
    const twin = await arm(basicRows(), 'snapshot-twin')
    const twinExpected = await expectFixture('basic-twin', twin.log)
    await expectFixture('verified', verified.log)

    const twinTypes = recordsOf(twinExpected).map(record => record.type)
    expect(twinTypes).not.toContain('compaction/selection')
    expect(twinTypes).not.toContain('compaction/verification')
    expect(twinTypes.filter(type => type === 'compaction/summary')).toHaveLength(1)
    // The arms differ in exactly the two companion events.
    expect(withoutCompanion(verified.log)).toBe(twin.log)
  })
})
