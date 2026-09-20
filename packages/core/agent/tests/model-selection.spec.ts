import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import {
  agentEvents,
  installModelSelection,
  selectionInForce,
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
  readonly calls: Array<{
    turn: number
    step: number
    base: { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
  }> = []

  /** Route the sticky selection reports; `undefined` stands for a strong state. */
  sticky: ModelSelection | undefined

  constructor(ctx: Context, private readonly answer: (base: ModelSelection) => ModelSelection | undefined) {
    super(ctx, 'modelRouting')
  }

  /**
   * @returns the scripted sticky selection.
   */
  stickySelection(): ModelSelection | undefined {
    return this.sticky
  }

  resolveRequest(
    _agent: Agent,
    turn: number,
    step: number,
    base: ModelSelection,
    _signal: AbortSignal,
  ): Promise<ModelSelection | undefined> {
    this.calls.push({
      turn,
      step,
      base: {
        provider: base.provider,
        model: base.model,
        ...base.reasoningEffort === undefined ? {} : { reasoningEffort: base.reasoningEffort },
      },
    })
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

  it('carries an effort that reached the request without an assembly through to the consult', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    installModelSelection(ctx, selection)
    const agent = {} as Agent
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, base => ({ provider: 'cheap', model: base.model }))

    await ctx.systemPrompt.assemble()
    // The manual route the router is handed is the resolved config itself, its
    // effort included: an effort the request carried is what the gate compares
    // and what a held streak records as its entry base.
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal },
      () => Promise.resolve({
        provider: 'persisted',
        model: 'p1',
        reasoningEffort: ReasoningEffortId('max'),
        temperature: 0.1,
      }),
    )).resolves.toEqual({ provider: 'cheap', model: 'p1', temperature: 0.1 })
    const routed = ctx.get('modelRouting') as unknown as StubRouting
    expect(routed.calls).toEqual([{
      turn: 1,
      step: 0,
      base: { provider: 'persisted', model: 'p1', reasoningEffort: ReasoningEffortId('max') },
    }])
    await ctx.fiber.dispose()
  })
})

describe('selectionInForce()', () => {
  /**
   * The Agent surface this suite scripts: a context to reach the routing
   * consult through, and the session header the getter falls back to.
   * @param ctx - the context the agent reads services from.
   * @param header - the session's latest request header, when one is logged.
   * @returns the minimal Agent.
   */
  function agentFor(ctx: Context, header?: { config: ModelSelection }): Agent {
    return {
      id: 'selection-in-force',
      ctx,
      session: { requestHeader: () => header },
    } as unknown as Agent
  }

  it('reports the logged selection, with its effort, when no router is composed', async () => {
    const ctx = new Context()

    // Nothing logged yet: the caller's own default is the only thing left.
    expect(selectionInForce(agentFor(ctx))).toBeUndefined()
    expect(selectionInForce(agentFor(ctx, { config: { provider: 'alpha', model: 'a1' } })))
      .toEqual({ provider: 'alpha', model: 'a1' })
    expect(selectionInForce(agentFor(ctx, {
      config: { provider: 'alpha', model: 'a1', reasoningEffort: ReasoningEffortId('high') },
    }))).toEqual({ provider: 'alpha', model: 'a1', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('reports the held streak’s entry route over the routed header', async () => {
    const ctx = new Context()
    await ctx.plugin(StubRouting, () => undefined)
    const routing = ctx.get('modelRouting') as unknown as StubRouting
    // The header a routed turn consumed: routing rewrote it to the candidate.
    const agent = agentFor(ctx, { config: { provider: 'cheap-provider', model: 'cheap-model' } })

    // Strong: nothing overrides the header, which is the manual route itself.
    expect(selectionInForce(agent)).toEqual({ provider: 'cheap-provider', model: 'cheap-model' })

    // Held: the session stays pointed at the route the streak was entered on.
    routing.sticky = {
      provider: 'strong-provider',
      model: 'strong-model',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect(selectionInForce(agent)).toEqual(routing.sticky)
    await ctx.fiber.dispose()
  })
})
