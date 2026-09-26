import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry, { provideModelSelection } from '@shres-code/shres-code-agent'
import type { ModelSelection } from '@shres-code/shres-code-agent'
import LlmRuntime, { type LlmResolvedModelInfo } from '@shres-code/shres-code-llm'
import { createAssistantMessage, createUserMessage } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import ModelRoutingController, {
  consultPrefix,
  replayConsultInput,
  ReplayConsultError,
  resolveConfig,
} from '../src/index.ts'
import { LlmAdapter } from '@shres-code/shres-code-llm'
import type { ModelRouterConfig } from '../src/config.ts'
import JudgmentService from '@shres-code/shres-code-judgment'
import type { JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'

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
}

class CaptureJudgment extends JudgmentService {
  readonly asks: JudgmentInput[] = []
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    return Promise.resolve({
      answers: [
        { kind: 'choice', id: input.questions[0]!.id, option: 'cheap', confidence: 0.9, probabilities: { cheap: 0.9 } },
        ...input.questions[1] === undefined ? [] : [{ kind: 'score' as const, id: input.questions[1].id, score: 1, confidence: 0.9, probabilities: { '0': 1 } }],
      ],
      engine: 'capture',
      model: 'capture-1',
      latencyMs: 1,
    })
  }
}

class InfoAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<never> { return }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
      promptCacheTtlMs: 300_000,
      inputModalities: ['text', 'image'],
    }
  }
}

function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function open(session: Session, turn: number, step = 1): void {
  if (step === 1) session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
}

async function tree(): Promise<{
  ctx: Context
  session: Session
  agent: ReturnType<typeof Object>
  llm: LlmRuntime
  engine: CaptureJudgment
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['strong-provider', 'cheap-provider'], new InfoAdapter())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CaptureJudgment)
  await ctx.plugin(ModelRoutingController, CONFIG)
  const session = ctx.sessions.create()
  const agent = { id: session.id, session, ctx } as never
  provideModelSelection(agent, { current: undefined, assembled: undefined })
  ctx.agents.register(agent)
  return { ctx, session, agent, llm: ctx.llm, engine: ctx.judgment as CaptureJudgment }
}

