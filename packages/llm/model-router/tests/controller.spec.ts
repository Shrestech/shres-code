/**
 * \`ctx.modelRouting\` through the REAL plugin: mode, the downgrade gate and its
 * exact boundaries, every fallback class, the sticky streak transitions, the
 * intra-turn pin, the assembled state, the log shape, the projection unit, and
 * HMR disposal.
 *
 * TEST DOUBLES (all local to this suite, all labelled):
 * - {@link ScriptedJudgment}: the smallest real \`JudgmentService\` subclass — it
 *   answers the router's questions from a script and records every ask. Mounted
 *   through \`ctx.plugin\` exactly as a provider is.
 * - {@link MemorySettings}: the smallest real settings provider (one in-memory
 *   document), used only for the deployment-toggle case.
 * - {@link agentFor}: the smallest honest Agent surface — a real \`Session\` behind
 *   the fields the consult reads. Chosen over the agent-loop testkit because the
 *   consult takes plain \`(agent, turn, step, base, signal)\` and needs no loop.
 *
 * The session is a real store session, so every append publishes
 * \`session/event\` and runs this package's invariant companion.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry, { agentEvents } from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection } from '@shres-code/shres-code-agent'
import CommandRuntime from '@shres-code/shres-code-commands'
import JudgmentService, { JUDGMENT_SETTINGS_NAMESPACE, JudgmentError } from '@shres-code/shres-code-judgment'
import type {
  JudgmentAnswer,
  JudgmentChoiceAnswer,
  JudgmentInput,
  JudgmentFittingEngine,
  JudgmentTokenLimits,
  JudgmentResult,
  JudgmentScoreAnswer,
} from '@shres-code/shres-code-judgment'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  createToolResultMessage,
  createUserMessage,
} from '@shres-code/shres-code-llm'
import type {
  GenerateOptions,
  LlmCallConfigAdapterDefaults,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session, SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import { CommandId } from '@shres-code/shres-code-commands/brand'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import ModelRoutingController, {
  DIFFICULTY_QUESTION_ID,
  KEEP_CURRENT_OPTION_ID,
  MODEL_ROUTER_SETTINGS_NAMESPACE,
  ROUTE_QUESTION_ID,
  stateHash,
} from '../src/index.ts'
import { stickyState } from '../src/folds.ts'
import type { ModelRouterConfig } from '../src/config.ts'
import type { ModelRoutingDecision, ModelRoutingProjection } from '../src/types.ts'

/** Manual (strong) route every case starts on. */
const STRONG: ModelSelection = { provider: 'strong-provider', model: 'strong-model' }

/** The route the allowlisted candidate runs. */
const CHEAP = { provider: 'cheap-provider', model: 'cheap-model' }

/** A second allowlisted route used to exercise sticky candidate transitions. */
const MID = { provider: 'mid-provider', model: 'mid-model' }

const CONFIG: ModelRouterConfig = {
  initialMode: 'on',
  candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a small change in familiar code' }],
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  routeInstructions: 'Pick the cheapest route that can finish this turn.',
  difficultyInstructions: 'Rate how much reasoning this turn needs.',
}

/** The scripted route answer that passes the default gate. */
const PASSING: JudgmentChoiceAnswer = {
  kind: 'choice',
  id: ROUTE_QUESTION_ID,
  option: 'cheap',
  probabilities: { cheap: 0.9, strong: 0.02 },
  confidence: 0.9,
}

/** A route answer below the confidence floor. */
const LOW_CONFIDENCE: JudgmentChoiceAnswer = { ...PASSING, confidence: 0.5 }

/** A route answer whose top-two margin is below the margin floor. */
const THIN_MARGIN: JudgmentChoiceAnswer = { ...PASSING, probabilities: { cheap: 0.6, strong: 0.5 } }

/** The scripted difficulty answer: an easy turn. */
const EASY: JudgmentScoreAnswer = {
  kind: 'score',
  id: DIFFICULTY_QUESTION_ID,
  score: 1,
  probabilities: { '0': 1 },
  confidence: 0.9,
}

/** TEST DOUBLE: a scripted judgment engine, mounted as a real provider. */
class ScriptedJudgment extends JudgmentService {
  declare fitting?: JudgmentFittingEngine
  /** Every ask, in order. */
  readonly asks: JudgmentInput[] = []
  /** Route answer to return; \`undefined\` answers no route question at all. */
  choice: JudgmentChoiceAnswer | undefined = PASSING
  /** Difficulty answer to return; \`undefined\` answers no score question. */
  score: JudgmentScoreAnswer | undefined = EASY
  /** When set, the ask rejects with it instead of answering. */
  failure: Error | undefined
  /** Optional deferred response used by cancellation tests. */
  askOverride: ((input: JudgmentInput) => Promise<JudgmentResult>) | undefined

  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    const askOverride = this.askOverride
    if (askOverride !== undefined) return askOverride(input)
    const failure = this.failure
    if (failure !== undefined) return Promise.reject(failure)
    const answers: JudgmentAnswer[] = []
    if (this.choice !== undefined && input.questions.some(question => question.kind === 'choice')) {
      answers.push(this.choice)
    }
    if (this.score !== undefined && input.questions.some(question => question.kind === 'score')) {
      answers.push(this.score)
    }
    return Promise.resolve({ answers, engine: 'scripted-judgment', model: 'scripted-1', latencyMs: 3 })
  }
}

/** TEST DOUBLE: exact route metadata used by the controller's capability preflight. */
class RoutingCapabilityAdapter extends LlmAdapter {
  private readonly overrides: Record<string, Partial<LlmResolvedModelInfo>>

  constructor(overrides: Readonly<Record<string, Partial<LlmResolvedModelInfo>>> = {}) {
    super()
    this.overrides = { ...overrides }
  }

  setModelInfo(provider: string, model: string, info: Partial<LlmResolvedModelInfo>): void {
    this.overrides[`${provider}/${model}`] = info
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const override = this.overrides[`${provider}/${model}`]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
      inputModalities: ['text', 'image'] satisfies readonly ModelModality[],
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'low' },
          { id: ReasoningEffortId('medium'), name: 'medium' },
          { id: ReasoningEffortId('high'), name: 'high' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
      ...override,
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return
  }
}

/** TEST DOUBLE: the smallest real settings provider — one in-memory document. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** TEST DOUBLE: the smallest honest Agent surface for a consult. */
function agentFor(session: Session, ctx: Context): Agent {
  return { id: session.id, session, ctx } as unknown as Agent
}

/** Agent-shaped replay view for malformed or invariant-rejected log prefixes. */
function agentForEvents(events: readonly SessionEvent[]): Agent {
  return { id: 'replayed', session: { events } } as unknown as Agent
}

interface Bench {
  ctx: Context
  session: Session
  agent: Agent
  signal: AbortSignal
  engine: ScriptedJudgment
  adapter: RoutingCapabilityAdapter
  llmFiber?: { dispose(): Promise<void> }
  /** One consult for a turn, against the strong manual route by default. */
  resolve(turn?: number, base?: ModelSelection, signal?: AbortSignal, step?: number): Promise<ModelSelection | undefined>
  decisions(): ModelRoutingDecision[]
  decision(index?: number): ModelRoutingDecision
}

interface BenchOptions {
  config?: ModelRouterConfig
  /** Leave the LLM capability unmounted for composition-gap cases. */
  llm?: boolean
  /** Mount the scripted engine (default true). */
  engine?: boolean
  commands?: boolean
  projections?: boolean
  /** Mount the settings provider (needed for the deployment toggle). */
  settings?: boolean
  /** Exact model metadata overrides used by capability regression cases. */
  capabilities?: Readonly<Record<string, Partial<LlmResolvedModelInfo>>>
}

async function bench(options: BenchOptions = {}): Promise<Bench> {
  const ctx = new Context()
  const llmFiber = options.llm === false ? undefined : await ctx.plugin(LlmRuntime)
  const config = options.config ?? CONFIG
  const providers = new Set([
    STRONG.provider,
    CHEAP.provider,
    MID.provider,
    'other-provider',
    ...(config.candidates ?? []).map(candidate => candidate.provider),
  ])
  const adapter = new RoutingCapabilityAdapter(options.capabilities)
  if (llmFiber !== undefined) ctx.llm.registerAdapter([...providers], adapter)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (options.settings === true) await ctx.plugin(MemorySettings)
  if (options.projections === true) await ctx.plugin(SessionProjectionRegistry)
  if (options.engine !== false) await ctx.plugin(ScriptedJudgment)
  if (options.commands === true) {
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
  }
  await ctx.plugin(ModelRoutingController, config)
  const session = ctx.sessions.create()
  const agent = agentFor(session, ctx)
  ctx.agents.register(agent)
  const signal = new AbortController().signal
  const decisions = (): ModelRoutingDecision[] => session.events.flatMap(
    event => event.type === 'model-routing/decision' ? [event.data] : [],
  )
  return {
    ctx,
    session,
    agent,
    signal,
    engine: ctx.judgment as ScriptedJudgment,
    adapter,
    ...llmFiber === undefined ? {} : { llmFiber },
    resolve: (turn = 1, base = STRONG, requestSignal = signal, step = 1) =>
      ctx.modelRouting.resolveRequest(agent, turn, step, base, requestSignal, {
        config: base,
        content: { messages: session.deriveMessages(), system: '', tools: [] },
      }),
    decisions,
    decision: (index = 0) => {
      const found = decisions()[index]
      if (found === undefined) throw new Error(`no routing decision at index ${String(index)}`)
      return found
    },
  }
}

/** One logged user message. */
function user(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' }).seq
}

/** One full request-header snapshot for a route. */
function header(
  session: Session,
  provider: string,
  model: string,
  system?: string,
  reasoningEffort?: ModelSelection['reasoningEffort'],
  adapterDefaults?: LlmCallConfigAdapterDefaults,
): void {
  session.append('request/header', {
    header: {
      config: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } },
      ...adapterDefaults === undefined ? {} : { adapterDefaults },
      ...system === undefined ? {} : { system },
    },
    reason: 'initial',
  })
}

function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

function closeTurn(session: Session, turn: number, reason: TurnEndReason = { kind: 'completed' }): void {
  session.append('turn/end', { turn, reason })
}

/** One turn that failed on its route. */
function routeFailure(session: Session, turn: number): void {
  closeTurn(session, turn, { kind: 'error', error: { message: 'the route failed', code: 'RATE_LIMIT' } })
}

/** The projection the real registry serves for a session. */
function projectionOf(ctx: Context, session: Session): ModelRoutingProjection {
  return ctx.sessionProjections.snapshot(session).values.modelRouting as ModelRoutingProjection
}

