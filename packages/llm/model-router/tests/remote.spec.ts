/**
 * The `modelRouting` Remote reads: the Gateway binding and its direct
 * methods, `gate` (the gate configuration in force now), `poolStatus` (see
 * pool-status.spec.ts), `decision` (one logged decision, verbatim, with the
 * turn and step it was logged in), and `stats` (one workspace's sessions
 * rolled up).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { SessionHeader } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import ModelRoutingController, {
  DEFAULT_DIFFICULTY_LEVELS,
  DEFAULT_ENTRY_SCORE_CEILING,
  DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD,
  DEFAULT_HOLD_MAX_STEPS,
  DEFAULT_HOLD_MIN_STEPS,
  DEFAULT_JUDGMENT_DEADLINE_MS,
} from '../src/index.ts'
import { DEFAULT_STATE_MAX_CHARS } from '../src/config.ts'
import type { ModelRouterConfig } from '../src/config.ts'
import { foldModelRoutingStats } from '../src/stats.ts'
import type { ModelRoutingDecision, ModelRoutingStatsSnapshot } from '../src/types.ts'

const STRONG = { provider: 'strong-provider', model: 'strong-model' }
const CHEAP = { provider: 'cheap-provider', model: 'cheap-model' }

const CONFIG: ModelRouterConfig = {
  initialMode: 'off',
  candidates: [{ id: 'cheap', ...CHEAP, description: 'a small change in familiar code' }],
  routeFrom: [{ ...STRONG, objective: 'dollars' }],
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  routeInstructions: 'Pick the cheapest route that can finish this turn.',
  difficultyInstructions: 'Rate how much reasoning this turn needs.',
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(config: ModelRouterConfig = CONFIG, options: { projections?: boolean } = {}): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.projections === true) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ModelRoutingController, config)
  const session = ctx.sessions.create()
  return { ctx, agent: { id: session.id, session, ctx } as unknown as Agent }
}

const DECISION: ModelRoutingDecision = {
  outcome: 'kept-strong',
  reason: 'low-confidence',
  stateHash: '0badf00d',
  stateSeqs: [0],
  route: { choice: 'cheap', confidence: 0.6, probabilities: { cheap: 0.6, 'keep-current': 0.4 } },
  sticky: { active: false, stepsElapsed: 0 },
  engine: 'typesafe',
  latencyMs: 120,
  objective: 'dollars',
}

describe('modelRouting Remote reads', () => {
  it('publishes the modelRouting namespace with the gate, poolStatus, and decision methods', async () => {
    const { ctx } = await setup()
    expect(ctx.modelRouting.typertRemote).toMatchObject({ serviceKey: 'modelRouting', namespace: 'modelRouting' })
    expect(remoteMethods(ctx.modelRouting)).toEqual([
      { method: 'gateView', exportName: 'gate', invocation: { kind: 'direct' } },
      { method: 'poolStatus', invocation: { kind: 'direct' } },
      { method: 'decisionDetail', exportName: 'decision', invocation: { kind: 'direct' } },
      { method: 'workspaceStats', exportName: 'stats', invocation: { kind: 'direct' } },
    ])
  })

  it('gate reports the configured thresholds, operating points, deadline, difficulty band, and hold', async () => {
    const { ctx } = await setup({
      ...CONFIG,
      judgmentDeadlineMs: 4_000,
      difficultyLevels: ['easy', 'medium', 'hard'],
      difficulty: { entryScoreCeiling: 1 },
      escalateBack: { scoreThreshold: 1.5 },
      hold: { minSteps: 2, maxSteps: 7 },
      state: { maxChars: 8_000 },
      operatingPoints: [{ engine: 'laya', downgradeThreshold: 0.6, downgradeMargin: 0.2, calibratedBy: 'prereg-1' }],
    })
    expect(ctx.modelRouting.gateView()).toEqual({
      downgradeThreshold: 0.8,
      downgradeMargin: 0.1,
      operatingPoints: [{ engine: 'laya', downgradeThreshold: 0.6, downgradeMargin: 0.2, calibratedBy: 'prereg-1', acceptVerbalized: false }],
      // No judgment registry is composed here.
      engines: [],
      judgmentDeadlineMs: 4_000,
      entryScoreCeiling: 1,
      escalateBackScoreThreshold: 1.5,
      difficultyLevels: ['easy', 'medium', 'hard'],
      hold: { minSteps: 2, maxSteps: 7 },
      stateMaxChars: 8_000,
    })
  })

  it('gate reports the documented defaults for fields the deployment omits', async () => {
    const { ctx } = await setup()
    expect(ctx.modelRouting.gateView()).toEqual({
      downgradeThreshold: 0.8,
      downgradeMargin: 0.1,
      operatingPoints: [],
      engines: [],
      judgmentDeadlineMs: DEFAULT_JUDGMENT_DEADLINE_MS,
      entryScoreCeiling: DEFAULT_ENTRY_SCORE_CEILING,
      escalateBackScoreThreshold: DEFAULT_ESCALATE_BACK_SCORE_THRESHOLD,
      difficultyLevels: [...DEFAULT_DIFFICULTY_LEVELS],
      hold: { minSteps: DEFAULT_HOLD_MIN_STEPS, maxSteps: DEFAULT_HOLD_MAX_STEPS },
      stateMaxChars: DEFAULT_STATE_MAX_CHARS,
    })
  })

  it('decision returns the logged decision with its turn, step, and the gate in force', async () => {
    const { ctx, agent } = await setup()
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('step/start', { turn: 2, step: 3 })
    const logged = agent.session.append('model-routing/decision', DECISION)
    expect(ctx.modelRouting.decisionDetail(agent, logged.seq)).toEqual({
      seq: logged.seq,
      time: logged.time,
      turn: 2,
      step: 3,
      decision: DECISION,
      gate: ctx.modelRouting.gateView(),
    })
  })

  it('decision rejects a seq that names no model-routing/decision', async () => {
    const { ctx, agent } = await setup()
    const step = agent.session.append('step/start', { turn: 1, step: 1 })
    expect(() => ctx.modelRouting.decisionDetail(agent, step.seq))
      .toThrow(`logs no model-routing/decision at seq ${String(step.seq)}`)
    expect(() => ctx.modelRouting.decisionDetail(agent, 999)).toThrow('at seq 999')
  })
})

describe('the workspace statistics read', () => {
  const header = (id: string): SessionHeader => ({ version: 0, id: SessionId(id), createdAt: 1, cwd: '/w' })

  /** One live session with two logged decisions; returns it with its folded value. */
  function routedSession(ctx: Context, id: string): ModelRoutingStatsSnapshot {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/w' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('model-routing/decision', DECISION)
    const { route: _answered, ...unanswered } = DECISION
    session.append('model-routing/decision', { ...unanswered, reason: 'current-preferred' })
    return foldModelRoutingStats(session.events)
  }

  it('fails loud without a workspace registry or for an unknown workspace', async () => {
    const { ctx } = await setup()
    await expect(ctx.modelRouting.workspaceStats({ workspaceId: 'w1', range: 'all' }))
      .rejects.toThrow('modelRouting.stats: this host composes no workspace registry')
    ctx.provide('workspaceRegistry', { get: () => undefined, archivedSessionIds: [] } as never)
    await expect(ctx.modelRouting.workspaceStats({ workspaceId: 'w9', range: 'all' }))
      .rejects.toThrow('modelRouting.stats: no workspace "w9"')
  })

  it('rolls up live values and cached ones, leaving out archived and unreadable sessions', async () => {
    const { ctx } = await setup(CONFIG, { projections: true })
    const live = routedSession(ctx, 'live')
    const members = ['live', 'cached', 'uncached', 'broken', 'archived'].map(SessionId)
    ctx.provide('workspaceRegistry', {
      get: (id: string) => (id === 'w1' ? { sessionIds: members } : undefined),
      archivedSessionIds: [SessionId('archived')],
    } as never)
    ctx.provide('sessionPersistence', {
      // A header outside the workspace is never viewed.
      list: () => Promise.resolve(['cached', 'uncached', 'broken', 'archived', 'elsewhere'].map(header)),
    } as never)
    const viewed: string[] = []
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (meta: SessionHeader) => {
        viewed.push(String(meta.id))
        if (meta.id === 'broken') throw new Error('unit view threw')
        return meta.id === 'cached' ? { asOfSeq: 9, values: { modelRoutingStats: live } } : undefined
      },
    } as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)

    const stats = await ctx.modelRouting.workspaceStats({ workspaceId: 'w1', range: 'all' })
    expect(viewed).toEqual(['cached', 'uncached', 'broken'])
    expect(stats.sessions).toEqual({ members: 4, summarized: 2, inRange: 2, included: 2, capped: false })
    expect(stats.rows.map(row => row.sessionId).sort()).toEqual(['cached', 'live'])
    expect(stats.counts.decisions).toBe(4)
    expect(stats.reasons).toEqual([
      { reason: 'current-preferred', group: 'judge-no', count: 2 },
      { reason: 'low-confidence', group: 'judge-no', count: 2 },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to view'), 'broken', 'Error: unit view threw')
  })

  it('reads attached sessions alone on a host without the projection cache or persistence', async () => {
    const { ctx } = await setup(CONFIG, { projections: true })
    routedSession(ctx, 'live')
    ctx.provide('workspaceRegistry', { get: () => ({ sessionIds: ['live', 'cold'].map(SessionId) }), archivedSessionIds: [] } as never)
    const read = () => ctx.modelRouting.workspaceStats({ workspaceId: 'w1', range: '24h' })
    expect((await read()).sessions).toMatchObject({ members: 2, summarized: 1, included: 1 })
    ctx.provide('sessionPersistence', { list: () => Promise.reject(new Error('never listed')) } as never)
    expect((await read()).sessions.summarized).toBe(1)
  })

  it('counts a session without a decision as summarized but not in range', async () => {
    const { ctx } = await setup(CONFIG, { projections: true })
    ctx.sessions.create(SessionId('idle'), { meta: { cwd: '/w' } })
    ctx.provide('workspaceRegistry', { get: () => ({ sessionIds: [SessionId('idle')] }), archivedSessionIds: [] } as never)
    expect((await ctx.modelRouting.workspaceStats({ workspaceId: 'w1', range: 'all' })).sessions)
      .toEqual({ members: 1, summarized: 1, inRange: 0, included: 0, capped: false })
  })

  it('summarizes no attached session when the host registers no projections', async () => {
    const { ctx } = await setup()
    ctx.sessions.create(SessionId('live'))
    ctx.provide('workspaceRegistry', { get: () => ({ sessionIds: [SessionId('live')] }), archivedSessionIds: [] } as never)
    expect((await ctx.modelRouting.workspaceStats({ workspaceId: 'w1', range: 'all' })).sessions)
      .toEqual({ members: 1, summarized: 0, inRange: 0, included: 0, capped: false })
  })
})
