import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import {
  agentEvents,
  installModelSelection,
  manualBaseOfLastHeader,
  modelSelectionInstalled,
  provideModelSelection,
  selectionInForce,
  type Agent,
  type AgentRequestContent,
  type ModelRoutingRequest,
  type ModelSelection,
  type ModelSelectionRef,
} from '../src/index.ts'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig } from '@shres-code/shres-code-llm'
import SessionStore, { Session, SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'

function requestContent(): AgentRequestContent {
  return { messages: [], system: '', tools: [] }
}

let agentCount = 0
/** The smallest agent the hook reads: an id, a scoped context, and the session it records into. */
function hookAgent(ctx: Context): Agent {
  agentCount += 1
  const id = `agent-${String(agentCount)}`
  return { id, ctx, session: Session.create(SessionId(id)) } as unknown as Agent
}

/** The `agent/route-base` payloads in one session log, in order. */
function routeBases(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap(event => event.type === 'agent/route-base' ? [event.data] : [])
}

let eventSeq = 0
/** A detached `request/header` event on one route, as the loop logs it. */
function headerEvent(config: LlmCallConfig, adapterDefaultEffort = false): SessionEvent {
  return {
    type: 'request/header',
    seq: eventSeq++,
    time: 0,
    data: { header: { config, ...adapterDefaultEffort ? { adapterDefaults: { reasoningEffort: true } } : {} }, reason: 'change' },
  } as unknown as SessionEvent
}

/** A detached `agent/route-base` event. */
function routeBaseEvent(manual: ModelSelection, routed: ModelSelection): SessionEvent {
  return { type: 'agent/route-base', seq: eventSeq++, time: 0, data: { manual, routed } } as unknown as SessionEvent
}

describe('one model-selection hook per agent', () => {
  it('installs once, rejects a second hook, and reinstalls after disposal', async () => {
    const ctx = new Context()
    const agent = hookAgent(ctx)
    expect(modelSelectionInstalled(agent)).toBe(false)
    const dispose = installModelSelection(agent)
    expect(modelSelectionInstalled(agent)).toBe(true)
    expect(() => installModelSelection(agent)).toThrow(`agent "${agent.id}" already has a model selection hook`)
    dispose()
    dispose()
    expect(modelSelectionInstalled(agent)).toBe(false)
    const again = installModelSelection(agent)
    expect(modelSelectionInstalled(agent)).toBe(true)
    again()
    await ctx.fiber.dispose()
  })

  it('accepts one selection provider, installing the hook when absent, and rejects a second', async () => {
    const ctx = new Context()
    const agent = hookAgent(ctx)
    const first: ModelSelectionRef = { current: undefined, assembled: undefined }
    provideModelSelection(agent, first)
    expect(modelSelectionInstalled(agent)).toBe(true)
    provideModelSelection(agent, first)
    expect(() => { provideModelSelection(agent, { current: undefined, assembled: undefined }) })
      .toThrow(`agent "${agent.id}" already has a model selection provider`)

    // A provider may arrive after the hook, which then applies it.
    await ctx.plugin(SystemPrompt)
    const later = hookAgent(ctx)
    installModelSelection(later)
    provideModelSelection(later, { current: { provider: 'alpha', model: 'a1' }, assembled: undefined })
    expect(modelSelectionInstalled(later)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('lets a withdrawn provider clear only its own selection', async () => {
    const ctx = new Context()
    const agent = hookAgent(ctx)
    const first: ModelSelectionRef = { current: undefined, assembled: undefined }
    const second: ModelSelectionRef = { current: undefined, assembled: undefined }
    const withdrawFirst = provideModelSelection(agent, first)
    withdrawFirst()
    expect(modelSelectionInstalled(agent)).toBe(true)
    provideModelSelection(agent, second)
    // A stale withdrawal, such as a reloaded provider's late cleanup, leaves the successor in place.
    withdrawFirst()
    expect(() => { provideModelSelection(agent, first) }).toThrow(`agent "${agent.id}" already has a model selection provider`)
    await ctx.fiber.dispose()
  })

  it('passes the resolved request through while no selection is provided', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = hookAgent(ctx)
    installModelSelection(agent)
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal: new AbortController().signal },
      () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })
})

describe('installModelSelection()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const agent = hookAgent(ctx)
    const dispose = installModelSelection(agent)
    provideModelSelection(agent, selection)
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal }, () => Promise.resolve(seed),
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
      'agent/request', { turn: 1, step: 1, content: requestContent(), signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect(modelSelectionInstalled(agent)).toBe(false)
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal }, () => Promise.resolve(seed),
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
  lastRequest: ModelRoutingRequest | undefined

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
    request: ModelRoutingRequest,
  ): Promise<ModelSelection | undefined> {
    this.lastRequest = request
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
    const agent = hookAgent(ctx)
    provideModelSelection(agent, selection)
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, () => undefined)

    await ctx.systemPrompt.assemble()
    // The manual selection is the base the router consults, never the persisted config.
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 3, step: 1, content: requestContent(), signal }, () => Promise.resolve(seed()),
    )).resolves.toEqual({ provider: 'alpha', model: 'a1', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('replaces the route when the router resolves one, stripping inherited effort', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: { provider: 'alpha', model: 'a1' }, assembled: undefined }
    const agent = hookAgent(ctx)
    provideModelSelection(agent, selection)
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
      'agent/request', { turn: 4, step: 0, content: requestContent(), signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({
      provider: 'cheap',
      model: 'c1',
      reasoningEffort: ReasoningEffortId('low'),
      temperature: 0.2,
    })
    // The router sees the manual route, the turn, and the step it is deciding for.
    expect(routed.calls).toEqual([{ turn: 4, step: 0, base: { provider: 'alpha', model: 'a1' } }])
    expect(routed.lastRequest).toEqual({
      config: { provider: 'alpha', model: 'a1', temperature: 0.2 },
      content: requestContent(),
    })
    await ctx.fiber.dispose()
  })

  it('uses the route the router reports beneath a routed header when no selection is provided', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = hookAgent(ctx)
    installModelSelection(agent)
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, () => undefined)
    const routed = ctx.get('modelRouting') as unknown as StubRouting
    const seededFromCandidate: LlmCallConfig = { provider: 'cheap', model: 'c1', reasoningEffort: ReasoningEffortId('low'), temperature: 0.1 }

    // A routed header seeds the request; the manual route beneath it is restored.
    routed.sticky = { provider: 'alpha', model: 'a1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toEqual({ provider: 'alpha', model: 'a1', temperature: 0.1 })
    expect(routed.calls.at(-1)?.base).toEqual({ provider: 'alpha', model: 'a1' })

    // Provider, model, and effort are compared: an entry base that recorded no
    // effort clears the effort the routed header carried, as applySelection does.
    routed.sticky = { provider: 'cheap', model: 'c1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toEqual({ provider: 'cheap', model: 'c1', temperature: 0.1 })
    expect(routed.calls.at(-1)?.base).toEqual({ provider: 'cheap', model: 'c1' })

    // A request already on the reported route is passed through untouched.
    routed.sticky = { provider: 'cheap', model: 'c1', reasoningEffort: ReasoningEffortId('low') }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 1, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toBe(seededFromCandidate)

    // Without a routed header the resolved route is the manual route.
    routed.sticky = undefined
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 3, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toBe(seededFromCandidate)
    expect(routed.calls.at(-1)?.base).toEqual({ provider: 'cheap', model: 'c1', reasoningEffort: ReasoningEffortId('low') })

    // A provided selection is the manual route; the router's report does not replace it.
    routed.sticky = { provider: 'alpha', model: 'a1' }
    provideModelSelection(agent, { current: { provider: 'beta', model: 'b1' }, assembled: undefined })
    await ctx.systemPrompt.assemble()
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 4, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.1 })
    await ctx.fiber.dispose()
  })

  it('keeps the persisted route when no manual selection is assembled', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const agent = hookAgent(ctx)
    provideModelSelection(agent, selection)
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, base => ({ provider: 'cheap', model: base.model }))

    await ctx.systemPrompt.assemble()
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal },
      () => Promise.resolve({ provider: 'persisted', model: 'p1', temperature: 0.1 }),
    )).resolves.toEqual({ provider: 'cheap', model: 'p1', temperature: 0.1 })
    await ctx.fiber.dispose()
  })

  it('carries an effort that reached the request without an assembly through to the consult', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const agent = hookAgent(ctx)
    provideModelSelection(agent, selection)
    const signal = new AbortController().signal
    await ctx.plugin(StubRouting, base => ({ provider: 'cheap', model: base.model }))

    await ctx.systemPrompt.assemble()
    // The manual route the router is handed is the resolved config itself, its
    // effort included: an effort the request carried is what the gate compares
    // and what a held streak records as its entry base.
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal },
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