describe('mode', () => {
  it('with routing off makes no judgment call and writes no event at all', async () => {
    const b = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    const before = b.session.events.map(event => event.type)

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.session.events.map(event => event.type)).toEqual(before)
    expect(b.ctx.modelRouting.modeOf(b.session)).toBe(false)
  })

  it('with routing on judges the turn, logs the decision, and returns the allowlisted route', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    user(b.session, 'a small change')

    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(1)
    expect(b.engine.asks[0]).toMatchObject({
      state: JSON.stringify([{
        seq: 2,
        role: 'user',
        source: 'user',
        content: [{ type: 'text', text: 'a small change' }],
      }]),
      tier: 'fast',
    })
    expect(b.engine.asks[0]?.signal).toBe(b.signal)
    const questions = b.engine.asks[0]?.questions ?? []
    expect(questions).toHaveLength(2)
    const route = questions[0]
    expect(route).toMatchObject({ kind: 'choice', id: ROUTE_QUESTION_ID, instructions: CONFIG.routeInstructions })
    if (route?.kind !== 'choice') throw new Error('the route question was not a choice question')
    expect(route.options.map(option => option.option)).toEqual([KEEP_CURRENT_OPTION_ID, 'cheap'])
    expect(route.options[0]?.description).toContain(`${STRONG.provider}/${STRONG.model}`)
    expect(route.options[1]?.description).toContain(`${CHEAP.provider}/${CHEAP.model}`)
    expect(route.options[1]?.description).toContain('a small change in familiar code')
    expect(questions[1]).toEqual({
      kind: 'score',
      id: DIFFICULTY_QUESTION_ID,
      instructions: CONFIG.difficultyInstructions,
      levels: [...(b.ctx.modelRouting.config().difficultyLevels)],
    })
  })

  it('commits a between-turns switch, reports noop for the mode already in force, and folds it from the log', async () => {
    const b = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: false })
    expect(b.ctx.modelRouting.set(b.agent, false)).toBe('committed')

    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('committed')
    expect(b.ctx.modelRouting.modeOf(b.session)).toBe(true)
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true })
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('noop')
    expect(b.ctx.modelRouting.set(b.agent, false)).toBe('committed')
    expect(b.session.events.flatMap(event => event.type === 'model-routing/mode' ? [event.data.active] : [])).toEqual([false, true, false])
  })

  it('queues a switch during an open turn and commits it at the next accepted pre-step', async () => {
    const b = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(b.session, 1)
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('queued')
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('noop')
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: false, pending: true })
    expect(b.session.events.some(event => event.type === 'model-routing/mode')).toBe(false)

    const decision = await agentEvents(b.ctx, b.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: b.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(b.ctx.modelRouting.modeOf(b.session)).toBe(true)
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true })
  })

  it('leaves a queued switch uncommitted when the pre-step is rejected or aborted', async () => {
    const rejected = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(rejected.session, 1)
    rejected.ctx.modelRouting.set(rejected.agent, true)
    await agentEvents(rejected.ctx, rejected.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: rejected.signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(rejected.session.events.some(event => event.type === 'model-routing/mode')).toBe(false)

    const aborted = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(aborted.session, 1)
    aborted.ctx.modelRouting.set(aborted.agent, true)
    const controller = new AbortController()
    controller.abort()
    await agentEvents(aborted.ctx, aborted.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(aborted.session.events.some(event => event.type === 'model-routing/mode')).toBe(false)
  })

  it('cancels queued changes while preserving the explicit user selection', async () => {
    const cancelled = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(cancelled.session, 1)
    expect(cancelled.ctx.modelRouting.set(cancelled.agent, true)).toBe('queued')
    closeTurn(cancelled.session, 1)
    // An explicit choice remains authoritative even when it matches the deployment default.
    expect(cancelled.ctx.modelRouting.set(cancelled.agent, false)).toBe('cancelled')
    expect(cancelled.session.events.at(-1)).toMatchObject({ type: 'model-routing/mode', data: { active: false } })
    expect(cancelled.ctx.modelRouting.get(cancelled.agent)).toEqual({ active: false })

    const netted = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(netted.session, 1)
    netted.ctx.modelRouting.set(netted.agent, true)
    netted.ctx.modelRouting.set(netted.agent, false)
    await agentEvents(netted.ctx, netted.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: netted.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(netted.session.events.filter(event => event.type === 'model-routing/mode')).toHaveLength(1)
  })
})

describe('deployment mode and session authority', () => {
  async function preStep(b: Bench, kind: 'enter' | 'reject' = 'enter', signal = b.signal): Promise<void> {
    await agentEvents(b.ctx, b.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve(kind === 'enter' ? { kind, messages: [] } : { kind }),
    )
  }

  it('updates a cached projection and publishes a new durable sequence for each deployment mode change', async () => {
    const b = await bench({ settings: true, projections: true, config: { ...CONFIG, initialMode: 'off' } })
    expect(projectionOf(b.ctx, b.session).active).toBe(false)
    const changes: Array<{ seq: number; value: unknown }> = []
    b.ctx.sessionProjections.onChanged((session, key, value, seq) => {
      if (session === b.session && key === 'modelRouting') changes.push({ seq, value })
    })
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'on' })
    expect(b.ctx.modelRouting.modeOf(b.session)).toBe(true)
    expect(projectionOf(b.ctx, b.session).active).toBe(true)
    expect(changes.at(-1)).toMatchObject({ seq: 0, value: { active: true } })
    expect(b.session.events.at(-1)).toMatchObject({ type: 'model-routing/configuration', data: { active: true } })

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(b.ctx.modelRouting.modeOf(b.session)).toBe(false)
    expect(projectionOf(b.ctx, b.session).active).toBe(false)
    expect(changes.at(-1)).toMatchObject({ seq: 1, value: { active: false } })
    expect(b.ctx.modelRouting.modeOf(b.session, 1)).toBe(true)
  })

  it('preserves an explicit same-valued user choice across settings updates and replay', async () => {
    for (const active of [false, true]) {
      const b = await bench({ settings: true, projections: true, config: { ...CONFIG, initialMode: active ? 'on' : 'off' } })
      expect(b.ctx.modelRouting.set(b.agent, active)).toBe('committed')
      expect(b.ctx.modelRouting.set(b.agent, active)).toBe('noop')
      const before = b.session.events.length
      await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: active ? 'off' : 'on' })
      expect(b.session.events).toHaveLength(before)
      expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active })
      expect(projectionOf(b.ctx, b.session).active).toBe(active)
    }
  })

  it('defers a deployment change through rejected and aborted steps, then commits before an accepted request', async () => {
    const b = await bench({ settings: true, projections: true })
    openTurn(b.session, 1)
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true, pending: false })
    await preStep(b, 'reject')
    const cancelled = new AbortController()
    cancelled.abort()
    await preStep(b, 'enter', cancelled.signal)
    expect(projectionOf(b.ctx, b.session).active).toBe(true)
    await preStep(b)
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: false })
    expect(projectionOf(b.ctx, b.session).active).toBe(false)
    expect(await b.resolve()).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
  })

  it('cancels a queued deployment change when the setting returns to the committed value', async () => {
    const b = await bench({ settings: true })
    openTurn(b.session, 1)
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'on' })
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true })
    await preStep(b)
    expect(b.session.events.filter(event => event.type === 'model-routing/configuration')).toHaveLength(1)
  })

  it('keeps a pending user choice ahead of later settings changes', async () => {
    const b = await bench({ settings: true, projections: true, config: { ...CONFIG, initialMode: 'off' } })
    openTurn(b.session, 1)
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('queued')
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'on' })
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    await preStep(b)
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true })
    expect(projectionOf(b.ctx, b.session).active).toBe(true)
    expect(b.session.events.at(-1)).toMatchObject({ type: 'model-routing/mode', data: { active: true } })
  })

  it('lets an explicit current-mode choice cancel a queued deployment change', async () => {
    const b = await bench({ settings: true })
    openTurn(b.session, 1)
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('cancelled')
    await preStep(b)
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true })
    expect(b.session.events.at(-1)).toMatchObject({ type: 'model-routing/mode', data: { active: true } })
  })

  it('initializes agents already live at mount and releases their settings subscriptions on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create()
    const agent = agentFor(session, ctx)
    const detach = ctx.agents.register(agent)
    const router = await ctx.plugin(ModelRoutingController, CONFIG)
    expect(projectionOf(ctx, session).active).toBe(true)
    detach()
    const before = session.events.length
    await ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(session.events).toHaveLength(before)
    await router.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps isolated controllers independent while their projection uses one pure definition', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    const left = ctx.isolate('modelRouting').isolate('settings')
    const right = ctx.isolate('modelRouting').isolate('settings')
    await left.plugin(MemorySettings)
    await right.plugin(MemorySettings)
    await left.plugin(ModelRoutingController, CONFIG)
    await right.plugin(ModelRoutingController, { ...CONFIG, initialMode: 'off' })
    const leftAgent = agentFor(ctx.sessions.create(), left)
    const rightAgent = agentFor(ctx.sessions.create(), right)
    const unownedAgent = agentFor(ctx.sessions.create(), ctx)
    ctx.agents.register(leftAgent)
    ctx.agents.register(rightAgent)
    ctx.agents.register(unownedAgent)
    expect(projectionOf(ctx, leftAgent.session).active).toBe(true)
    expect(projectionOf(ctx, rightAgent.session).active).toBe(false)
    await right.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'on' })
    await left.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(projectionOf(ctx, leftAgent.session).active).toBe(false)
    expect(projectionOf(ctx, rightAgent.session).active).toBe(true)
    expect(unownedAgent.session.events).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('drops pending work when a live agent changes its routing service context', async () => {
    const b = await bench({ settings: true })
    const session = b.ctx.sessions.create()
    let currentContext = b.ctx
    const agent = { ...agentFor(session, currentContext), get ctx() { return currentContext } }
    b.ctx.agents.register(agent)
    openTurn(session, 1)
    expect(b.ctx.modelRouting.set(agent, false)).toBe('queued')
    currentContext = b.ctx.isolate('modelRouting')
    const before = session.events.length
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(session.events).toHaveLength(before)
    expect(b.ctx.modelRouting.get(agent)).toEqual({ active: true })
    await agentEvents(b.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: b.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(session.events).toHaveLength(before)
  })

  it('leaves cold sessions unchanged until they acquire a live routing owner', async () => {
    const b = await bench({ settings: true, projections: true })
    const cold = b.ctx.sessions.create()
    expect(projectionOf(b.ctx, cold).active).toBe(false)
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'on' })
    expect(cold.events).toHaveLength(0)
    b.ctx.agents.register(agentFor(cold, b.ctx))
    expect(projectionOf(b.ctx, cold).active).toBe(true)
  })
})

