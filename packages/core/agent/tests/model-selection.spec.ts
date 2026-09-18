import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import {
  agentEvents,
  installModelSelection,
  type Agent,
  type ModelSelection,
  type ModelSelectionRef,
} from '../src/index.ts'
import { ReasoningEffortId, type LlmCallConfig } from '@shres-code/shres-code-llm'

describe('installModelSelection()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)
    const agent = {} as Agent
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
    })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })
})
/** The consult a composed router satisfies; this suite drives it directly. */
class StubRouting extends Service {
  readonly calls: Array<{ turn: number; step: number; base: { provider: string; model: string } }> = []

  constructor(ctx: Context, private readonly answer: (base: ModelSelection) => ModelSelection | undefined) {
    super(ctx, 'modelRouting')
  }

  resolveRequest(
    _agent: Agent,
    turn: number,
    step: number,
    base: ModelSelection,
    _signal: AbortSignal,
  ): Promise<ModelSelection | undefined> {
    this.calls.push({ turn, step, base: { provider: base.provider, model: base.model } })
    return Promise.resolve(this.answer(base))
  }
}

describe('installModelSelection() with a composed router', () => {
  const seed = (): LlmCallConfig => ({ provider: 'seed', model: 'seed', temperature: 0.2 })

  it('resolves nothing when the router keeps the manual route', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: { provider: 'alpha', model: 'a1' }, assembled: undefined }
    installModelSelection(ctx, selection)
    const agent = {} as Agent
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, () => undefined)

    await ctx.systemPrompt.assemble()
    // The manual selection is the base the router consults, never the persisted config.
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 3, step: 1, signal }, () => Promise.resolve(seed()),
    )).resolves.toEqual({ provider: 'alpha', model: 'a1', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('replaces the route when the router resolves one, stripping inherited effort', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: { provider: 'alpha', model: 'a1' }, assembled: undefined }
    installModelSelection(ctx, selection)
    const agent = {} as Agent
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, () => ({
      provider: 'cheap',
      model: 'c1',
      reasoningEffort: ReasoningEffortId('low'),
    }))
    const routed = ctx.get('modelRouting') as unknown as StubRouting

    await ctx.systemPrompt.assemble()
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 4, step: 0, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({
      provider: 'cheap',
      model: 'c1',
      reasoningEffort: ReasoningEffortId('low'),
      temperature: 0.2,
    })
    // The router sees the manual route, the turn, and the step it is deciding for.
    expect(routed.calls).toEqual([{ turn: 4, step: 0, base: { provider: 'alpha', model: 'a1' } }])
    await ctx.fiber.dispose()
  })

  it('keeps the persisted route when no manual selection is assembled', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    installModelSelection(ctx, selection)
    const agent = {} as Agent
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, base => ({ provider: 'cheap', model: base.model }))

    await ctx.systemPrompt.assemble()
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal },
      () => Promise.resolve({ provider: 'persisted', model: 'p1', temperature: 0.1 }),
    )).resolves.toEqual({ provider: 'cheap', model: 'p1', temperature: 0.1 })
    await ctx.fiber.dispose()
  })
})
