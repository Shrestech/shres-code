/**
 * Live public resolveModelInfo counts vs preserved P, and the prepareCall-failure
 * cache.base split between live (P fallback) and replay (pre-change C adapter).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection } from '@shres-code/shres-code-agent'
import JudgmentService from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentChoiceAnswer, JudgmentInput, JudgmentResult, JudgmentScoreAnswer } from '@shres-code/shres-code-judgment'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createAssistantMessage, createUserMessage } from '@shres-code/shres-code-llm'
import type { GenerateOptions, LlmCallConfig, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import ModelRoutingController, {
  DIFFICULTY_QUESTION_ID,
  ROUTE_QUESTION_ID,
  replayConsultInput,
  resolveConfig,
} from '../src/index.ts'
import { consultInputFrom } from '../src/replay.ts'
import type { ModelRouterConfig } from '../src/config.ts'
import { passthroughRuntime } from './passthrough-runtime.ts'

/** Measured at P 7ad0ea21de with /tmp/routing-review/resolver-cleanup-live-capture.mts. */
const P_DOLLARS = { publicResolves: 2, prepareCalls: 2 } as const
const P_QUOTA_COLD = { publicResolves: 3, prepareCalls: 2 } as const
const P_QUOTA_WARM = { publicResolves: 1, prepareCalls: 0 } as const
const P_HELD_STEP1 = { publicResolves: 3, prepareCalls: 2 } as const
const P_HELD_STEP2 = { publicResolves: 2, prepareCalls: 2 } as const
/** Live P prepareCall-failure after metadata TTL success. */
const P_LIVE_EDGE_SOURCE = 'fallback' as const
/** Pre-change C 3298dbec40 replayConsultInput on the same edge. */
const PRECHANGE_C_REPLAY_EDGE_SOURCE = 'adapter' as const

const STRONG: ModelSelection = { provider: 'strong-provider', model: 'strong-model' }
const CHEAP = { provider: 'cheap-provider', model: 'cheap-model' }
const CONFIG: ModelRouterConfig = {
  initialMode: 'on',
  candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a small change in familiar code' }],
  routeFrom: [{ provider: STRONG.provider, model: STRONG.model, objective: 'dollars' }],
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  routeInstructions: 'Pick the cheapest route that can finish this turn.',
  difficultyInstructions: 'Rate how much reasoning this turn needs.',
}
const QUOTA: ModelRouterConfig = {
  ...CONFIG,
  routeFrom: [{ provider: STRONG.provider, model: STRONG.model, objective: 'quota' }],
  hold: { minSteps: 2, maxSteps: 40 },
}
const PASSING: JudgmentChoiceAnswer = {
  kind: 'choice', id: ROUTE_QUESTION_ID, option: 'cheap',
  probabilities: { cheap: 0.9, strong: 0.02 }, confidence: 0.9,
}
const EASY: JudgmentScoreAnswer = {
  kind: 'score', id: DIFFICULTY_QUESTION_ID, score: 1, probabilities: { '0': 1 }, confidence: 0.9,
}
const T0 = 1_750_000_000_000

class ScriptedJudgment extends JudgmentService {
  readonly asks: JudgmentInput[] = []
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    const answers: JudgmentAnswer[] = [PASSING, EASY]
    return Promise.resolve({ answers, engine: 'scripted-judgment', model: 'scripted-1', latencyMs: 3 })
  }
}

class CountingAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider, id: model, name: model,
      context: { contextWindow: 128_000 },
      promptCacheTtlMs: 300_000,
      inputModalities: ['text'] satisfies readonly ModelModality[],
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'low' },
          { id: ReasoningEffortId('medium'), name: 'medium' },
          { id: ReasoningEffortId('high'), name: 'high' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    }
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { return }
}

function agentFor(session: Session, ctx: Context): Agent {
  return { id: session.id, session, ctx } as unknown as Agent
}