describe('replayConsultInput', () => {
  it('matches live engine.ask on a non-quota entry and consultPrefix length equals session.seq', async () => {
    const { ctx, session, agent, llm, engine } = await tree()
    open(session, 1)
    user(session, 'a small change')
    const seqAtConsult = session.events.at(-1)!.seq
    await ctx.modelRouting.resolveRequest(agent as never, 1, 1, STRONG, new AbortController().signal, {
      config: STRONG,
      content: { messages: session.deriveMessages(), system: '', tools: [] },
    })
    const ask = engine.asks[0]
    expect(ask).toBeDefined()
    const replayed = await replayConsultInput(
      resolveConfig(CONFIG),
      session.events,
      { turn: 1, step: 1, now: session.events.find(event => event.type === 'step/start')!.time, seedLength: session.header.seedLength },
      STRONG,
      STRONG,
      STRONG,
      (provider, model, signal) => llm.resolveModelInfo(provider, model, signal),
    )
    expect(replayed.kind).toBe('ask')
    if (replayed.kind !== 'ask') return
    expect(replayed.consultKey).toBe(ask?.correlation?.consultKey)
    expect(replayed.questions).toEqual(ask?.questions)
    expect(replayed.states[0]).toBe(ask?.state)
    expect(consultPrefix(session.events, 1, 1).at(-1)?.seq).toBe(seqAtConsult)
  })

  it('quota warm returns kind warm with zero extra candidate lookup after TTL', async () => {
    const { ctx } = await tree()
    await ctx.fiber.dispose()
    const inner = new Context()
    await inner.plugin(LlmRuntime)
    inner.llm.registerAdapter(['strong-provider', 'cheap-provider'], new InfoAdapter())
    await inner.plugin(SessionStore)
    await inner.plugin(AgentRegistry)
    await inner.plugin(CaptureJudgment)
    await inner.plugin(ModelRoutingController, QUOTA)
    const s = inner.sessions.create()
    const a = { id: s.id, session: s, ctx: inner } as never
    inner.agents.register(a)
    const t0 = 1_750_000_000_000
    open(s, 1, 1)
    user(s, 'first')
    s.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'done' }],
        source: { provider: STRONG.provider, model: STRONG.model },
      }),
    }, { surfaceOp: 'append' })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    open(s, 2, 1)
    user(s, 'still warm')
    let lookups = 0
    const replayed = await replayConsultInput(
      resolveConfig(QUOTA),
      s.events,
      { turn: 2, step: 1, now: t0 + 60_000, seedLength: s.header.seedLength },
      STRONG,
      STRONG,
      STRONG,
      async (provider, model, signal) => {
        lookups += 1
        return inner.llm.resolveModelInfo(provider, model, signal)
      },
    )
    expect(replayed.kind).toBe('warm')
    expect(lookups).toBe(1)
    expect((inner.judgment as CaptureJudgment).asks).toHaveLength(0)
  })

  it('split bases: cheap log is session-start only on turn 1; strong coldPointBase manufactures session-start', async () => {
    const t0 = 1_750_000_000_000
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    open(session, 1, 1)
    user(session, 'cheap start')
    session.append('request/header', {
      header: { config: { provider: CHEAP.provider, model: CHEAP.model } },
      reason: 'initial',
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'ok' }],
        source: { provider: CHEAP.provider, model: CHEAP.model },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    open(session, 2, 1)
    user(session, 'cheap two')
    const resolve = async (): Promise<LlmResolvedModelInfo> => ({
      provider: STRONG.provider, id: STRONG.model, name: STRONG.model, promptCacheTtlMs: 300_000, context: { contextWindow: 128_000 },
    })
    const correct = await replayConsultInput(
      resolveConfig(QUOTA), session.events,
      { turn: 2, step: 1, now: t0 + 60_000, seedLength: undefined },
      STRONG, CHEAP, STRONG, resolve,
    )
    expect(correct.kind).toBe('warm')
    const manufactured = await replayConsultInput(
      resolveConfig(QUOTA), session.events,
      { turn: 2, step: 1, now: t0 + 60_000, seedLength: undefined },
      STRONG, STRONG, STRONG, resolve,
    )
    expect(manufactured.kind === 'ask' || manufactured.kind === 'ineligible' ? manufactured.coldPoint?.kind : undefined).toBe('session-start')
  })

  it('refuses mixed-route logs when bases differ, and refuses an active held streak', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const mixed = ctx.sessions.create()
    open(mixed, 1)
    user(mixed, 'one')
    mixed.append('request/header', {
      header: { config: { provider: CHEAP.provider, model: CHEAP.model } },
      reason: 'initial',
    })
    mixed.append('request/header', {
      header: { config: { provider: STRONG.provider, model: STRONG.model } },
      reason: 'initial',
    })
    await expect(replayConsultInput(
      resolveConfig(CONFIG), mixed.events,
      { turn: 1, step: 1, now: 1, seedLength: undefined },
      STRONG, CHEAP, STRONG,
      async () => ({ provider: 'x', id: 'y', name: 'y', context: { contextWindow: 1 } }),
    )).rejects.toMatchObject({ code: 'mixed-route' })

    const held = ctx.sessions.create()
    open(held, 1)
    user(held, 'held')
    held.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: 'abcd1234',
      stateSeqs: [0],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, stepsElapsed: 0, routeErrorLimit: 2, entryBase: STRONG },
    })
    open(held, 2)
    user(held, 'next')
    await expect(replayConsultInput(
      resolveConfig(CONFIG), held.events,
      { turn: 2, step: 1, now: 1, seedLength: undefined },
      STRONG, STRONG, STRONG,
      async () => ({ provider: 'x', id: 'y', name: 'y', context: { contextWindow: 1 } }),
    )).rejects.toMatchObject({ code: 'held-streak' })
    expect(ReplayConsultError).toBeDefined()
  })
})
