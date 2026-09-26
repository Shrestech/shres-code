import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import { LlmError } from '@shres-code/shres-code-llm'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { childTurnOutcomes, foldChildTurns } from '../src/child-outcomes.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const STRONG = { provider: 'mock', model: 'strong' }

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('child answer')]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'shres-subagent-child-outcomes-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter([STRONG.provider], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { ...STRONG })
  return { ctx, parent, root }
}

describe('SubagentRuntime.childTurnOutcomes', () => {
  it("returns a completed live child's accounting turn and header route", async () => {
    const { ctx, parent } = await setup()
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'hello' }],
      parent,
      signal: new AbortController().signal,
    })
    await run.result
    const result = await ctx.subagents.childTurnOutcomes(parent, run.id)
    expect(result).toMatchObject({
      turns: [{ turn: 1, reason: { kind: 'completed' }, route: STRONG }],
    })
    expect('unavailable' in result).toBe(false)
    await run.dispose()
  })

  it('reports not-a-child for a session that is not a direct subagent child', async () => {
    const { ctx, parent } = await setup()
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { ...STRONG })
    expect(await ctx.subagents.childTurnOutcomes(parent, stranger.id)).toEqual({ unavailable: 'not-a-child' })
  })

  it('reports corrupt when a persistence header no longer matches the live witness', async () => {
    const { ctx, parent } = await setup()
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'hello' }],
      parent,
      signal: new AbortController().signal,
    })
    await run.result
    const live = ctx.sessions.get(run.id)
    if (live === undefined) throw new Error('expected live child')
    const persistence = ctx.get('sessionPersistence')!
    const originalInspect = persistence.inspect.bind(persistence)
    let gets = 0
    const originalGet = ctx.sessions.get.bind(ctx.sessions)
    ctx.sessions.get = ((id: SessionId) => {
      gets += 1
      if (id === run.id && gets === 1) return undefined
      return originalGet(id)
    }) as typeof ctx.sessions.get
    persistence.inspect = async (id, signal) => {
      const inspected = await originalInspect(id, signal)
      return { ...inspected, meta: { ...inspected.meta, createdAt: inspected.meta.createdAt + 1 } }
    }
    expect(await childTurnOutcomes(ctx, parent, run.id)).toEqual({ unavailable: 'corrupt' })
    await run.dispose()
  })

  it('reports missing when persistence has no such child and the child is not live', async () => {
    const { ctx, parent } = await setup()
    expect(await ctx.subagents.childTurnOutcomes(parent, SessionId('absent-child'))).toEqual({ unavailable: 'missing' })
  })

  it('reports no-persistence when the child is not live and no persistence is composed', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter([STRONG.provider], new MockAdapter([textResponse('child answer')]))
    const parent = ctx.agentLoop.create(SessionId('parent-live-only'), { ...STRONG })
    expect(await ctx.subagents.childTurnOutcomes(parent, SessionId('cold-child'))).toEqual({ unavailable: 'no-persistence' })
  })

  it('reports not-a-child for a persisted session whose parent is not the caller', async () => {
    const { ctx, parent } = await setup()
    const stranger = ctx.agentLoop.create(SessionId('stranger-parent'), { ...STRONG })
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'hello' }],
      parent: stranger,
      signal: new AbortController().signal,
    })
    await run.result
    await run.dispose()
    expect(ctx.sessions.get(run.id)).toBeUndefined()
    expect(await ctx.subagents.childTurnOutcomes(parent, run.id)).toEqual({ unavailable: 'not-a-child' })
  })


  it('rejects when the caller cancels', async () => {
    const { ctx, parent } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('stop listing'))
    await expect(ctx.subagents.childTurnOutcomes(parent, SessionId('any'), controller.signal))
      .rejects.toThrow('stop listing')
  })

  it('reads a max-tokens accounting turn from a live child', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('cut')])
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'hello' }],
      parent,
      signal: new AbortController().signal,
    })
    await run.result
    const result = await ctx.subagents.childTurnOutcomes(parent, run.id)
    expect(result).toMatchObject({
      turns: [{ turn: 1, reason: { kind: 'max-tokens' }, route: STRONG }],
    })
    await run.dispose()
  })

  it('an outputSchema miss still accounts a completed turn', async () => {
    const { ctx, parent } = await setup([textResponse('not structured')])
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'hello' }],
      parent,
      signal: new AbortController().signal,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const settled = await run.result.catch((error: unknown) => error)
    expect(settled).toBeTruthy()
    const result = await ctx.subagents.childTurnOutcomes(parent, run.id)
    expect(result).toMatchObject({
      turns: [{ turn: 1, reason: { kind: 'completed' }, route: STRONG }],
    })
    await run.dispose()
  })

  it('reads an LlmError accounting turn from a live child', async () => {
    const { ctx, parent } = await setup([() => {
      throw new LlmError('provider 500', 'UNKNOWN_MODEL')
    }])
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'hello' }],
      parent,
      signal: new AbortController().signal,
    })
    await run.result.catch(() => undefined)
    const result = await ctx.subagents.childTurnOutcomes(parent, run.id)
    expect(result).toMatchObject({
      turns: [{
        turn: 1,
        reason: { kind: 'error', error: { code: 'UNKNOWN_MODEL' } },
        route: STRONG,
      }],
    })
    await run.dispose()
  })

  it('lists two accounting turns for a continuable child with two epochs', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second'), textResponse('spare')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: {
        prompt: [{ type: 'text', text: 'first epoch' }],
        parent,
      },
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() }, { timeout: 5_000 })
    await ctx.subagents.followup(parent, started.childId, [{ type: 'text', text: 'second epoch' }], {
      source: { kind: 'user' },
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() }, { timeout: 5_000 })
    const result = await ctx.subagents.childTurnOutcomes(parent, started.childId)
    if ('unavailable' in result) throw new Error('expected turns')
    expect(result.turns.map(row => row.turn)).toEqual([1, 2])
  })
})