describe('the /route command', () => {
  async function route(b: Bench, line: string): Promise<string> {
    const execution = await b.ctx.commands.execute(b.agent, line, b.signal)
    expect(execution?.result.kind).toBe('success')
    return execution?.result.kind === 'success' ? execution.result.text ?? '' : ''
  }

  it('reports the mode, usage, and the neutral cancellation text for both reversal shapes', async () => {
    const off = await bench({ config: { ...CONFIG, initialMode: 'off' }, commands: true })
    expect(await route(off, '/route')).toBe('Routing is off.')
    expect(await route(off, '/route status')).toBe('Routing is off.')
    expect(await route(off, '/route sidekick')).toBe('Usage: /route [on|off]')

    openTurn(off.session, 1)
    expect(await route(off, '/route on')).toBe('Enabling model routing (applies from the next step).')
    expect(await route(off, '/route')).toBe('Routing is off. A change applies from the next step.')
    // The reversal lands on the logged state, so the queued change is dropped.
    expect(await route(off, '/route off')).toBe('Model routing change cancelled.')
    expect(await route(off, '/route')).toBe('Routing is off.')
    closeTurn(off.session, 1)
    expect(await route(off, '/route off')).toBe('Model routing is already off.')
    expect(await route(off, '/route on')).toBe('Model routing on.')

    // The mirror: a queued disable cancelled by switching back on.
    const on = await bench({ commands: true })
    openTurn(on.session, 1)
    expect(await route(on, '/route off')).toBe('Disabling model routing (applies from the next step).')
    expect(await route(on, '/route on')).toBe('Model routing change cancelled.')
    closeTurn(on.session, 1)
    expect(await route(on, '/route off')).toBe('Model routing off.')

    // The other place a cancellation happens: between turns, where the parked
    // intent is dropped outright and nothing lands in the log. The text is the
    // same one string, because the completed operation is 'a pending change was
    // dropped' either way.
    const between = await bench({ config: { ...CONFIG, initialMode: 'off' }, commands: true })
    openTurn(between.session, 1)
    expect(await route(between, '/route on')).toBe('Enabling model routing (applies from the next step).')
    closeTurn(between.session, 1)
    expect(await route(between, '/route off')).toBe('Model routing change cancelled.')
    expect(between.session.events.at(-2)).toMatchObject({ type: 'model-routing/mode', data: { active: false } })
    expect(between.ctx.modelRouting.get(between.agent)).toEqual({ active: false })
  })

  it('switches routing on, reports idempotence, and reports a held streak', async () => {
    const b = await bench({ commands: true })
    user(b.session, 'a small change')
    await b.resolve(1)
    expect(await route(b, '/route')).toBe('Routing is on. Holding cheap-provider/cheap-model for turn 1 of at least 5.')

    openTurn(b.session, 3)
    user(b.session, 'another small change')
    // The streak was entered at turn 1, so turn 3 reports turn 3 of the horizon.
    expect(await route(b, '/route')).toBe('Routing is on. Holding cheap-provider/cheap-model for turn 3 of at least 5.')
    expect(await route(b, '/route on')).toBe('Model routing on.')
    expect(await route(b, '/route on')).toBe('Model routing is already on.')
    expect(await route(b, '/route off')).toBe('Disabling model routing (applies from the next step).')
    await agentEvents(b.ctx, b.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 3, step: 1, signal: b.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(await route(b, '/route off')).toBe('Model routing is already off.')
  })
})

describe('the downgrade gate', () => {
  const config: ModelRouterConfig = { ...CONFIG, downgradeThreshold: 0.9, downgradeMargin: 0.25 }

  it('offers keep-current first and describes each candidate route completely', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        candidates: [{
          id: 'cheap',
          provider: CHEAP.provider,
          model: CHEAP.model,
          reasoningEffort: 'low',
          description: 'small familiar changes',
        }],
      },
    })
    const base: ModelSelection = { ...STRONG, reasoningEffort: ReasoningEffortId('medium') }

    expect(await b.resolve(1, base)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
    const route = b.engine.asks[0]?.questions[0]
    if (route?.kind !== 'choice') throw new Error('the route question was not a choice question')
    expect(route.options.map(option => option.option)).toEqual([KEEP_CURRENT_OPTION_ID, 'cheap'])
    expect(route.options[0]?.description).toContain(`${STRONG.provider}/${STRONG.model}`)
    expect(route.options[0]?.description).toContain('reasoning effort medium')
    expect(route.options[1]?.description).toContain(`${CHEAP.provider}/${CHEAP.model}`)
    expect(route.options[1]?.description).toContain('reasoning effort low')
    expect(route.options[1]?.description).toContain('small familiar changes')
  })

  it('lets an explicit keep-current answer win before either gate axis', async () => {
    const b = await bench()
    b.engine.choice = {
      ...PASSING,
      option: KEEP_CURRENT_OPTION_ID,
      confidence: 0,
      probabilities: { [KEEP_CURRENT_OPTION_ID]: 0.01, cheap: 0.99 },
    }

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'current-preferred',
      route: { choice: KEEP_CURRENT_OPTION_ID, confidence: 0 },
      sticky: { active: false, turnsElapsed: 0 },
    })
  })

  it('keeps the manual route for a first hard turn instead of entering a downgrade', async () => {
    const b = await bench({ config: { ...CONFIG, escalateBack: { scoreThreshold: 3 } } })
    b.engine.score = { ...EASY, score: 3 }

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'difficulty-too-high',
      difficulty: { score: 3 },
      sticky: { active: false, turnsElapsed: 0 },
    })
  })

  it('passes at exactly both thresholds', async () => {
    const b = await bench({ config })
    b.engine.choice = { ...PASSING, confidence: 0.9, probabilities: { cheap: 0.75, strong: 0.5 } }
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.decision()).toMatchObject({ outcome: 'downgraded', reason: 'gate-passed' })
  })

  it('keeps the manual route just below the confidence floor', async () => {
    const b = await bench({ config })
    b.engine.choice = { ...PASSING, confidence: 0.8, probabilities: { cheap: 0.75, strong: 0.5 } }
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'low-confidence', route: { confidence: 0.8 } })
  })

  it('keeps the manual route just below the margin floor', async () => {
    const b = await bench({ config })
    b.engine.choice = THIN_MARGIN
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'thin-margin' })
  })

  it('refuses a choice the allowlist does not contain', async () => {
    const b = await bench()
    // Three entries: the second is the runner-up and the third updates neither.
    b.engine.choice = { ...PASSING, option: 'vision', probabilities: { vision: 0.9, cheap: 0.05, other: 0.02 } }
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'unknown-candidate' })
  })

  it('reports candidate-equals-base without asking when every candidate is the manual route', async () => {
    const b = await bench()
    expect(await b.resolve(1, { provider: CHEAP.provider, model: CHEAP.model })).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'candidate-equals-base',
      candidateEligibility: { eligibleCandidates: [], assessments: [{ id: 'cheap', reason: 'equals-base' }] },
    })
  })

  it('treats a same-model candidate at another reasoning effort as the manual route', async () => {
    const b = await bench({
      config: { ...CONFIG, candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' }] },
    })
    // An effort change on the model already in force is no downgrade: on
    // providers that render effort into the cached request it only re-prefills.
    for (const effort of ['low', 'high']) {
      expect(await b.resolve(1, { provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: ReasoningEffortId(effort) }))
        .toBeUndefined()
    }
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decisions().map(decision => decision.reason)).toEqual(['candidate-equals-base'])
  })

  it('route question omits the base-equal candidate', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        candidates: [
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
          { id: 'strong-low', provider: STRONG.provider, model: STRONG.model, reasoningEffort: 'low' },
        ],
      },
    })

    expect(await b.resolve(1)).toEqual(CHEAP)
    const route = b.engine.asks[0]?.questions[0]
    if (route?.kind !== 'choice') throw new Error('the route question was not a choice question')
    expect(route.options.map(option => option.option)).toEqual([KEEP_CURRENT_OPTION_ID, 'cheap'])
    expect(b.decision().candidateEligibility?.assessments.map(assessment => [assessment.id, assessment.reason]))
      .toEqual([['cheap', 'eligible'], ['strong-low', 'equals-base']])
  })

  it('keeps candidate-ineligible when another candidate fails a capability check', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        candidates: [
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
          { id: 'strong-copy', provider: STRONG.provider, model: STRONG.model },
        ],
      },
      capabilities: { [`${CHEAP.provider}/${CHEAP.model}`]: { context: { contextWindow: 1_000 } } },
    })

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'candidate-ineligible' })
    expect(b.decision().candidateEligibility?.assessments.map(assessment => assessment.reason))
      .toEqual(['context-too-small', 'equals-base'])
  })

  it('answers no-candidates without asking the engine', async () => {
    const b = await bench({ config: { ...CONFIG, candidates: [] } })
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'no-candidates' })
  })

  it('lifts the selected route to the configured effort on a hard turn', async () => {
    /** A fresh lift config per bench: a schema resolution may adapt the entry. */
    const liftConfig = (): ModelRouterConfig => ({
      ...CONFIG,
      // Keep the entry threshold above the effort lift so a hard candidate can
      // still be selected and then receive the configured effort.
      escalateBack: { scoreThreshold: 3 },
      difficultyToEffort: { scoreThreshold: 2, reasoningEffort: 'high' },
    })

    // At the threshold and above it, the SELECTED candidate runs at the lift.
    for (const score of [2, 2.5]) {
      const b = await bench({ config: liftConfig() })
      b.engine.score = { ...EASY, score }
      expect(await b.resolve(1)).toEqual({ ...CHEAP, reasoningEffort: 'high' })
      expect(b.decision()).toMatchObject({ selection: { candidateId: 'cheap', reasoningEffort: 'high' } })
      expect(b.decision().sticky.entryBase).toEqual(STRONG)
    }

    // Below the threshold the candidate keeps its own effort (here: none).
    const easy = await bench({ config: liftConfig() })
    easy.engine.score = { ...EASY, score: 1 }
    expect(await easy.resolve(1)).toEqual(CHEAP)
    expect(easy.decision().selection).not.toHaveProperty('reasoningEffort')

    // With no candidate selected there is nothing to lift: the manual route
    // stands, and the hint stays out because no hint threshold is configured.
    const strong = await bench({ config: liftConfig() })
    strong.engine.choice = LOW_CONFIDENCE
    strong.engine.score = { ...EASY, score: 4 }
    expect(await strong.resolve(1)).toBeUndefined()
    expect(strong.decision()).not.toHaveProperty('selection')
    expect(strong.decision()).not.toHaveProperty('hint')
  })

  it('adds the advisory hint to a strong turn above the configured threshold', async () => {
    const hintConfig = { ...CONFIG, escalateBack: { scoreThreshold: 3 }, hardHint: { scoreThreshold: 2 } }
    const b = await bench({ config: hintConfig })
    b.engine.choice = LOW_CONFIDENCE
    b.engine.score = { ...EASY, score: 2.5 }
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'low-confidence', hint: 'consider-stronger', difficulty: { score: 2.5 } })

    // Below the threshold the hint is absent, and it never rides a downgrade.
    const below = await bench({ config: hintConfig })
    below.engine.choice = LOW_CONFIDENCE
    expect(await below.resolve(1)).toBeUndefined()
    expect(below.decision()).not.toHaveProperty('hint')
    const downgraded = await bench({ config: hintConfig })
    downgraded.engine.score = { ...EASY, score: 2.5 }
    expect(await downgraded.resolve(1)).toEqual(CHEAP)
    expect(downgraded.decision()).not.toHaveProperty('hint')
  })
})