describe('the agent/route-base record', () => {
  const MANUAL: ModelSelection = { provider: 'alpha', model: 'a1' }
  const CHEAP: ModelSelection = { provider: 'cheap', model: 'c1', reasoningEffort: ReasoningEffortId('low') }

  /** An agent whose front end provides MANUAL, with a stub router answering through `answer`. */
  async function routedAgent(
    answer: (base: ModelSelection) => ModelSelection | undefined,
  ): Promise<{ ctx: Context; agent: Agent; selection: ModelSelectionRef }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = hookAgent(ctx)
    const selection: ModelSelectionRef = { current: MANUAL, assembled: undefined }
    provideModelSelection(agent, selection)
    await ctx.plugin(StubRouting, answer)
    return { ctx, agent, selection }
  }

  /** Run one request through the hook, then log its header as the loop does after the waterfall. */
  async function request(ctx: Context, agent: Agent, signal = new AbortController().signal): Promise<LlmCallConfig> {
    await ctx.systemPrompt.assemble()
    const config = await agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal }, () => Promise.resolve({ provider: 'alpha', model: 'a1' }),
    )
    agent.session.append('request/header', { header: { config }, reason: 'change' })
    return config
  }

  it('records agent/route-base when routing rewrites the request', async () => {
    const { ctx, agent } = await routedAgent(() => CHEAP)
    await expect(request(ctx, agent)).resolves.toEqual(CHEAP)
    expect(routeBases(agent.session.events)).toEqual([{ manual: MANUAL, routed: CHEAP }])
    expect(manualBaseOfLastHeader(agent.session.events)).toEqual(MANUAL)
    await ctx.fiber.dispose()
  })

  it('writes no agent/route-base when routing keeps the manual route or is absent', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    const unrouted = hookAgent(bare)
    provideModelSelection(unrouted, { current: MANUAL, assembled: undefined })
    await expect(request(bare, unrouted)).resolves.toEqual(MANUAL)
    const kept = await routedAgent(() => undefined)
    await expect(request(kept.ctx, kept.agent)).resolves.toEqual(MANUAL)
    const same = await routedAgent(base => ({ ...base }))
    await expect(request(same.ctx, same.agent)).resolves.toEqual(MANUAL)
    for (const agent of [unrouted, kept.agent, same.agent]) {
      expect(routeBases(agent.session.events)).toEqual([])
    }
    for (const ctx of [bare, kept.ctx, same.ctx]) await ctx.fiber.dispose()
  })

  it('does not repeat an equal agent/route-base across held steps', async () => {
    let answer: ModelSelection | undefined = CHEAP
    const { ctx, agent, selection } = await routedAgent(() => answer)
    await request(ctx, agent)
    await request(ctx, agent)
    await request(ctx, agent)
    expect(routeBases(agent.session.events)).toEqual([{ manual: MANUAL, routed: CHEAP }])

    // A header on the manual route ends the run the record describes, so the
    // next streak records its own, even though it names the same two routes.
    answer = undefined
    await request(ctx, agent)
    answer = CHEAP
    await request(ctx, agent)
    expect(routeBases(agent.session.events)).toEqual([{ manual: MANUAL, routed: CHEAP }, { manual: MANUAL, routed: CHEAP }])
    expect(manualBaseOfLastHeader(agent.session.events)).toEqual(MANUAL)

    // A new manual route beneath the same routed header is a new record.
    const beta: ModelSelection = { provider: 'beta', model: 'b1' }
    selection.current = beta
    await request(ctx, agent)
    expect(routeBases(agent.session.events).at(-1)).toEqual({ manual: beta, routed: CHEAP })
    expect(manualBaseOfLastHeader(agent.session.events)).toEqual(beta)
    await ctx.fiber.dispose()
  })

  it('appends before the request header', async () => {
    const { ctx, agent } = await routedAgent(() => CHEAP)
    await request(ctx, agent)
    const [record, header] = agent.session.events
    expect([record?.type, header?.type]).toEqual(['agent/route-base', 'request/header'])
    expect(record!.seq).toBeLessThan(header!.seq)
    await ctx.fiber.dispose()
  })

  it('an aborted request after the append leaves an orphan the reader ignores', async () => {
    let answer: ModelSelection | undefined = CHEAP
    const { ctx, agent } = await routedAgent(() => answer)
    // The hook appended the record, then the request was aborted before its header was logged.
    await ctx.systemPrompt.assemble()
    await agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, content: requestContent(), signal: new AbortController().signal },
      () => Promise.resolve({ provider: 'alpha', model: 'a1' }),
    )
    expect(routeBases(agent.session.events)).toHaveLength(1)
    answer = undefined
    await request(ctx, agent)
    expect(manualBaseOfLastHeader(agent.session.events)).toBeUndefined()

    // A request already aborted when routing answers records nothing.
    const controller = new AbortController()
    const aborted = await routedAgent(() => {
      controller.abort()
      return CHEAP
    })
    await expect(request(aborted.ctx, aborted.agent, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(routeBases(aborted.agent.session.events)).toEqual([])
    await ctx.fiber.dispose()
    await aborted.ctx.fiber.dispose()
  })

  it('returns an agent with no provided selection to the recorded manual route, before any router report', async () => {
    const seededFromCandidate: LlmCallConfig = { ...CHEAP, temperature: 0.1 }
    /** An agent with no front-end selection whose log ends on a routed header. */
    const recordedAgent = (ctx: Context, id: string, events: SessionEvent[]): Agent =>
      ({ id, ctx, session: Session.create(SessionId(id), events.map((event, seq) => ({ ...event, seq }))) }) as unknown as Agent
    const signal = new AbortController().signal

    // No router composed: the recorded route restores the manual route and
    // clears the candidate's effort.
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    const restored = recordedAgent(bare, 'recorded-unrouted', [routeBaseEvent(MANUAL, CHEAP), headerEvent(CHEAP)])
    installModelSelection(restored)
    await expect(agentEvents(bare, restored).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toEqual({ ...MANUAL, temperature: 0.1 })

    // A log written before the record existed keeps its routed header.
    const legacy = recordedAgent(bare, 'recorded-legacy', [headerEvent(CHEAP)])
    installModelSelection(legacy)
    await expect(agentEvents(bare, legacy).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )).resolves.toBe(seededFromCandidate)

    // A composed router's report comes first; the record is read only when it reports none.
    const routedCtx = new Context()
    await routedCtx.plugin(SystemPrompt)
    await routedCtx.plugin(StubRouting, () => undefined)
    const routing = routedCtx.get('modelRouting') as unknown as StubRouting
    const reported = recordedAgent(routedCtx, 'recorded-routed', [routeBaseEvent(MANUAL, CHEAP), headerEvent(CHEAP)])
    installModelSelection(reported)
    routing.sticky = { provider: 'gamma', model: 'g1' }
    await agentEvents(routedCtx, reported).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )
    routing.sticky = undefined
    await agentEvents(routedCtx, reported).waterfall(
      'agent/request', { turn: 2, step: 1, content: requestContent(), signal }, () => Promise.resolve(seededFromCandidate),
    )
    expect(routing.calls.map(call => call.base)).toEqual([{ provider: 'gamma', model: 'g1' }, MANUAL])
    await bare.fiber.dispose()
    await routedCtx.fiber.dispose()
  })

  it('a fork seeded from a routed parent restores the manual route with no router and no provided selection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    const parent = ctx.sessions.create(SessionId('route-base-fork-parent'))
    parent.append('turn/start', { turn: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'easy turn' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('agent/route-base', { manual: MANUAL, routed: CHEAP })
    parent.append('request/header', { header: { config: CHEAP }, reason: 'initial' })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const childSession = ctx.sessions.fork(parent, undefined, SessionId('route-base-fork-child'))
    expect(childSession.header.parentSession).toBe(parent.id)
    expect(childSession.events.filter(event => event.type === 'agent/route-base').map(event => event.data))
      .toEqual([{ manual: MANUAL, routed: CHEAP }])
    expect(childSession.requestHeader()?.config).toEqual(CHEAP)

    const child = { id: childSession.id, ctx, session: childSession } as unknown as Agent
    installModelSelection(child)
    expect(modelSelectionInstalled(child)).toBe(true)
    expect(selectionInForce(child)).toEqual(MANUAL)
    const seededFromCandidate: LlmCallConfig = { ...CHEAP, temperature: 0.1 }
    await expect(agentEvents(ctx, child).waterfall(
      'agent/request', { turn: 2, step: 0, content: requestContent(), signal: new AbortController().signal },
      () => Promise.resolve(seededFromCandidate),
    )).resolves.toEqual({ ...MANUAL, temperature: 0.1 })
    await ctx.fiber.dispose()
  })
})

