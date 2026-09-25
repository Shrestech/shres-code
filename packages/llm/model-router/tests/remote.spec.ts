/**
 * The `modelRouting` Remote reads: the Gateway binding and its two direct
 * methods, `gate` (the gate configuration in force now) and `decision` (one
 * logged decision, verbatim, with the turn and step it was logged in).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import SessionStore from '@shres-code/shres-code-session'
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
import type { ModelRoutingDecision } from '../src/types.ts'

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

async function setup(config: ModelRouterConfig = CONFIG): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
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
  it('publishes the modelRouting namespace with the gate and decision methods', async () => {
    const { ctx } = await setup()
    expect(ctx.modelRouting.typertRemote).toMatchObject({ serviceKey: 'modelRouting', namespace: 'modelRouting' })
    expect(remoteMethods(ctx.modelRouting)).toEqual([
      { method: 'gateView', exportName: 'gate', invocation: { kind: 'direct' } },
      { method: 'decisionDetail', exportName: 'decision', invocation: { kind: 'direct' } },
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