describe('engine availability', () => {
  it('keeps the manual route with engine-absent when no engine is composed', async () => {
    const b = await bench({ engine: false })
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'engine-absent' })
    expect(b.decision().engine).toBeUndefined()
  })

  it('keeps the manual route with engine-disabled when the deployment turned judgment off', async () => {
    const b = await bench({ settings: true })
    await b.ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    expect(b.ctx.judgment.settings().enabled).toBe(false)

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'engine-disabled' })
  })

  it('keeps the manual route with engine-unavailable when the engine refuses', async () => {
    const b = await bench()
    b.engine.failure = new Error('the classifier could not be reached')

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'engine-unavailable' })
    expect(b.decision()).not.toHaveProperty('engine')
  })

  it('names invalid-answer for an unusable engine body', async () => {
    const answering = await bench()
    answering.engine.choice = undefined
    expect(await answering.resolve(1)).toBeUndefined()
    expect(answering.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'invalid-answer' })

    const missingDifficulty = await bench()
    missingDifficulty.engine.score = undefined
    expect(await missingDifficulty.resolve(1)).toBeUndefined()
    expect(missingDifficulty.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'invalid-answer' })

    const wrongRouteId = await bench()
    wrongRouteId.engine.choice = { ...PASSING, id: 'not-the-route-question' as typeof ROUTE_QUESTION_ID }
    expect(await wrongRouteId.resolve(1)).toBeUndefined()
    expect(wrongRouteId.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'invalid-answer' })

    const wrongDifficultyId = await bench()
    wrongDifficultyId.engine.score = { ...EASY, id: 'not-the-difficulty-question' as typeof DIFFICULTY_QUESTION_ID }
    expect(await wrongDifficultyId.resolve(1)).toBeUndefined()
    expect(wrongDifficultyId.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'invalid-answer' })

    const rejected = await bench()
    rejected.engine.failure = new JudgmentError('INVALID_ANSWER', 'the engine answered with an unusable body')
    expect(await rejected.resolve(1)).toBeUndefined()
    expect(rejected.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'invalid-answer' })
  })

  it('logs the error outcome under onUnavailable error', async () => {
    const b = await bench({ config: { ...CONFIG, onUnavailable: 'error' } })
    b.engine.failure = new Error('the classifier could not be reached')

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({
      outcome: 'error',
      reason: 'judgment-error',
      sticky: { active: false, turnsElapsed: 0 },
    })

    // With a held streak the error outcome keeps the streak facts it saw.
    const held = await bench({ config: { ...CONFIG, onUnavailable: 'error' } })
    user(held.session, 'a small change')
    await held.resolve(1)
    openTurn(held.session, 2)
    held.engine.failure = new Error('the classifier could not be reached')
    expect(await held.resolve(2)).toBeUndefined()
    expect(held.decision(1)).toMatchObject({
      outcome: 'error',
      reason: 'judgment-error',
      sticky: { active: false, turnsElapsed: 0 },
    })
  })
})

describe('the sticky streak', () => {
  const config: ModelRouterConfig = { ...CONFIG, minTurnsDowngraded: 2 }

  /** Enter a streak at turn 1 and open turn 2. */
  async function entered(options: BenchOptions = {}): Promise<Bench> {
    const b = await bench({ ...options, config: options.config ?? config })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    return b
  }

  it('holds the streak below the horizon and breaks it with gate-failed after it', async () => {
    const b = await entered()
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })

    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decision(2)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'gate-failed',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'gate-failed' },
    })
    expect(stickyState(b.session.events)).toEqual({
      active: false,
      turnsElapsed: 0,
      brokenBy: 'gate-failed',
    })
  })

  it('escalates back at any elapsed count when the difficulty answer is high', async () => {
    const b = await entered({ config: CONFIG })
    b.engine.choice = LOW_CONFIDENCE
    b.engine.score = { ...EASY, score: 4 }

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'escalated',
      difficulty: { score: 4 },
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'escalated' },
    })
  })

  it('breaks a held streak when the judgment explicitly keeps the current model', async () => {
    const b = await entered()
    b.engine.choice = {
      ...PASSING,
      option: KEEP_CURRENT_OPTION_ID,
      confidence: 0,
      probabilities: { [KEEP_CURRENT_OPTION_ID]: 0.01, cheap: 0.99 },
    }
    b.engine.score = { ...EASY, score: 1 }

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'current-preferred',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'current-preferred' },
    })
  })

  it('held streak: an answer naming the base-equal candidate ends the streak as current-preferred', async () => {
    const b = await entered({
      config: {
        ...config,
        candidates: [
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
          { id: 'strong-copy', provider: STRONG.provider, model: STRONG.model },
        ],
      },
    })
    // The question never offered the manual route's own entry. An answer naming
    // it chose the current model, so it must not fail the gate into sticky-hold.
    b.engine.choice = { ...PASSING, option: 'strong-copy', probabilities: { 'strong-copy': 0.9, cheap: 0.05 } }

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'current-preferred',
      route: { choice: 'strong-copy' },
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'current-preferred' },
    })
    expect(stickyState(b.session.events)).toMatchObject({ active: false, brokenBy: 'current-preferred' })
  })

  it('difficultyToEffort applies at entry and is frozen for the streak', async () => {
    const liftConfig = (): ModelRouterConfig => ({
      ...config,
      escalateBack: { scoreThreshold: 3 },
      difficultyToEffort: { scoreThreshold: 2, reasoningEffort: 'high' },
    })

    // Entered on a hard step: a later easy step keeps the lifted effort.
    const lifted = await bench({ config: liftConfig() })
    openTurn(lifted.session, 1)
    user(lifted.session, 'a small change')
    lifted.engine.score = { ...EASY, score: 2 }
    expect(await lifted.resolve(1)).toEqual({ ...CHEAP, reasoningEffort: 'high' })
    closeTurn(lifted.session, 1)
    openTurn(lifted.session, 2)
    lifted.engine.score = { ...EASY, score: 1 }
    expect(await lifted.resolve(2)).toEqual({ ...CHEAP, reasoningEffort: 'high' })
    expect(lifted.decision(1)).toMatchObject({
      reason: 'gate-passed',
      selection: { candidateId: 'cheap', reasoningEffort: 'high' },
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 1 },
    })

    // Entered on an easy step: a later hard step does not lift the streak.
    const plain = await bench({ config: liftConfig() })
    openTurn(plain.session, 1)
    user(plain.session, 'a small change')
    expect(await plain.resolve(1)).toEqual(CHEAP)
    closeTurn(plain.session, 1)
    openTurn(plain.session, 2)
    plain.engine.score = { ...EASY, score: 2.5 }
    expect(await plain.resolve(2)).toEqual(CHEAP)
    expect(plain.decision(1)).toMatchObject({ reason: 'gate-passed', sticky: { turnsElapsed: 1, enteredTurn: 1 } })
    expect(plain.decision(1).selection).not.toHaveProperty('reasoningEffort')
  })

  it('an effort change mid-streak is treated as a candidate change', async () => {
    // With and without a lift: the held effort is reachable under neither.
    for (const difficultyToEffort of [undefined, { scoreThreshold: 2, reasoningEffort: 'high' }]) {
      const b = await bench({
        settings: true,
        config: {
          ...config,
          escalateBack: { scoreThreshold: 3 },
          candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' }],
          ...difficultyToEffort === undefined ? {} : { difficultyToEffort },
        },
      })
      openTurn(b.session, 1)
      user(b.session, 'a small change')
      expect(await b.resolve(1)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
      closeTurn(b.session, 1)
      openTurn(b.session, 2)
      await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'medium' }],
      })

      // Below the horizon the held effort stands, as for any candidate change.
      expect(await b.resolve(2)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
      expect(b.decision(1)).toMatchObject({ reason: 'sticky-hold', sticky: { turnsElapsed: 1, enteredTurn: 1 } })

      // After the horizon the new effort enters as a new streak.
      closeTurn(b.session, 2)
      openTurn(b.session, 3)
      expect(await b.resolve(3)).toEqual({ ...CHEAP, reasoningEffort: 'medium' })
      expect(b.decision(2)).toMatchObject({
        reason: 'gate-passed',
        selection: { candidateId: 'cheap', reasoningEffort: 'medium' },
        sticky: { active: true, turnsElapsed: 0, enteredTurn: 3 },
      })
      expect(stickyState(b.session.events)).toMatchObject({ enteredTurn: 3, candidate: { reasoningEffort: 'medium' } })
    }
  })

  it('holds the entered candidate through the horizon and starts a new streak afterward', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        minTurnsDowngraded: 2,
        candidates: [
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'small familiar changes' },
          { id: 'mid', provider: MID.provider, model: MID.model, description: 'broader changes' },
        ],
      },
    })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    b.engine.choice = { ...PASSING, option: 'mid', probabilities: { mid: 0.9, cheap: 0.05 } }

    // The newly chosen candidate cannot churn an active streak before its horizon.
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })

    // Once the horizon is reached the new candidate may enter, and its own
    // enteredTurn must be what the pure fold uses for the next elapsed count.
    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3)).toEqual(MID)
    expect(b.decision(2)).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: 'mid', provider: MID.provider, model: MID.model },
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 3, entryBase: STRONG },
    })
    expect(stickyState(b.session.events)).toMatchObject({
      active: true,
      turnsElapsed: 0,
      enteredTurn: 3,
      candidate: { candidateId: 'mid', provider: MID.provider, model: MID.model },
    })
  })

  it('does not hold a candidate after settings remove it from the allowlist', async () => {
    const b = await bench({ settings: true, config: { ...CONFIG, minTurnsDowngraded: 2 } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
      candidates: [{ id: 'mid', provider: MID.provider, model: MID.model, description: 'broader changes' }],
    })
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'unknown-candidate',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'unknown-candidate' },
    })
  })

  it('ends the streak as a manual deviation when the manual provider/model moves off the entry base', async () => {
    const b = await entered()
    expect(await b.resolve(2, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'manual-deviation',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'manual-deviation' },
    })
  })

  it('does not end the streak for an unrelated header change', async () => {
    const b = await bench({ config })
    openTurn(b.session, 1)
    // A header before the entering decision, as a live session always logs: the
    // fold derives the entry base from it when the decision records none.
    header(b.session, STRONG.provider, STRONG.model)
    user(b.session, 'a small change')
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: stateHash('a small change'),
      stateSeqs: [1],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, routeErrorLimit: 2, turnsElapsed: 0, enteredTurn: 1 },
    })
    // The plan-mode toggle rewrites only header.system; the consumed route is the
    // one the decision selected, so provider/model are unchanged.
    header(b.session, CHEAP.provider, CHEAP.model, 'plan mode is on')
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)?.reason).toBe('sticky-hold')
    expect(b.decision(1)?.sticky).toMatchObject({ active: true, entryBase: STRONG })
  })

  it('forces the manual route after route errors despite a passing downgrade answer', async () => {
    const b = await bench({ config: { ...config, maxRouteErrors: 2 } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    closeTurn(b.session, 1)

    openTurn(b.session, 2)
    expect(await b.resolve(2)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    routeFailure(b.session, 2)

    openTurn(b.session, 3)
    expect(await b.resolve(3)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    routeFailure(b.session, 3)
    openTurn(b.session, 4)

    expect(stickyState(b.session.events)).toMatchObject({
      active: false,
      turnsElapsed: 0,
      brokenBy: 'route-errors',
      needsStrongTurn: true,
      entryBase: STRONG,
    })

    // The engine would still choose cheap, but the error-limit recovery is a
    // durable strong turn and therefore does not ask it again.
    b.engine.choice = PASSING
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)
    expect(b.decision(3)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'route-errors',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'route-errors', entryBase: STRONG },
    })

    // The same-turn retry reuses the strong decision and does not re-judge.
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)
    expect(b.decisions()).toHaveLength(4)
  })
})