describe('manualBaseOfLastHeader()', () => {
  const MANUAL: ModelSelection = { provider: 'alpha', model: 'a1', reasoningEffort: ReasoningEffortId('max') }
  const CHEAP: ModelSelection = { provider: 'cheap', model: 'c1' }

  it('reads the manual route recorded beneath a routed header', () => {
    const events = [headerEvent(MANUAL), routeBaseEvent(MANUAL, CHEAP), headerEvent(CHEAP), headerEvent({ ...CHEAP, temperature: 0.3 })]
    const base = manualBaseOfLastHeader(events)
    expect(base).toEqual(MANUAL)
    // The result is detached from the durable record.
    expect(base).not.toBe((events[1]!.data as { manual: ModelSelection }).manual)
  })

  it('returns undefined when the last header runs the manual route, or when no header is logged', () => {
    expect(manualBaseOfLastHeader([routeBaseEvent(MANUAL, CHEAP), headerEvent(CHEAP), headerEvent(MANUAL)])).toBeUndefined()
    expect(manualBaseOfLastHeader([routeBaseEvent(MANUAL, CHEAP)])).toBeUndefined()
    expect(manualBaseOfLastHeader([])).toBeUndefined()
  })

  it('ends the search at a header on another route', () => {
    // The record precedes a manual header, so it describes an earlier streak, not this one.
    expect(manualBaseOfLastHeader([routeBaseEvent(MANUAL, CHEAP), headerEvent(CHEAP), headerEvent(MANUAL), headerEvent(CHEAP)]))
      .toBeUndefined()
  })

  it('reads the latest matching record and skips a record for another route', () => {
    const beta: ModelSelection = { provider: 'beta', model: 'b1' }
    const other: ModelSelection = { provider: 'other', model: 'o1' }
    const events = [
      routeBaseEvent(MANUAL, CHEAP), routeBaseEvent(beta, CHEAP), routeBaseEvent(beta, other), headerEvent(CHEAP),
    ]
    expect(manualBaseOfLastHeader(events))
      .toEqual(beta)
  })

  it('compares effort only when the record names one', () => {
    // A header whose effort the adapter defaulted still runs a record that named none.
    const defaulted = { ...CHEAP, reasoningEffort: ReasoningEffortId('high') }
    expect(manualBaseOfLastHeader([routeBaseEvent(MANUAL, CHEAP), headerEvent(defaulted, true)])).toEqual(MANUAL)
    // A record that named an effort describes only a header with that effort.
    const low = { ...CHEAP, reasoningEffort: ReasoningEffortId('low') }
    expect(manualBaseOfLastHeader([routeBaseEvent(MANUAL, low), headerEvent(defaulted, true)])).toBeUndefined()
    expect(manualBaseOfLastHeader([routeBaseEvent(MANUAL, low), headerEvent(low)])).toEqual(MANUAL)
  })

  it('returns undefined for a log written before the record existed', () => {
    expect(manualBaseOfLastHeader([headerEvent(MANUAL), headerEvent(CHEAP)])).toBeUndefined()
  })

  it.each([
    ['null', null, 'agent/route-base data must be an object'],
    ['unknown field', { manual: MANUAL, routed: CHEAP, extra: 1 }, 'agent/route-base has an unknown field: extra'],
    ['missing manual', { routed: CHEAP }, 'agent/route-base manual data must be an object'],
    ['blank routed model', { manual: MANUAL, routed: { provider: 'cheap', model: ' ' } }, 'agent/route-base routed model must be a nonempty string'],
  ] as const)('rejects a corrupted record: %s', (_name, data, message) => {
    const corrupted = { type: 'agent/route-base', seq: eventSeq++, time: 0, data } as unknown as SessionEvent
    expect(() => manualBaseOfLastHeader([corrupted, headerEvent(CHEAP)])).toThrow(message)
  })
})

