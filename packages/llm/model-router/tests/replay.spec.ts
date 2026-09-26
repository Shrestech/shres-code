import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { ModelSelection } from '@shres-code/shres-code-agent'
import { createAssistantMessage, createUserMessage, type LlmResolvedModelInfo } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import {
  consultPrefix,
  replayConsultInput,
  ReplayConsultError,
  resolveConfig,
} from '../src/index.ts'
import { consultInputFrom } from '../src/replay.ts'
import type { ModelRouterConfig } from '../src/config.ts'

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

const resolve = async (): Promise<LlmResolvedModelInfo> => ({
  provider: STRONG.provider,
  id: STRONG.model,
  name: STRONG.model,
  context: { contextWindow: 128_000 },
  promptCacheTtlMs: 300_000,
})

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

describe('consultInputFrom (live producer)', () => {
  it('accepts a held-step prefix without refusal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    open(session, 1)
    user(session, 'held')
    const result = await consultInputFrom({
      config: resolveConfig(CONFIG),
      prefix: session.events,
      messages: session.deriveMessages(),
      requestConfig: STRONG,
      routeBase: STRONG,
      coldPointBase: STRONG,
      at: { turn: 1, step: 1, now: 1, seedLength: undefined },
      resolveModelInfo: resolve,
    })
    expect(['ask', 'ineligible', 'warm']).toContain(result.kind)
  })
})

describe('replayConsultInput wrapper', () => {
  it('refuses a missing step/start by name', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    user(session, 'no step')
    await expect(replayConsultInput(
      resolveConfig(CONFIG), session.events,
      { turn: 1, step: 1, now: 1, seedLength: undefined },
      STRONG, STRONG, STRONG, resolve,
    )).rejects.toMatchObject({ code: 'missing-step' })
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
      STRONG, CHEAP, STRONG, resolve,
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
      STRONG, STRONG, STRONG, resolve,
    )).rejects.toMatchObject({ code: 'held-streak' })
    expect(ReplayConsultError).toBeDefined()
  })

  it('accepts kept-strong prior history on the entry path', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    open(session, 1)
    user(session, 'first')
    session.append('model-routing/decision', {
      outcome: 'kept-strong',
      reason: 'gate-failed',
      stateHash: 'abcd1234',
      stateSeqs: [0],
      sticky: { active: false, stepsElapsed: 0 },
    })
    open(session, 2)
    user(session, 'second')
    const replayed = await replayConsultInput(
      resolveConfig(CONFIG), session.events,
      { turn: 2, step: 1, now: 1, seedLength: undefined },
      STRONG, STRONG, STRONG, resolve,
    )
    expect(replayed.kind).toBe('ask')
    if (replayed.kind !== 'ask') return
    expect(replayed.consultKey).toBe('turn:2/step:1')
    expect(consultPrefix(session.events, 2, 1).some(event => event.type === 'step/start')).toBe(true)
  })

  it('quota warm returns kind warm with one TTL lookup', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const s = ctx.sessions.create()
    open(s, 1)
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
    open(s, 2)
    user(s, 'still warm')
    let lookups = 0
    const replayed = await replayConsultInput(
      resolveConfig(QUOTA),
      s.events,
      { turn: 2, step: 1, now: Date.now(), seedLength: s.header.seedLength },
      STRONG,
      STRONG,
      STRONG,
      async () => {
        lookups += 1
        return resolve()
      },
    )
    expect(replayed.kind).toBe('warm')
    expect(lookups).toBe(1)
  })

  it('split bases: cheap log is warm on turn 2; strong coldPointBase manufactures session-start', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    open(session, 1)
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
    open(session, 2)
    user(session, 'cheap two')
    const correct = await replayConsultInput(
      resolveConfig(QUOTA), session.events,
      { turn: 2, step: 1, now: Date.now(), seedLength: undefined },
      STRONG, CHEAP, STRONG, resolve,
    )
    expect(correct.kind).toBe('warm')
    const manufactured = await replayConsultInput(
      resolveConfig(QUOTA), session.events,
      { turn: 2, step: 1, now: Date.now(), seedLength: undefined },
      STRONG, STRONG, STRONG, resolve,
    )
    expect(manufactured.kind === 'ask' || manufactured.kind === 'ineligible' ? manufactured.coldPoint?.kind : undefined)
      .toBe('session-start')
  })
})