describe('route-error recovery', () => {
  /** Enter a routed candidate, record the consumed candidate header, and open turn two. */
  async function enteredWithHeader(options: BenchOptions = {}): Promise<Bench> {
    const b = await bench({
      ...options,
      config: options.config ?? { ...CONFIG, maxRouteErrors: 2 },
    })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    return b
  }

  /** Consume one candidate turn as a durable route failure. */
  async function failCandidateTurn(b: Bench, turn: number): Promise<void> {
    expect(await b.resolve(turn)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    routeFailure(b.session, turn)
  }

  /** Enter the strong-turn recovery state after two candidate failures. */
  async function atErrorLimit(options: BenchOptions = {}): Promise<Bench> {
    const b = await enteredWithHeader({
      ...options,
      config: options.config ?? { ...CONFIG, maxRouteErrors: 2 },
    })
    await failCandidateTurn(b, 2)
    openTurn(b.session, 3)
    await failCandidateTurn(b, 3)
    openTurn(b.session, 4)
    return b
  }

  it('keeps recovery pending through a same-turn retry and a pre-header interruption', async () => {
    const b = await atErrorLimit()
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)

    // The recovery decision is pinned, but the process has not yet recorded a
    // manual request header. A retry must remain strong and must not judge.
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)
    closeTurn(b.session, 4, { kind: 'interrupted' })
    openTurn(b.session, 5)

    expect(stickyState(b.session.events)).toMatchObject({ needsStrongTurn: true })
    expect(await b.resolve(5)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)
    expect(b.decision(4)).toMatchObject({ reason: 'route-errors', sticky: { active: false } })
  })

  it('preserves recovery after an aborted manual turn', async () => {
    const b = await atErrorLimit()
    expect(await b.resolve(4)).toBeUndefined()
    header(b.session, STRONG.provider, STRONG.model)
    closeTurn(b.session, 4, { kind: 'aborted', reason: { kind: 'user' } })
    openTurn(b.session, 5)

    expect(stickyState(b.session.events)).toMatchObject({ needsStrongTurn: true })
    expect(await b.resolve(5)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)
  })

  it('allows judgment again after a completed manual recovery turn', async () => {
    const b = await atErrorLimit()
    expect(await b.resolve(4)).toBeUndefined()
    header(b.session, STRONG.provider, STRONG.model)
    closeTurn(b.session, 4)
    openTurn(b.session, 5)

    expect(stickyState(b.session.events).needsStrongTurn).toBeUndefined()
    expect(await b.resolve(5)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(4)
    expect(b.decision(4)).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: 'cheap' },
      sticky: { active: true, routeErrorLimit: 2 },
    })
  })

  it('keeps the recorded error limit stable until a later decision records a changed setting', async () => {
    const b = await enteredWithHeader({ settings: true, projections: true })
    expect(b.decision(0)).toMatchObject({ sticky: { active: true, routeErrorLimit: 2 } })
    const before = projectionOf(b.ctx, b.session).sticky

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { maxRouteErrors: 1 })
    expect(projectionOf(b.ctx, b.session).sticky).toEqual(before)
    expect(stickyState(b.session.events)).toMatchObject({ active: true, routeErrorLimit: 2 })

    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({ sticky: { active: true, routeErrorLimit: 1 } })
    expect(stickyState(b.session.events)).toMatchObject({ active: true, routeErrorLimit: 1 })
  })

  it('does not count a later manual failure after an unavailable judgment broke the hold', async () => {
    const b = await bench({ config: { ...CONFIG, maxRouteErrors: 1, onUnavailable: 'error' } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)

    b.engine.failure = new Error('the classifier could not be reached')
    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'error',
      reason: 'judgment-error',
      sticky: { active: false, turnsElapsed: 0 },
    })
    header(b.session, STRONG.provider, STRONG.model)
    routeFailure(b.session, 2)
    openTurn(b.session, 3)

    b.engine.failure = undefined
    expect(await b.resolve(3)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(3)
    expect(b.decision(2)).toMatchObject({ outcome: 'downgraded', reason: 'gate-passed' })
  })

  it('records a fresh strong recovery when the manual route changes during the recovery turn', async () => {
    const b = await atErrorLimit()
    expect(await b.resolve(4)).toBeUndefined()
    expect(await b.resolve(4, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()

    expect(b.engine.asks).toHaveLength(3)
    expect(b.decisions()).toHaveLength(5)
    expect(b.decision(4)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'route-errors',
      sticky: { active: false, entryBase: { provider: 'other-provider', model: 'other-model' } },
    })
  })
})