describe('selectionInForce()', () => {
  /**
   * The Agent surface this suite scripts: a context to reach the routing
   * consult through, and the session header the getter falls back to.
   * @param ctx - the context the agent reads services from.
   * @param header - the session's latest request header, when one is logged.
   * @param events - the durable event prefix the getter folds.
   * @returns the minimal Agent.
   */
  function agentFor(
    ctx: Context,
    header?: { config: ModelSelection },
    events: readonly SessionEvent[] = [],
  ): Agent {
    return {
      id: 'selection-in-force',
      ctx,
      session: { events, requestHeader: () => header },
    } as unknown as Agent
  }

  let restoredSessionNumber = 0

  /** Build an Agent whose selection event crossed the Session seed boundary. */
  function restoredAgent(ctx: Context, data: unknown): Agent {
    const session = Session.create(SessionId(`selection-restore-${++restoredSessionNumber}`), [{
      type: 'agent/model-selection',
      seq: 0,
      time: 1,
      data,
    } as unknown as SessionEvent])
    return { id: session.id, ctx, session } as unknown as Agent
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

  it('reports an explicit selection even when it matches the routed header', async () => {
    const ctx = new Context()
    await ctx.plugin(StubRouting, () => undefined)
    const routing = ctx.get('modelRouting') as unknown as StubRouting
    routing.sticky = { provider: 'manual-provider', model: 'manual-model' }
    const events = [
      {
        type: 'agent/model-selection',
        seq: 0,
        time: 1,
        data: { provider: 'cheap-provider', model: 'cheap-model' },
      },
      {
        type: 'request/header',
        seq: 1,
        time: 2,
        data: { header: { config: { provider: 'cheap-provider', model: 'cheap-model' } }, reason: 'change' },
      },
    ] as SessionEvent[]
    const agent = agentFor(ctx, { config: { provider: 'cheap-provider', model: 'cheap-model' } }, events)

    expect(selectionInForce(agent)).toEqual({ provider: 'cheap-provider', model: 'cheap-model' })
    await ctx.fiber.dispose()
  })

  it('round-trips a valid seeded selection with effort and returns a detached value', async () => {
    const ctx = new Context()
    const agent = restoredAgent(ctx, {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: 'high',
    })

    const restored = selectionInForce(agent)
    expect(restored).toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(restored).not.toBe(agent.session.events[0]?.data)
    if (restored === undefined) throw new Error('expected a seeded selection')
    restored.provider = 'mutated-provider'
    restored.model = 'mutated-model'
    restored.reasoningEffort = ReasoningEffortId('low')
    expect(selectionInForce(agent)).toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    await ctx.fiber.dispose()
  })

  it('reports the manual route recorded beneath a routed header when no router is composed', async () => {
    const ctx = new Context()
    const manual: ModelSelection = { provider: 'alpha', model: 'a1' }
    const candidate: ModelSelection = { provider: 'cheap', model: 'c1', reasoningEffort: ReasoningEffortId('low') }
    const events = [routeBaseEvent(manual, candidate), headerEvent(candidate)]
    expect(selectionInForce(agentFor(ctx, { config: candidate }, events))).toEqual(manual)
    // A log written before the record existed reports its last header.
    expect(selectionInForce(agentFor(ctx, { config: candidate }, [headerEvent(candidate)]))).toEqual(candidate)

    // A composed router's report comes before the record, and an explicit selection before both.
    await ctx.plugin(StubRouting, () => undefined)
    const routing = ctx.get('modelRouting') as unknown as StubRouting
    routing.sticky = { provider: 'gamma', model: 'g1' }
    expect(selectionInForce(agentFor(ctx, { config: candidate }, events))).toEqual({ provider: 'gamma', model: 'g1' })
    const explicit = { type: 'agent/model-selection', seq: eventSeq++, time: 0, data: { provider: 'beta', model: 'b1' } } as unknown as SessionEvent
    expect(selectionInForce(agentFor(ctx, { config: candidate }, [...events, explicit]))).toEqual({ provider: 'beta', model: 'b1' })
    await ctx.fiber.dispose()
  })

  it.each([
    ['null', null, 'agent/model-selection data must be an object'],
    ['array', [], 'agent/model-selection data must be an object'],
    ['string', 'selection', 'agent/model-selection data must be an object'],
    ['number', 1, 'agent/model-selection data must be an object'],
    ['missing provider', { model: 'a1' }, 'agent/model-selection provider must be a nonempty string'],
    ['wrong provider', { provider: 1, model: 'a1' }, 'agent/model-selection provider must be a nonempty string'],
    ['blank provider', { provider: '   ', model: 'a1' }, 'agent/model-selection provider must be a nonempty string'],
    ['missing model', { provider: 'alpha' }, 'agent/model-selection model must be a nonempty string'],
    ['wrong model', { provider: 'alpha', model: 1 }, 'agent/model-selection model must be a nonempty string'],
    ['blank model', { provider: 'alpha', model: '   ' }, 'agent/model-selection model must be a nonempty string'],
    ['wrong effort', { provider: 'alpha', model: 'a1', reasoningEffort: 1 }, 'agent/model-selection reasoningEffort must be a nonempty string when present'],
    ['blank effort', { provider: 'alpha', model: 'a1', reasoningEffort: '   ' }, 'agent/model-selection reasoningEffort must be a nonempty string when present'],
    ['unknown field', { provider: 'alpha', model: 'a1', extra: true }, 'agent/model-selection has an unknown field: extra'],
  ] as const)('rejects corrupted seeded selection data: %s', async (_name, data, message) => {
    const ctx = new Context()
    expect(() => selectionInForce(restoredAgent(ctx, data))).toThrow(message)
    await ctx.fiber.dispose()
  })
})