describe('accounting-turn fold over real child-shaped logs', () => {
  const header = (seq: number, route = STRONG): SessionEvent<'request/header'> => ({
    type: 'request/header',
    seq,
    time: seq,
    data: { header: { config: route }, reason: 'initial' },
  })
  const turn = (seq: number, n: number, reason: TurnEndReason): SessionEvent<'turn/end'> => ({
    type: 'turn/end',
    seq,
    time: seq,
    data: { turn: n, reason },
  })
  const start = (seq: number, n: number): SessionEvent<'turn/start'> => ({
    type: 'turn/start',
    seq,
    time: seq,
    data: { turn: n },
  })
  const step = (seq: number, n: number): SessionEvent<'step/start'> => ({
    type: 'step/start',
    seq,
    time: seq,
    data: { turn: n, step: 1 },
  })

  it('includes completed, error, blocked, aborted, interrupted, and max-tokens accounting turns', () => {
    const cheap = { provider: 'cheap', model: 'flash' }
    const events: SessionEvent[] = [
      start(0, 1), step(1, 1), header(2), turn(3, 1, { kind: 'completed' }),
      start(4, 2), step(5, 2), header(6, cheap), turn(7, 2, { kind: 'error', error: { code: 'UNKNOWN', message: 'tool threw' } }),
      start(8, 3),
      { type: 'agent/inbox/spliced', seq: 8.5, time: 8.5, data: { removedCount: 1, outcome: 'claimed', inserted: [] } } as SessionEvent,
      header(9), turn(10, 3, { kind: 'blocked' }),
      start(11, 4), step(12, 4), turn(13, 4, { kind: 'aborted', reason: { kind: 'user' } }),
      start(14, 5), step(15, 5), turn(16, 5, { kind: 'interrupted' }),
      start(17, 6), step(18, 6), turn(19, 6, { kind: 'max-tokens' }),
    ]
    // A completed turn that claimed no step and no inbox is not accounting work.
    const headerWithoutRoute = (seq: number): SessionEvent<'request/header'> => ({
      type: 'request/header',
      seq,
      time: seq,
      data: { header: { config: { provider: 1, model: 2 } as never }, reason: 'initial' },
    })
    const noWork: SessionEvent[] = [start(0, 1), turn(1, 1, { kind: 'completed' })]
    const noRoute = foldChildTurns([start(0, 1), step(1, 1), headerWithoutRoute(2), turn(3, 1, { kind: 'completed' })])
    if ('unavailable' in noRoute) throw new Error('expected turns')
    expect(noRoute.turns[0]?.route).toBeUndefined()
    const noHeader = foldChildTurns([start(0, 1), step(1, 1), turn(2, 1, { kind: 'completed' })])
    if ('unavailable' in noHeader) throw new Error('expected turns')
    expect(noHeader.turns[0]?.route).toBeUndefined()
    const empty = foldChildTurns(noWork)
    if ('unavailable' in empty) throw new Error('expected empty turns')
    expect(empty.turns).toEqual([])
    const result = foldChildTurns(events)
    if ('unavailable' in result) throw new Error('expected turns')
    const corrupt = foldChildTurns([
      { type: 'subagent/descriptor', seq: 0, time: 0, data: { version: 2, mode: 'one-shot', provider: 'spawn', extra: true } } as SessionEvent,
    ])
    expect(corrupt).toEqual({ unavailable: 'corrupt' })
    const routed = foldChildTurns([
      { type: 'subagent/descriptor', seq: 0, time: 0, data: { version: 2, mode: 'one-shot', provider: 'spawn', agentRouteRequestId: 'route-fold' } } as SessionEvent,
      start(1, 1), step(2, 1), header(3), turn(4, 1, { kind: 'completed' }),
    ])
    if ('unavailable' in routed) throw new Error('expected routed turns')
    expect(routed.routeRequestId).toBe('route-fold')
    const cancelled = new AbortController()
    cancelled.abort(new Error('fold cancelled'))
    expect(() => foldChildTurns(events, cancelled.signal)).toThrow('fold cancelled')
    expect(result.turns.map(row => [row.turn, row.reason.kind, row.route?.model])).toEqual([
      [1, 'completed', 'strong'],
      [2, 'error', 'flash'],
      [3, 'blocked', 'strong'],
      [4, 'aborted', 'strong'],
      [5, 'interrupted', 'strong'],
      [6, 'max-tokens', 'strong'],
    ])
  })
})