describe('the reported session selection', () => {
  /**
   * Enter a streak on turn one from `base` and open turn two, so the consumed
   * header carries the candidate while the streak holds.
   * @param base - the manual route turn one runs under.
   * @returns the bench, entered into a held streak.
   */
  async function entered(base: ModelSelection = STRONG): Promise<Bench> {
    const b = await bench({ config: { ...CONFIG, minTurnsDowngraded: 2 } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1, base)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    return b
  }

  it('reports nothing while the state is strong', async () => {
    const b = await bench()
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
    user(b.session, 'a small change')
    b.engine.choice = LOW_CONFIDENCE
    expect(await b.resolve(1)).toBeUndefined()
    // A strong decision rewrites nothing, so the header the turn consumed is
    // already the manual route and there is no rewrite to report over.
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })

  it('reports the manual route a held streak descends beneath', async () => {
    const b = await entered()
    expect(b.decision(0)).toMatchObject({
      outcome: 'downgraded',
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
    })

    expect(b.ctx.modelRouting.stickySelection(b.agent)).toStrictEqual(STRONG)
  })

  it('reports the entry route with the effort the streak was entered on', async () => {
    const base: ModelSelection = { ...STRONG, reasoningEffort: ReasoningEffortId('high') }
    const b = await entered(base)
    expect(b.decision(0)).toMatchObject({ sticky: { entryBase: { ...STRONG, reasoningEffort: 'high' } } })
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toEqual(base)

    // The held turn re-affirms the streak, and the entry base keeps its effort —
    // the consumed header no longer carries the manual one.
    b.engine.choice = LOW_CONFIDENCE
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)?.sticky.entryBase).toEqual({ ...STRONG, reasoningEffort: 'high' })
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toEqual(base)
  })

  /** Enter, serve, and then break a routed streak while retaining its header. */
  async function brokenAfterRoutedHeader(
    headerEffort: ModelSelection['reasoningEffort'],
  ): Promise<{ bench: Bench; base: ModelSelection; candidateEffort: ModelSelection['reasoningEffort'] }> {
    const base: ModelSelection = { ...STRONG, reasoningEffort: ReasoningEffortId('high') }
    const candidateEffort = ReasoningEffortId('low')
    const b = await bench({
      config: {
        ...CONFIG,
        minTurnsDowngraded: 2,
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' }],
      },
    })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1, base)).toEqual({ ...CHEAP, reasoningEffort: candidateEffort })
    header(b.session, CHEAP.provider, CHEAP.model, undefined, headerEffort)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)

    // This decision is after the header and must not replace the decision that
    // actually produced the request header when the process later stops.
    b.engine.choice = LOW_CONFIDENCE
    expect(await b.resolve(2, base)).toEqual({ ...CHEAP, reasoningEffort: candidateEffort })
    routeFailure(b.session, 2)
    routeFailure(b.session, 3)
    expect(stickyState(b.session.events).active).toBe(false)
    return { bench: b, base, candidateEffort }
  }

  it('restores the entry route from the last routed header after a later decision has no header', async () => {
    const candidateEffort = ReasoningEffortId('low')
    const { bench: b, base } = await brokenAfterRoutedHeader(candidateEffort)

    expect(b.ctx.modelRouting.stickySelection(b.agent)).toEqual(base)
  })

  it('rejects header restoration when the routed effort differs from the decision', async () => {
    const { bench: b } = await brokenAfterRoutedHeader(ReasoningEffortId('high'))

    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })

  it('rejects header restoration when the routed decision has an explicit effort but the header omits it', async () => {
    const { bench: b } = await brokenAfterRoutedHeader(undefined)

    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })

  it('restores a candidate with provider-applied default effort', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(
      b.session,
      CHEAP.provider,
      CHEAP.model,
      undefined,
      ReasoningEffortId('high'),
      { reasoningEffort: true },
    )
    closeTurn(b.session, 1)
    openTurn(b.session, 2)

    // The held route has no explicit candidate effort. The header records the
    // provider's effective high effort as a default, so restoration must treat
    // it as absent when comparing the routed selection.
    expect(await b.resolve(2, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toEqual(STRONG)
  })

  it('rejects a same-turn header preceded by a non-downgraded decision', async () => {
    const b = await bench()
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      {
        type: 'model-routing/decision',
        seq: 1,
        time: 1,
        data: {
          outcome: 'kept-strong',
          reason: 'gate-failed',
          stateHash: '00000000',
          stateSeqs: [],
          sticky: { active: false, turnsElapsed: 0 },
        },
      },
      {
        type: 'request/header',
        seq: 2,
        time: 2,
        data: { header: { config: { provider: CHEAP.provider, model: CHEAP.model } }, reason: 'initial' },
      },
    ]

    expect(b.ctx.modelRouting.stickySelection(agentForEvents(events))).toBeUndefined()
  })

  it('rejects a same-turn header preceded by a downgraded decision without a selection', async () => {
    const b = await bench()
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      {
        type: 'model-routing/decision',
        seq: 1,
        time: 1,
        data: {
          outcome: 'downgraded',
          reason: 'gate-passed',
          stateHash: '00000000',
          stateSeqs: [],
          sticky: { active: false, turnsElapsed: 0 },
        },
      },
      {
        type: 'request/header',
        seq: 2,
        time: 2,
        data: { header: { config: { provider: CHEAP.provider, model: CHEAP.model } }, reason: 'initial' },
      },
    ]

    expect(b.ctx.modelRouting.stickySelection(agentForEvents(events))).toBeUndefined()
  })

  it('rejects header restoration when the routed provider or model differs', async () => {
    const b = await bench({ config: { ...CONFIG, minTurnsDowngraded: 2 } })
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      {
        type: 'model-routing/decision',
        seq: 1,
        time: 1,
        data: {
          outcome: 'downgraded',
          reason: 'gate-passed',
          stateHash: '00000000',
          stateSeqs: [],
          selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
          sticky: { active: false, turnsElapsed: 0, entryBase: STRONG },
        },
      },
      {
        type: 'request/header',
        seq: 2,
        time: 2,
        data: { header: { config: { provider: 'other-provider', model: 'other-model' } }, reason: 'initial' },
      },
    ]

    expect(b.ctx.modelRouting.stickySelection(agentForEvents(events))).toBeUndefined()
  })

  it('stops restoring an old routed base after a later manual header', async () => {
    const candidateEffort = ReasoningEffortId('low')
    const { bench: b, base } = await brokenAfterRoutedHeader(candidateEffort)
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toEqual(base)

    openTurn(b.session, 4)
    header(b.session, STRONG.provider, STRONG.model)
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })

  it('reports nothing once the streak ends', async () => {
    const b = await entered()
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toStrictEqual(STRONG)

    b.engine.choice = LOW_CONFIDENCE
    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({ reason: 'gate-failed', sticky: { active: false } })
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })

  it('reports nothing for a replayed streak whose entering decision recorded no base', async () => {
    const b = await bench({ config: { ...CONFIG, minTurnsDowngraded: 2 } })
    // A hand-written decision with no entry base and no preceding header: the
    // fold holds the candidate but can name no manual route to report.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: '00000000',
      stateSeqs: [0],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, routeErrorLimit: 2, turnsElapsed: 0, enteredTurn: 1 },
    })

    expect(stickyState(b.session.events).active).toBe(true)
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })
})

describe('step judgments and request retries', () => {
  it('reuses a step judgment for retries and re-judges the next turn', async () => {
    const b = await bench()
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(1)

    openTurn(b.session, 2)
    user(b.session, 'another small change')
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(2)
    expect(b.decisions()).toHaveLength(2)
  })

  it('escalates on harder steering at the next step and retains the manual route for the turn', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    user(b.session, 'rename the local variable')
    expect(await b.resolve(1)).toEqual(CHEAP)
    const steeringSeq = user(b.session, 'Instead, redesign the transaction isolation across all services.')
    b.engine.score = { ...EASY, score: 4 }

    expect(await b.resolve(1, STRONG, b.signal, 2)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(2)
    expect(b.engine.asks[1]?.state).toContain('redesign the transaction isolation')
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'escalated',
      difficulty: { score: 4 },
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'escalated' },
    })
    expect(b.decision(1).stateSeqs).toContain(steeringSeq)
    b.engine.score = EASY
    expect(await b.resolve(1, STRONG, b.signal, 2)).toBeUndefined()
    expect(await b.resolve(1, STRONG, b.signal, 3)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(2)
    expect(b.decisions()).toHaveLength(2)
  })

  it('judges tool evidence at a new step without advancing the turn-based hold horizon', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    user(b.session, 'inspect the test failure')
    expect(await b.resolve(1)).toEqual(CHEAP)
    const resultSeq = b.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('tests'),
        isError: true,
        content: [{ type: 'text', text: 'The failure is a missing import.' }],
      }),
    }, { surfaceOp: 'append' }).seq
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(1, STRONG, b.signal, 2)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(2)
    expect(b.engine.asks[1]?.state).toContain('The failure is a missing import.')
    expect(b.decision(1)).toMatchObject({
      reason: 'sticky-hold',
      sticky: { active: true, enteredTurn: 1, turnsElapsed: 0 },
    })
    expect(b.decision(1).stateSeqs).toContain(resultSeq)
    expect(await b.resolve(1, STRONG, b.signal, 2)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(2)

    b.engine.choice = { ...PASSING, option: KEEP_CURRENT_OPTION_ID }
    expect(await b.resolve(1, STRONG, b.signal, 3)).toBeUndefined()
    expect(b.decision(2)).toMatchObject({ reason: 'current-preferred', sticky: { active: false } })
  })

  it('retries an interrupted later-step judgment without reusing the earlier downgrade', async () => {
    const b = await bench()
    user(b.session, 'inspect the project')
    expect(await b.resolve(1)).toEqual(CHEAP)
    user(b.session, 'Investigate the distributed deadlock.')
    b.engine.failure = new JudgmentError('ABORTED', 'interrupted step')

    await expect(b.resolve(1, STRONG, b.signal, 2)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(b.decisions()).toHaveLength(1)
    b.engine.failure = undefined
    b.engine.score = { ...EASY, score: 4 }
    expect(await b.resolve(1, STRONG, b.signal, 2)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(3)
    expect(b.decision(1).reason).toBe('escalated')
  })

  it('rejudges a same-step retry after compaction replaces the judgment input', async () => {
    const b = await bench()
    const original = user(b.session, 'inspect the simple failure')
    expect(await b.resolve(1)).toEqual(CHEAP)
    const summarySeq = b.session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Summary: the failure spans transaction boundaries across services.' }],
    }), {
      surfaceOp: { op: 'replace', start: original, end: original },
      sourceEventSeqs: [original],
    }).seq
    b.engine.score = { ...EASY, score: 4 }

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(2)
    expect(b.engine.asks[1]?.state).not.toContain('inspect the simple failure')
    expect(b.decision(1).stateSeqs).toEqual([summarySeq])
    expect(b.decision(1).reason).toBe('escalated')
  })

  it('ends a pinned downgrade when the manual route deviates in the same turn', async () => {
    const b = await bench()
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)

    expect(await b.resolve(1, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(2)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'manual-deviation',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'manual-deviation' },
    })
  })

  it('rechecks a pinned candidate capability before reusing it on a retry', async () => {
    const b = await bench()
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)

    // The provider remains registered, but the exact candidate route no longer
    // has enough context for the manual request. A same-turn retry must keep the
    // manual route instead of reusing a stale downgrade decision.
    b.adapter.setModelInfo(CHEAP.provider, CHEAP.model, { context: { contextWindow: 1 } })
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(2)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'candidate-ineligible',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'candidate-ineligible' },
      candidateEligibility: {
        assessments: [expect.objectContaining({ id: 'cheap', reason: 'context-too-small' })],
      },
    })
  })

  it('records one skip when the mode turns off under a judged turn', async () => {
    const b = await bench()
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    // Between turns, so the off-switch commits immediately.
    expect(b.ctx.modelRouting.set(b.agent, false)).toBe('committed')

    expect(await b.resolve(1)).toBeUndefined()
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(2)
    expect(b.decision(1)).toMatchObject({
      outcome: 'skipped',
      reason: 'mode-off',
      stateHash: b.decision(0).stateHash,
      stateSeqs: b.decision(0).stateSeqs,
      sticky: { active: false, turnsElapsed: 0 },
    })
  })
})

describe('the consult beyond the first judgment', () => {
  it('leaves the manual route pinned for later steps of a turn it kept strong', async () => {
    const b = await bench()
    user(b.session, 'a small change')
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(1)).toBeUndefined()
    expect(await b.resolve(1, STRONG, b.signal, 2)).toBeUndefined()
    expect(await b.resolve(1, STRONG, b.signal, 3)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(1)
  })

  it('asks only the route question when no difficulty question is configured', async () => {
    const b = await bench({
      config: {
        initialMode: 'on',
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model }],
        downgradeThreshold: 0.8,
        downgradeMargin: 0.1,
        routeInstructions: 'Pick the cheapest route that can finish this turn.',
        minTurnsDowngraded: 0,
      },
    })
    user(b.session, 'a small change')

    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.engine.asks[0]?.questions.map(question => question.kind)).toEqual(['choice'])
    expect(b.decision()).not.toHaveProperty('difficulty')
    expect(b.decision()).not.toHaveProperty('hint')
  })

  it('holds a streak whose entering decision recorded no entry base', async () => {
    const b = await bench({ config: { ...CONFIG, minTurnsDowngraded: 2 } })
    // A log whose first turn entered the streak: no preceding header exists, so
    // the fold has no derived base and the consult falls back to the route in
    // force.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: '00000000',
      stateSeqs: [0],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, routeErrorLimit: 2, turnsElapsed: 0, enteredTurn: 1 },
    })
    openTurn(b.session, 2)
    user(b.session, 'a small change')
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      sticky: { active: true, turnsElapsed: 1, entryBase: STRONG },
    })
  })

  it('detects a manual switch on a streak entered on the first turn with no header', async () => {
    const b = await bench()
    // Turn one enters the streak with no request/header anywhere in the log: the
    // decision's own entryBase is the only manual route the fold can compare
    // against, which is why the record exists.
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.decision(0)).toMatchObject({
      outcome: 'downgraded',
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 1, entryBase: STRONG },
    })
    expect(b.session.events.some(event => event.type === 'request/header')).toBe(false)
    expect(stickyState(b.session.events).entryBase).toEqual(STRONG)

    // An unchanged manual route re-affirms the streak rather than ending it.
    openTurn(b.session, 2)
    user(b.session, 'another small change')
    expect(await b.resolve(2, STRONG)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })

    // The same log now sees a manual provider/model switch and ends the streak.
    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.decision(2)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'manual-deviation',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'manual-deviation' },
    })
  })
})