const proto = LlmRuntime.prototype as unknown as {
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>
  prepareCall: (config: LlmCallConfig, signal?: AbortSignal) => Promise<unknown>
}
const origInfo = proto.resolveModelInfo
const origPrep = proto.prepareCall
let publicResolves = 0
let prepareCalls = 0
let failPrepare = false

beforeEach(() => {
  publicResolves = 0
  prepareCalls = 0
  failPrepare = false
  proto.resolveModelInfo = async function wrappedInfo(this: unknown, provider: string, model: string, signal?: AbortSignal) {
    publicResolves++
    return origInfo.call(this, provider, model, signal)
  }
  proto.prepareCall = async function wrappedPrep(this: unknown, config: LlmCallConfig, signal?: AbortSignal) {
    prepareCalls++
    if (failPrepare && config.provider === STRONG.provider) throw new Error('prepareCall failed after metadata')
    return origPrep.call(this, config, signal)
  }
})

afterEach(() => {
  proto.resolveModelInfo = origInfo
  proto.prepareCall = origPrep
})

async function mount(config: ModelRouterConfig) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['strong-provider', 'cheap-provider', 'other-provider'], new CountingAdapter())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ScriptedJudgment)
  await ctx.plugin(ModelRoutingController, config)
  const session = ctx.sessions.create()
  const agent = agentFor(session, ctx)
  ctx.agents.register(agent)
  return { ctx, session, agent, signal: new AbortController().signal }
}

function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

async function resolveTurn(
  ctx: Context, agent: Agent, session: Session, signal: AbortSignal, turn: number, step = 1,
) {
  return ctx.modelRouting.resolveRequest(agent, turn, step, STRONG, signal, {
    config: STRONG,
    content: { messages: session.deriveMessages(), system: '', tools: [] },
  })
}