describe('the assembled state', () => {
  it('lists the message seqs it read and keeps the last context turns', async () => {
    const b = await bench()
    user(b.session, 'first')
    user(b.session, 'second')
    user(b.session, 'third')
    user(b.session, 'fourth')

    await b.resolve(1)
    // contextTurns 2 → the current message plus two prior ones.
    expect(b.decision().stateSeqs).toEqual([2, 3, 4])
    const state = JSON.stringify([
      { seq: 2, role: 'user', source: 'user', content: [{ type: 'text', text: 'second' }] },
      { seq: 3, role: 'user', source: 'user', content: [{ type: 'text', text: 'third' }] },
      { seq: 4, role: 'user', source: 'user', content: [{ type: 'text', text: 'fourth' }] },
      { type: 'omitted', count: 1 },
    ])
    expect(b.engine.asks[0]?.state).toBe(state)
    expect(b.decision().stateHash).toBe(stateHash(state))
  })

  it('keeps only the current message with contextTurns 0', async () => {
    const b = await bench({ config: { ...CONFIG, state: { contextTurns: 0 } } })
    user(b.session, 'first')
    user(b.session, 'second')
    await b.resolve(1)
    expect(b.decision().stateSeqs).toEqual([2])
    const state = JSON.stringify([
      { seq: 2, role: 'user', source: 'user', content: [{ type: 'text', text: 'second' }] },
      { type: 'omitted', count: 1 },
    ])
    expect(b.engine.asks[0]?.state).toBe(state)
  })

  it('renders empty and multiple text blocks in their message order', async () => {
    const b = await bench()
    b.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    b.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'head' }, { type: 'text', text: 'tail' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await b.resolve(1)
    expect(b.decision().stateSeqs).toEqual([1, 2])
    expect(b.engine.asks[0]?.state).toBe(JSON.stringify([
      { seq: 1, role: 'user', source: 'user', content: [{ type: 'text', text: '' }] },
      { seq: 2, role: 'user', source: 'user', content: [{ type: 'text', text: 'head' }, { type: 'text', text: 'tail' }] },
    ]))
  })

  it('refuses a current message that cannot fit the complete state budget', async () => {
    const b = await bench({ config: { ...CONFIG, state: { maxChars: 12 } } })
    user(b.session, 'the first long message')
    user(b.session, 'the second long message')

    await b.resolve(1)
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'state-too-large',
      stateHash: stateHash(''),
      stateSeqs: [],
    })
  })
})

describe('the projection unit', () => {
  it('folds the empty log to inactive and not-pending', async () => {
    const b = await bench({ projections: true, config: { ...CONFIG, initialMode: 'off' } })
    expect(projectionOf(b.ctx, b.session)).toEqual({
      active: false,
      pending: false,
      sticky: { active: false, turnsElapsed: 0 },
    })
  })

  it('reports only a requested mode change as pending until an accepted step commits it', async () => {
    const b = await bench({ projections: true, commands: true, config: { ...CONFIG, initialMode: 'off' } })
    await b.ctx.commands.execute(b.agent, '/route', b.signal)
    expect(projectionOf(b.ctx, b.session).pending).toBe(false)
    openTurn(b.session, 1)
    await b.ctx.commands.execute(b.agent, '/route on', b.signal)
    expect(projectionOf(b.ctx, b.session)).toMatchObject({ active: false, pending: true })
    await b.ctx.commands.execute(b.agent, '/route status', b.signal)
    expect(projectionOf(b.ctx, b.session).pending).toBe(true)
    await agentEvents(b.ctx, b.agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: b.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(projectionOf(b.ctx, b.session)).toMatchObject({ active: true, pending: false })
  })

  it('reports the last decision and the sticky streak with its elapsed turns', async () => {
    const b = await bench({ projections: true })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    await b.resolve(1)

    expect(projectionOf(b.ctx, b.session)).toEqual({
      active: true,
      pending: false,
      last: {
        outcome: 'downgraded',
        reason: 'gate-passed',
        confidence: 0.9,
        selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      },
      lastStrong: STRONG,
      sticky: {
        active: true,
        turnsElapsed: 0,
        selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      },
    })

    closeTurn(b.session, 1)
    openTurn(b.session, 3)
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({
      active: true,
      turnsElapsed: 2,
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
    })
  })

  it('clears the projected hold when routing is turned off', async () => {
    const b = await bench({ projections: true })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)

    closeTurn(b.session, 1)
    expect(b.ctx.modelRouting.set(b.agent, false)).toBe('committed')
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({ active: false, turnsElapsed: 0 })
    expect(stickyState(b.session.events)).toMatchObject({
      active: false,
      brokenBy: 'mode-off',
    })
  })

  it('uses the shared fold to clear a projected hold at the route-error horizon', async () => {
    const b = await bench({ projections: true })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)

    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    expect(await b.resolve(2)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    routeFailure(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    routeFailure(b.session, 3)

    const folded = stickyState(b.session.events)
    expect(folded).toMatchObject({ active: false, brokenBy: 'route-errors', needsStrongTurn: true })
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({ active: false, turnsElapsed: 0 })
  })

  it('retains the last streak’s entry base after that streak broke', async () => {
    const b = await bench({ projections: true, config: { ...CONFIG, minTurnsDowngraded: 2 } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(projectionOf(b.ctx, b.session).lastStrong).toEqual(STRONG)

    // A manual switch away from the entry base ends the streak; the route the
    // streak was entered on stays published, because that is the selection a
    // session stuck on the candidate restores.
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    expect(await b.resolve(2, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.decision(1)).toMatchObject({ reason: 'manual-deviation', sticky: { active: false } })
    expect(projectionOf(b.ctx, b.session).lastStrong).toEqual(STRONG)
  })

  it('publishes no retained route for an idle session that never entered a streak', async () => {
    const b = await bench({ projections: true })
    openTurn(b.session, 1)
    user(b.session, 'a small change')

    // The session already runs the allowlisted candidate, so the gate refuses it
    // as no downgrade and no streak ever recorded a route to restore.
    expect(await b.resolve(1, { provider: CHEAP.provider, model: CHEAP.model })).toBeUndefined()
    expect(b.decision(0)).toMatchObject({ reason: 'candidate-equals-base', sticky: { active: false } })
    expect(projectionOf(b.ctx, b.session).lastStrong).toBeUndefined()
  })

  it('ignores another command record and a route record with no input', async () => {
    const b = await bench({ projections: true, config: { ...CONFIG, initialMode: 'off' } })
    b.session.append('command/run', { commandId: CommandId('other-1'), name: 'compact', args: '', source: { kind: 'user' } })
    expect(projectionOf(b.ctx, b.session).pending).toBe(false)
    b.session.append('command/run', { commandId: CommandId('route-no-input'), name: 'route', source: { kind: 'user' } })
    expect(projectionOf(b.ctx, b.session).pending).toBe(false)

    b.session.append('command/run', { commandId: CommandId('route-1'), name: 'route', args: ' on', source: { kind: 'user' } })
    expect(projectionOf(b.ctx, b.session)).toMatchObject({ active: false, pending: true })
  })

  it('renders the selection, route, hint, and sticky fields a decision carries', async () => {
    const b = await bench({ projections: true, config: { ...CONFIG, initialMode: 'off' } })
    openTurn(b.session, 4)

    // A decision naming an effort with no recorded entry turn: the streak starts
    // at the open turn, and the view carries the effort and the route confidence.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: '00000000',
      stateSeqs: [0],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: ReasoningEffortId('low') },
      route: { choice: 'cheap', confidence: 0.9, probabilities: { cheap: 0.9 } },
      sticky: { active: true, routeErrorLimit: 2, turnsElapsed: 0 },
    })
    expect(projectionOf(b.ctx, b.session)).toMatchObject({
      active: false,
      pending: false,
      last: {
        outcome: 'downgraded',
        reason: 'gate-passed',
        confidence: 0.9,
        selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' },
      },
      sticky: {
        active: true,
        turnsElapsed: 0,
        selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' },
      },
    })

    // A strong turn carrying only the advisory hint: nothing to select.
    b.session.append('model-routing/decision', {
      outcome: 'kept-strong',
      reason: 'low-confidence',
      stateHash: '00000000',
      stateSeqs: [0],
      hint: 'consider-stronger',
      sticky: { active: false, turnsElapsed: 0 },
    })
    const hinted = projectionOf(b.ctx, b.session)
    expect(hinted.last).toEqual({
      outcome: 'kept-strong',
      reason: 'low-confidence',
      hint: 'consider-stronger',
    })
    expect(hinted.sticky).toEqual({ active: false, turnsElapsed: 0 })

    // A held streak whose decision named no selection: the sticky view carries none.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'sticky-hold',
      stateHash: '00000000',
      stateSeqs: [0],
      sticky: { active: true, routeErrorLimit: 2, turnsElapsed: 1, enteredTurn: 4 },
    })
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({ active: true, turnsElapsed: 0 })
  })
})

describe('configuration at plugin load', () => {
  it('loads the documented composition and resolves every default', async () => {
    const b = await bench()
    const config = b.ctx.modelRouting.config()
    expect(config).toMatchObject({
      initialMode: 'on',
      minTurnsDowngraded: 5,
      escalateBackScoreThreshold: 3,
      maxRouteErrors: 2,
      onUnavailable: 'fallback',
      tier: 'fast',
      state: { contextTurns: 2, maxChars: 12_000, maxFitCandidates: 8 },
    })
    expect(config.difficultyLevels).toHaveLength(5)
    // The optional sub-objects the entry never wrote stay absent.
    expect(config.difficultyToEffort).toBeUndefined()
    expect(config.hardHintScoreThreshold).toBeUndefined()
  })

  it('refuses a programmatically constructed configuration the schema never saw', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The schema normalizes a composition entry before the plugin starts;
    // programmatic construction bypasses it, so resolveConfig re-judges.
    await expect(ctx.plugin((inner: Context) => {
      void new ModelRoutingController(inner, { ...CONFIG, routeInstructions: '' })
    })).rejects.toThrow(/ModelRouterConfig.routeInstructions must be a non-empty string/)
  })

  it('refuses an incomplete effort lift at load, naming the missing field', async () => {
    // Both fields of the lift are deliberate operating points, so an incomplete
    // group refuses the load instead of being defaulted like escalateBack.
    const missingThreshold = new Context()
    await missingThreshold.plugin(SessionStore)
    await expect(missingThreshold.plugin(ModelRoutingController, {
      ...CONFIG,
      difficultyToEffort: { reasoningEffort: 'high' },
    } as unknown as ModelRouterConfig)).rejects.toThrow('ModelRouterConfig.difficultyToEffort.scoreThreshold must be a number from 0 through 4')
    expect(missingThreshold.get('modelRouting')).toBeUndefined()

    const missingEffort = new Context()
    await missingEffort.plugin(SessionStore)
    await expect(missingEffort.plugin(ModelRoutingController, {
      ...CONFIG,
      difficultyToEffort: { scoreThreshold: 4 },
    } as unknown as ModelRouterConfig)).rejects.toThrow('ModelRouterConfig.difficultyToEffort.reasoningEffort must be a non-empty string')
    expect(missingEffort.get('modelRouting')).toBeUndefined()
  })

  it('refuses a row that omits a required field before the constructor runs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The static Config is what Cordis validates ahead of the constructor, so an
    // omitted required field fails at plugin load with the schema's own issue
    // instead of reaching resolveConfig.
    await expect(ctx.plugin(ModelRoutingController, {
      candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model }],
      downgradeThreshold: 0.8,
      downgradeMargin: 0.1,
      routeInstructions: 'Pick the cheapest route that can finish this turn.',
      difficultyInstructions: 'Rate how much reasoning this turn needs.',
    } as unknown as ModelRouterConfig)).rejects.toThrow(/\$\.initialMode missing required value/)
    expect(ctx.get('modelRouting')).toBeUndefined()
  })

  it('refuses an unknown key by name and a missing required field', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(ModelRoutingController, { ...CONFIG, bogusKey: 1 } as unknown as ModelRouterConfig))
      .rejects.toThrow(/ModelRouterConfig: unknown key "bogusKey"/)

    const missing = new Context()
    await missing.plugin(SessionStore)
    await expect(missing.plugin(ModelRoutingController, { ...CONFIG, routeInstructions: '' }))
      .rejects.toThrow(/ModelRouterConfig.routeInstructions must be a non-empty string/)
  })
})

describe('HMR disposal', () => {
  it('withdraws the service, its command, and its projection with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    const fiber = await ctx.plugin(ModelRoutingController, CONFIG)
    const session = ctx.sessions.create()
    const agent = agentFor(session, ctx)
    expect(ctx.get('modelRouting')).toBeInstanceOf(ModelRoutingController)
    expect(ctx.commands.find(agent, 'route')).toBeDefined()
    expect(projectionOf(ctx, session)).toBeDefined()

    await fiber.dispose()

    expect(ctx.get('modelRouting')).toBeUndefined()
    expect(ctx.commands.find(agent, 'route')).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(session).values.modelRouting).toBeUndefined()
  })
})

describe('capability exits and cancellation', () => {
  it('breaks a same-turn pin when settings remove its candidate', async () => {
    const b = await bench({ settings: true })
    expect(await b.resolve(1)).toEqual(CHEAP)

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
      candidates: [{ id: 'mid', provider: MID.provider, model: MID.model, description: 'broader changes' }],
    })

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(2)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'unknown-candidate',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'unknown-candidate' },
    })
  })

  it('breaks a same-turn pin when the LLM runtime disappears', async () => {
    const b = await bench()
    expect(await b.resolve(1)).toEqual(CHEAP)
    await b.llmFiber?.dispose()

    expect(b.ctx.get('llm')).toBeUndefined()
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'candidate-ineligible',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'candidate-ineligible' },
    })
  })

  it('revalidates a held route with its selected reasoning effort', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' }],
      },
    })

    expect(await b.resolve(1)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
    expect(await b.resolve(1)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(1)
  })

  it('keeps the manual route when the initial LLM runtime is absent', async () => {
    const b = await bench({ llm: false })

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'model-unavailable' })
  })

  it('keeps the manual route when every initial candidate is ineligible', async () => {
    const b = await bench({
      capabilities: { [`${CHEAP.provider}/${CHEAP.model}`]: { context: { contextWindow: 1 } } },
    })

    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'candidate-ineligible',
      candidateEligibility: {
        eligibleCandidates: [],
        assessments: [expect.objectContaining({ id: 'cheap', reason: 'context-too-small' })],
      },
    })
  })

  it('breaks a held streak when its candidate becomes ineligible on a later turn', async () => {
    const b = await bench({ config: { ...CONFIG, minTurnsDowngraded: 2 } })
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    b.adapter.setModelInfo(CHEAP.provider, CHEAP.model, { context: { contextWindow: 1 } })

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'candidate-ineligible',
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'candidate-ineligible' },
      candidateEligibility: {
        eligibleCandidates: [],
        assessments: [expect.objectContaining({ id: 'cheap', reason: 'context-too-small' })],
      },
    })
  })

  it('does not log or pin an ABORTED judgment, then can judge again', async () => {
    const b = await bench()
    let started!: () => void
    const askStarted = new Promise<void>((resolve) => { started = resolve })
    let rejectAsk!: (error: unknown) => void
    const pendingAsk = new Promise<JudgmentResult>((_resolve, reject) => { rejectAsk = reject })
    b.engine.askOverride = async () => {
      started()
      return pendingAsk
    }

    const pending = b.resolve(1)
    await askStarted
    rejectAsk(new JudgmentError('ABORTED', 'the judgment was cancelled'))
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(b.decisions()).toHaveLength(0)
    expect(b.session.events.some(event => event.type === 'model-routing/decision')).toBe(false)

    b.engine.askOverride = undefined
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.decisions()).toHaveLength(1)
  })

  it('rejects a judgment that resolves after its signal aborts without logging or pinning', async () => {
    const b = await bench()
    const controller = new AbortController()
    let started!: () => void
    const askStarted = new Promise<void>((resolve) => { started = resolve })
    let resolveAsk!: (result: JudgmentResult) => void
    const pendingAsk = new Promise<JudgmentResult>((resolve) => { resolveAsk = resolve })
    b.engine.askOverride = async () => {
      started()
      return pendingAsk
    }

    const pending = b.resolve(1, STRONG, controller.signal)
    await askStarted
    controller.abort()
    resolveAsk({ answers: [PASSING, EASY], engine: 'late-judgment', model: 'late-1', latencyMs: 1 })
    await expect(pending).rejects.toBeDefined()
    expect(b.decisions()).toHaveLength(0)
    expect(b.session.events.some(event => event.type === 'model-routing/decision')).toBe(false)

    b.engine.askOverride = undefined
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.decisions()).toHaveLength(1)
  })
})


const FIT_LIMITS: JudgmentTokenLimits = {
  maxSequenceTokens: 1024, maxHeadTokens: 256, maxBatchTokens: 4096,
  manifestSha256: 'a'.repeat(64),
}

describe('atomic judgment input fitting', () => {
  it('keeps the manual route on a serialized input limit even under the error policy', async () => {
    const b = await bench({ config: { ...CONFIG, onUnavailable: 'error' } })
    user(b.session, 'task')
    b.engine.failure = new JudgmentError('INPUT_TOO_LARGE', 'complete serialized request exceeds the body limit')
    expect(await b.resolve()).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'judgment-input-too-large' })
  })

  it('logs the selected complete state, redaction, token counts, and omitted evidence', async () => {
    const b = await bench()
    const old = user(b.session, 'earlier task')
    const current = user(b.session, 'continue with private-name')
    b.engine.fitting = {
      ask: async (input) => {
        expect(input.states.length).toBe(2)
        expect(input.states[0]).toContain('earlier task')
        const selectedIndex = input.states.length - 1
        const state = input.states[selectedIndex]!.replace('private-name', '[redacted]')
        const result = await b.engine.ask({ ...input, state })
        return {
          kind: 'answered', result,
          fit: { selectedIndex, state, stateTokens: 35, sequenceTokens: [100, 120], paddedTokens: 240, limits: FIT_LIMITS },
        }
      },
    }
    await b.resolve()
    const decision = b.decision()
    expect(decision.outcome).toBe('downgraded')
    expect(decision.stateSeqs).toEqual([current])
    expect(decision.stateProjection?.omittedSeqs).toEqual([old])
    expect(decision.judgmentInput?.state).toContain('continue with [redacted]')
    expect(decision.judgmentInput?.state).not.toContain('earlier task')
    expect(decision.stateHash).toBe(stateHash(decision.judgmentInput!.state))
    expect(decision.judgmentInput?.limits).toEqual(FIT_LIMITS)
    expect(decision.judgmentInput?.paddedTokens).toBe(240)
    expect(await b.resolve()).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(1)
  })

  it.each(['state', 'head', 'option', 'batch'] as const)('keeps the manual model when the %s budget prevents inference', async (reason) => {
    const b = await bench({ config: { ...CONFIG, onUnavailable: 'error' } })
    user(b.session, 'keep this entire request')
    b.engine.fitting = { ask: async () => ({ kind: 'unfit', engine: 'shield', model: 'pinned', limits: FIT_LIMITS, reason }) }
    expect(await b.resolve()).toBeUndefined()
    expect(b.engine.asks).toEqual([])
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong', reason: 'judgment-input-too-large', engine: 'shield', model: 'pinned',
      judgmentRejection: { limits: FIT_LIMITS, reason }, sticky: { active: false },
    })
  })

  it('discards a fitted result arriving after cancellation and permits a fresh retry', async () => {
    const b = await bench()
    user(b.session, 'task')
    const cancellation = new AbortController()
    b.engine.fitting = { ask: async () => {
      cancellation.abort()
      return { kind: 'unfit', engine: 'shield', model: 'pinned', limits: FIT_LIMITS, reason: 'state' }
    } }
    await expect(b.resolve(1, STRONG, cancellation.signal)).rejects.toThrow()
    expect(b.decisions()).toEqual([])
    delete b.engine.fitting
    expect(await b.resolve()).toEqual(CHEAP)
    expect(b.decisions()).toHaveLength(1)
  })
})