describe('live resolveModelInfo counts equal preserved P', () => {
  it('judged dollars is 2 public resolves and 2 prepareCall', async () => {
    const { ctx, session, agent, signal } = await mount(CONFIG)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    user(session, 'a small change')
    expect(await resolveTurn(ctx, agent, session, signal, 1)).toEqual(CHEAP)
    expect(publicResolves).toBe(P_DOLLARS.publicResolves)
    expect(prepareCalls).toBe(P_DOLLARS.prepareCalls)
    await ctx.fiber.dispose()
  })

  it('judged quota cold is 3 public resolves and 2 prepareCall', async () => {
    const { ctx, session, agent, signal } = await mount(QUOTA)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    user(session, 'cold')
    expect(await resolveTurn(ctx, agent, session, signal, 1)).toEqual(CHEAP)
    expect(publicResolves).toBe(P_QUOTA_COLD.publicResolves)
    expect(prepareCalls).toBe(P_QUOTA_COLD.prepareCalls)
    await ctx.fiber.dispose()
  })

  it('quota warm-prefix is 1 public resolve and 0 prepareCall', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    try {
      const { ctx, session, agent, signal } = await mount(QUOTA)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      user(session, 'turn 1')
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text' as const, text: 'done' }],
          source: { provider: STRONG.provider, model: STRONG.model },
        }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      publicResolves = 0
      prepareCalls = 0
      session.append('turn/start', { turn: 2 })
      vi.setSystemTime(T0 + 60_000)
      session.append('step/start', { turn: 2, step: 1 })
      user(session, 'warm')
      expect(await resolveTurn(ctx, agent, session, signal, 2)).toBeUndefined()
      const decision = session.events.findLast(event => event.type === 'model-routing/decision')?.data
      expect(decision?.reason).toBe('warm-prefix')
      expect(publicResolves).toBe(P_QUOTA_WARM.publicResolves)
      expect(prepareCalls).toBe(P_QUOTA_WARM.prepareCalls)
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('held quota step 1 / step > 1 match preserved P', async () => {
    const { ctx, session, agent, signal } = await mount(QUOTA)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    user(session, 'a')
    publicResolves = 0
    prepareCalls = 0
    expect(await resolveTurn(ctx, agent, session, signal, 1)).toEqual(CHEAP)
    expect({ publicResolves, prepareCalls }).toEqual(P_HELD_STEP1)
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text' as const, text: 'done' }],
        source: { provider: CHEAP.provider, model: CHEAP.model },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    user(session, 'b')
    publicResolves = 0
    prepareCalls = 0
    expect(await resolveTurn(ctx, agent, session, signal, 2)).toEqual(CHEAP)
    expect({ publicResolves, prepareCalls }).toEqual(P_HELD_STEP1)
    session.append('step/start', { turn: 2, step: 2 })
    publicResolves = 0
    prepareCalls = 0
    expect(await resolveTurn(ctx, agent, session, signal, 2, 2)).toEqual(CHEAP)
    expect({ publicResolves, prepareCalls }).toEqual(P_HELD_STEP2)
    await ctx.fiber.dispose()
  })
})

describe('prepareCall-failure edge', () => {
  it('live non-quota cache.base is P fallback; replay is pre-change C adapter', async () => {
    failPrepare = true
    const { ctx, session, agent, signal } = await mount(CONFIG)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    user(session, 'edge')
    expect(await resolveTurn(ctx, agent, session, signal, 1)).toBeUndefined()
    const live = session.events.findLast(event => event.type === 'model-routing/decision')?.data
    expect(live?.reason).toBe('candidate-ineligible')
    expect(live?.cache?.base.source).toBe(P_LIVE_EDGE_SOURCE)
    const resolveModelInfo = async (provider: string, model: string): Promise<LlmResolvedModelInfo> => ({
      provider, id: model, name: model, context: { contextWindow: 128_000 }, promptCacheTtlMs: 300_000,
    })
    const replayed = await replayConsultInput(
      resolveConfig(CONFIG), session.events,
      { turn: 1, step: 1, now: 1, seedLength: undefined },
      STRONG, STRONG, STRONG,
      { resolveModelInfo, prepareCall: async () => { throw new Error('prepareCall failed after metadata') } },
    )
    expect(replayed.kind).toBe('ineligible')
    if (replayed.kind !== 'ineligible') throw new Error('expected ineligible')
    expect(replayed.cache.base.source).toBe(PRECHANGE_C_REPLAY_EDGE_SOURCE)
    await ctx.fiber.dispose()
  })
})

describe('consult cachePolicy branches', () => {
  it('live-given makes no TTL resolve; live-eligibility makes no TTL resolve and coldPoint is null; replay-resolve resolves once', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    user(session, 'policy')
    let resolves = 0
    const resolveModelInfo = async (provider: string, model: string): Promise<LlmResolvedModelInfo> => {
      resolves++
      return { provider, id: model, name: model, context: { contextWindow: 128_000 }, promptCacheTtlMs: 300_000 }
    }
    const common = {
      config: resolveConfig(CONFIG),
      prefix: session.events,
      messages: session.deriveMessages(),
      requestConfig: STRONG,
      routeBase: STRONG,
      coldPointBase: STRONG,
      at: { turn: 1, step: 1, now: 1, seedLength: undefined },
      runtime: passthroughRuntime(resolveModelInfo),
    }
    resolves = 0
    const given = await consultInputFrom({
      ...common,
      cachePolicy: { kind: 'live-given', ttl: { ttlMs: 111, ttlSource: 'adapter' } },
    })
    expect(resolves).toBe(2)
    expect(given.kind).not.toBe('warm')
    if (given.kind !== 'warm') {
      expect(given.cache.base.ttlMs).toBe(111)
      expect(given.coldPoint).toBeNull()
    }
    resolves = 0
    const eligibility = await consultInputFrom({ ...common, cachePolicy: { kind: 'live-eligibility' } })
    expect(resolves).toBe(2)
    expect(eligibility.kind).not.toBe('warm')
    if (eligibility.kind !== 'warm') expect(eligibility.coldPoint).toBeNull()
    resolves = 0
    const replayed = await consultInputFrom({ ...common, cachePolicy: { kind: 'replay-resolve' } })
    expect(resolves).toBe(3)
    expect(replayed.kind).not.toBe('warm')
    await ctx.fiber.dispose()
  })
})
