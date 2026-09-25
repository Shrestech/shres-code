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

import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import AgentRegistry, { agentEvents, modelSelectionInstalled, provideModelSelection } from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection, RequestErrorAction } from '@shres-code/shres-code-agent'
import CommandRuntime from '@shres-code/shres-code-commands'
import JudgmentService, {
  JUDGMENT_SETTINGS_NAMESPACE,
  JudgmentEngineRegistry,
  JudgmentError,
  judgmentEngineId,
  registerJudgmentEngine,
} from '@shres-code/shres-code-judgment'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import type {
  JudgmentAnswer,
  JudgmentChoiceAnswer,
  JudgmentConsumerId,
  JudgmentEngineCalibration,
  JudgmentEngineId,
  JudgmentEngineStatus,
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
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@shres-code/shres-code-llm'
import type {
  GenerateOptions,
  LlmCallConfigAdapterDefaults,
  LlmFailure,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import { CommandId } from '@shres-code/shres-code-commands/brand'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import ModelRoutingController, {
  DIFFICULTY_QUESTION_ID,
  KEEP_CURRENT_OPTION_ID,
  MODEL_ROUTER_JUDGMENT_CONSUMER,
  MODEL_ROUTER_SETTINGS_NAMESPACE,
  ROUTE_QUESTION_ID,
  stateHash,
} from '../src/index.ts'
import { judgmentFailuresFor, stickyState } from '../src/folds.ts'
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
  routeFrom: [{ provider: STRONG.provider, model: STRONG.model, objective: 'dollars' }],
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
  /** Fields a dispatcher and a metered engine add to every answer. */
  stamp: Pick<JudgmentResult, 'engineId' | 'usage'> = {}
  /** Registry id this service reports as selected, as a dispatcher does. */
  selected: JudgmentEngineId | undefined
  /** Fitting reported only for the router's consumer id. */
  fittingForConsumer: JudgmentFittingEngine | undefined

  override selectedEngine(): JudgmentEngineId | undefined {
    return this.selected
  }

  override fittingFor(consumer?: JudgmentConsumerId): JudgmentFittingEngine | undefined {
    if (this.fittingForConsumer !== undefined && consumer === MODEL_ROUTER_JUDGMENT_CONSUMER) return this.fittingForConsumer
    return this.fitting
  }

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
    return Promise.resolve({ answers, engine: 'scripted-judgment', model: 'scripted-1', latencyMs: 3, ...this.stamp })
  }
}

/** TEST DOUBLE: a registry engine that answers PASSING and EASY, with a status the test sets. */
interface RegisteredEngine {
  readonly asks: JudgmentInput[]
  setStatus(status: JudgmentEngineStatus): void
}

/**
 * Register one scripted engine with `ctx.judgmentEngines`.
 * @param ctx - context carrying the dispatcher's registry.
 * @param id - registry id.
 * @param status - initial status.
 * @returns the engine's asks and its status control.
 */
async function registeredEngine(
  ctx: Context,
  id: string,
  status: JudgmentEngineStatus,
  calibration: JudgmentEngineCalibration = 'calibrated',
  choice: JudgmentChoiceAnswer = PASSING,
): Promise<RegisteredEngine> {
  const asks: JudgmentInput[] = []
  let current = status
  let announce: () => void = () => undefined
  await ctx.plugin({
    name: `engine-${id}`,
    inject: ['judgmentEngines'],
    apply: (inner: Context) => {
      const engine = {
        ask: (input: JudgmentInput): Promise<JudgmentResult> => {
          asks.push(input)
          return Promise.resolve({ answers: [choice, EASY], engine: id, model: `${id}-1`, latencyMs: 2 })
        },
      }
      announce = registerJudgmentEngine(inner, {
        engine,
        descriptor: { id: judgmentEngineId(id), label: id, egress: 'none', calibration, supportsFitting: false },
        status: () => current,
      })
    },
  })
  return {
    asks,
    setStatus: (next) => {
      current = next
      announce()
    },
  }
}

/** TEST DOUBLE: the Loader's settle point, which the test releases or fails. */
class SettleGate extends Service {
  readonly settle = Promise.withResolvers<undefined>()

  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  async await(): Promise<void> {
    await this.settle.promise
  }
}

/** A scripted service over a registry of named engines, and the engine a test restarts. */
interface Mismatched {
  readonly b: Bench
  readonly warm: RegisteredEngine
}

/** Provide a bare engine registry, so a scripted `ctx.judgment` can name registered engines. */
async function engineRegistry(ctx: Context): Promise<void> {
  await ctx.plugin({
    name: 'engine-registry',
    apply: (inner: Context) => { inner.provide('judgmentEngines', new JudgmentEngineRegistry(() => undefined)) },
  })
}

/**
 * Mount a {@link SettleGate} as `ctx.loader`.
 * @param ctx - the bench context.
 * @returns the mounted gate.
 */
async function settleGate(ctx: Context): Promise<SettleGate> {
  let gate: SettleGate | undefined
  await ctx.plugin({ name: 'settle-gate', apply: (inner: Context) => { gate = new SettleGate(inner) } })
  if (gate === undefined) throw new Error('the settle gate did not mount')
  return gate
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

  /** Action run once, inside the next capability read. */
  duringAssessment: (() => Promise<void>) | undefined

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const action = this.duringAssessment
    this.duringAssessment = undefined
    if (action !== undefined) await action()
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
  /** The router's own plugin fiber, for disposal cases. */
  routerFiber: { dispose(): Promise<void> }
  /** One consult for a turn, against the strong manual route by default. */
  resolve(turn?: number, base?: ModelSelection, signal?: AbortSignal, step?: number): Promise<ModelSelection | undefined>
  decisions(): ModelRoutingDecision[]
  decision(index?: number): ModelRoutingDecision
  /** Whether the latest ask's signal has aborted. */
  asksSignalAborted(): boolean
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
  const routerFiber = await ctx.plugin(ModelRoutingController, config)
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
    routerFiber,
    resolve: (turn = 1, base = STRONG, requestSignal = signal, step = 1) =>
      ctx.modelRouting.resolveRequest(agent, turn, step, base, requestSignal, {
        config: base,
        content: { messages: session.deriveMessages(), system: '', tools: [] },
      }),
    decisions,
    asksSignalAborted: () => (ctx.judgment as ScriptedJudgment).asks.at(-1)?.signal?.aborted === true,
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

/** One model step's opening event, which a held streak counts toward its horizon and cap. */
function startStep(session: Session, turn: number, step = 1): void {
  session.append('step/start', { turn, step })
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
    // The ask runs under the turn's signal combined with the judgment deadline.
    const askSignal = b.engine.asks[0]?.signal
    expect(askSignal).toBeInstanceOf(AbortSignal)
    expect(askSignal).not.toBe(b.signal)
    expect(askSignal?.aborted).toBe(false)
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

describe('adoption', () => {
  it('adopts only root agents: a delegated child gets no routing mode and is never routed', async () => {
    const b = await bench()
    const error = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => b.ctx.logger)
    // A fork child is seeded with its parent's log, routing mode included, and a
    // front end may still give it a model-selection hook.
    const childSession = b.ctx.sessions.create(SessionId('delegated-child'), {
      seed: b.session.events.filter(event => event.type === 'model-routing/configuration').map(event => ({ ...event })),
      meta: { delegationDepth: 1 },
    })
    const child = agentFor(childSession, b.ctx)
    provideModelSelection(child, { current: undefined, assembled: undefined })
    b.ctx.agents.register(child)
    expect(modelSelectionInstalled(child)).toBe(true)
    expect(childSession.events.filter(event => event.type === 'model-routing/configuration').map(event => event.data))
      .toEqual([{ active: true }])
    expect(error).not.toHaveBeenCalled()
    // A child with a hook and no seeded mode is not adopted, so it gets no mode.
    const freshSession = b.ctx.sessions.create(SessionId('delegated-fresh'), { meta: { delegationDepth: 2 } })
    const fresh = agentFor(freshSession, b.ctx)
    provideModelSelection(fresh, { current: undefined, assembled: undefined })
    b.ctx.agents.register(fresh)
    expect(freshSession.events.filter(event => event.type === 'model-routing/configuration')).toEqual([])
    expect(await b.ctx.modelRouting.resolveRequest(child, 1, 1, STRONG, b.signal, {
      config: STRONG,
      content: { messages: [], system: '', tools: [] },
    })).toBeUndefined()
    expect(childSession.events.filter(event => event.type === 'model-routing/decision')).toEqual([])
    expect(b.engine.asks).toEqual([])
    // The root agent the bench registered was adopted, with its hook.
    expect(modelSelectionInstalled(b.agent)).toBe(true)
    expect(b.session.events.some(event => event.type === 'model-routing/configuration')).toBe(true)
  })

  it('adopts an unreachable root once a front end gives it the hook, through /route or the consult', async () => {
    const b = await bench({ commands: true })
    vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => b.ctx.logger)
    const announce = b.ctx.emit.bind(b.ctx) as unknown as (name: string, payload: unknown) => void

    // Through the command: a later provider installs the hook, and /route adopts.
    const viaCommand = agentFor(b.ctx.sessions.create(), b.ctx)
    announce('agent/created', { agent: viaCommand })
    provideModelSelection(viaCommand, { current: undefined, assembled: undefined })
    const status = await b.ctx.commands.execute(viaCommand, '/route', b.signal)
    expect(status?.result).toEqual({ kind: 'success', text: 'Routing is on.' })
    expect(viaCommand.session.events.filter(event => event.type === 'model-routing/configuration').map(event => event.data))
      .toEqual([{ active: true }])

    // Through the consult: the hook's first request adopts the agent and routes it.
    const viaConsult = agentFor(b.ctx.sessions.create(), b.ctx)
    announce('agent/created', { agent: viaConsult })
    provideModelSelection(viaConsult, { current: undefined, assembled: undefined })
    user(viaConsult.session, 'a small change')
    const routed = await b.ctx.modelRouting.resolveRequest(viaConsult, 1, 1, STRONG, b.signal, {
      config: STRONG,
      content: { messages: viaConsult.session.deriveMessages(), system: '', tools: [] },
    })
    expect(routed).toEqual(CHEAP)
    expect(viaConsult.session.events.filter(event => event.type === 'model-routing/decision')).toHaveLength(1)
  })

  it('adopts a user fork, which records a parent session but no delegation depth', async () => {
    const b = await bench()
    const forkSession = b.ctx.sessions.create(SessionId('user-fork'), { meta: { parentSession: b.session.id } })
    const fork = agentFor(forkSession, b.ctx)
    b.ctx.agents.register(fork)
    expect(modelSelectionInstalled(fork)).toBe(true)
    expect(forkSession.events.filter(event => event.type === 'model-routing/configuration').map(event => event.data))
      .toEqual([{ active: true }])
  })

  it('reports a root agent without a model-selection hook once, records no mode for it, and says so on /route', async () => {
    const b = await bench({ commands: true })
    const error = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => b.ctx.logger)
    const session = b.ctx.sessions.create()
    const unhooked = agentFor(session, b.ctx)
    // A registry that did not install the hook announces the agent anyway.
    const announce = b.ctx.emit.bind(b.ctx) as unknown as (name: string, payload: unknown) => void
    announce('agent/created', { agent: unhooked })
    announce('agent/created', { agent: unhooked })
    const reports = error.mock.calls.filter(call => String(call[0]).startsWith('model-router: agent'))
    expect(reports.map(call => String(call[1]))).toEqual([String(unhooked.id)])
    expect(session.events.filter(event => event.type === 'model-routing/configuration')).toEqual([])
    for (const line of ['/route', '/route status', '/route on']) {
      const execution = await b.ctx.commands.execute(unhooked, line, b.signal)
      expect(execution?.result).toEqual({ kind: 'success', text: 'Routing can\'t run for this agent: it has no model-selection hook.' })
    }
    expect(session.events.filter(event => event.type === 'model-routing/configuration')).toEqual([])
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
    expect(await route(b, '/route')).toBe('Routing is on. Holding cheap-provider/cheap-model for step 1 of at least 20 and at most 40.')

    openTurn(b.session, 3)
    startStep(b.session, 3, 1)
    startStep(b.session, 3, 2)
    user(b.session, 'another small change')
    // Two steps have started since the entering step, so this is step 3 of the streak.
    expect(await route(b, '/route')).toBe('Routing is on. Holding cheap-provider/cheap-model for step 3 of at least 20 and at most 40.')
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
      sticky: { active: false, stepsElapsed: 0 },
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
      sticky: { active: false, stepsElapsed: 0 },
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

  it('keeps strong without asking from a budget-thinking base', async () => {
    const b = await bench({ capabilities: { [`${STRONG.provider}/${STRONG.model}`]: { thinkingMode: 'budget' } } })
    // The base resolves its low default effort, which enables budget thinking.
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'thinking-mode-incompatible',
      candidateEligibility: { eligibleCandidates: [], assessments: [{ id: 'cheap', reason: 'thinking-mode-incompatible' }] },
      sticky: { active: false },
    })

    // A held streak whose base turns budget-thinking ends as candidate-ineligible.
    const held = await bench({ settings: true })
    openTurn(held.session, 1)
    user(held.session, 'a small change')
    expect(await held.resolve(1)).toEqual(CHEAP)
    closeTurn(held.session, 1)
    openTurn(held.session, 2)
    startStep(held.session, 2)
    held.adapter.setModelInfo(STRONG.provider, STRONG.model, { thinkingMode: 'budget' })
    expect(await held.resolve(2)).toBeUndefined()
    expect(held.decision(1)).toMatchObject({ reason: 'candidate-ineligible', sticky: { brokenBy: 'candidate-ineligible' } })
  })

  it('reports candidate-equals-base without asking when every candidate is the manual route', async () => {
    // The pool model is also listed as a strong route, so routing starts from it.
    const b = await bench({ config: { ...CONFIG, routeFrom: [...CONFIG.routeFrom ?? [], { provider: CHEAP.provider, model: CHEAP.model, objective: 'dollars' }] } })
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
      config: {
        ...CONFIG,
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low', description: 'a test candidate' }],
        routeFrom: [{ provider: CHEAP.provider, model: CHEAP.model, objective: 'dollars' }],
      },
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
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a test candidate' },
          { id: 'strong-low', provider: STRONG.provider, model: STRONG.model, reasoningEffort: 'low', description: 'a test candidate' },
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
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a test candidate' },
          { id: 'strong-copy', provider: STRONG.provider, model: STRONG.model, description: 'a test candidate' },
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
      // Keep the entry ceiling above the effort lift so a hard candidate can
      // still be selected and then receive the configured effort.
      escalateBack: { scoreThreshold: 3 },
      difficulty: { entryScoreCeiling: 3 },
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
    const hintConfig = {
      ...CONFIG, escalateBack: { scoreThreshold: 3 }, difficulty: { entryScoreCeiling: 3 }, hardHint: { scoreThreshold: 2 },
    }
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
      sticky: { active: false, stepsElapsed: 0 },
    })

    // With a held streak and no hold tolerance the error outcome ends the streak.
    const held = await bench({ config: { ...CONFIG, onUnavailable: 'error', judgmentFailures: { holdTolerance: 0 } } })
    user(held.session, 'a small change')
    await held.resolve(1)
    openTurn(held.session, 2)
    held.engine.failure = new Error('the classifier could not be reached')
    expect(await held.resolve(2)).toBeUndefined()
    expect(held.decision(1)).toMatchObject({
      outcome: 'error',
      reason: 'judgment-error',
      sticky: { active: false, stepsElapsed: 0 },
    })
  })
})

describe('judgment failures', () => {
  /** An ask that settles only when its signal aborts, as a real engine's fetch does. */
  function hangs(input: JudgmentInput): Promise<JudgmentResult> {
    return new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => {
        reject(new JudgmentError('ABORTED', 'the judgment was cancelled'))
      }, { once: true })
    })
  }

  /** Enter a streak at turn 1, then open `turn` with one step started. */
  async function heldInto(config: ModelRouterConfig, turn = 2): Promise<Bench> {
    const b = await bench({ config })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, turn)
    startStep(b.session, turn)
    return b
  }

  /** Close `turn` and open the next one with a started step. */
  function nextTurn(b: Bench, turn: number): void {
    closeTurn(b.session, turn - 1)
    openTurn(b.session, turn)
    startStep(b.session, turn)
  }

  it('deadline expiry records engine-unavailable DEADLINE and keeps the turn', async () => {
    const b = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 20 } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    b.engine.askOverride = hangs
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'engine-unavailable',
      engineFailure: { code: 'DEADLINE' },
      sticky: { active: false },
    })
    expect(b.asksSignalAborted()).toBe(true)

    // An answer that arrives after the deadline, from an engine that ignored
    // the signal, is not used.
    const late = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 10 } })
    late.engine.askOverride = () => new Promise((resolve) => {
      setTimeout(() => {
        resolve({ answers: [PASSING, EASY], engine: 'scripted-judgment', model: 'scripted-1', latencyMs: 40 })
      }, 40)
    })
    expect(await late.resolve(1)).toBeUndefined()
    expect(late.decision()).toMatchObject({ reason: 'engine-unavailable', engineFailure: { code: 'DEADLINE' } })
    expect(late.decision()).not.toHaveProperty('route')
  })

  it('classifies a late coded failure by its code, not as the deadline', async () => {
    const lateReject = (error: JudgmentError) => (): Promise<JudgmentResult> => new Promise((_resolve, reject) => {
      setTimeout(() => { reject(error) }, 40)
    })
    const tooLarge = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 10 } })
    tooLarge.engine.askOverride = lateReject(new JudgmentError('INPUT_TOO_LARGE', 'late body-limit rejection'))
    expect(await tooLarge.resolve(1)).toBeUndefined()
    expect(tooLarge.decision()).toMatchObject({ reason: 'judgment-input-too-large', latencyMs: expect.any(Number) as unknown })
    expect(tooLarge.decision()).not.toHaveProperty('engineFailure')

    const unavailable = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 10 } })
    unavailable.engine.askOverride = lateReject(new JudgmentError('UNAVAILABLE', 'late refusal'))
    expect(await unavailable.resolve(1)).toBeUndefined()
    expect(unavailable.decision()).toMatchObject({ reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' } })

    const invalid = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 10 } })
    invalid.engine.askOverride = lateReject(new JudgmentError('INVALID_ANSWER', 'late garbage'))
    expect(await invalid.resolve(1)).toBeUndefined()
    expect(invalid.decision()).toMatchObject({ reason: 'invalid-answer', engineFailure: { code: 'INVALID_ANSWER' } })

    // An uncoded failure after the deadline is the deadline.
    const uncoded = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 10 } })
    uncoded.engine.askOverride = () => new Promise((_resolve, reject) => {
      setTimeout(() => { reject(new Error('socket closed')) }, 40)
    })
    expect(await uncoded.resolve(1)).toBeUndefined()
    expect(uncoded.decision()).toMatchObject({ reason: 'engine-unavailable', engineFailure: { code: 'DEADLINE' } })
  })

  it('records the routed engine and the router-measured latency of a failed call', async () => {
    const stamped = await bench()
    stamped.engine.failure = new JudgmentError('UNAVAILABLE', 'laya is restarting', { engineId: judgmentEngineId('laya') })
    expect(await stamped.resolve(1)).toBeUndefined()
    expect(stamped.decision()).toMatchObject({
      reason: 'engine-unavailable',
      engineId: 'laya',
      latencyMs: expect.any(Number) as unknown,
      engineFailure: { code: 'UNAVAILABLE' },
    })
    expect(stamped.decision()).not.toHaveProperty('engine')

    // An unstamped failure is attributed to the engine selected before the ask.
    const selected = await bench()
    selected.engine.selected = judgmentEngineId('typesafe')
    selected.engine.failure = new Error('socket hang up')
    expect(await selected.resolve(1)).toBeUndefined()
    expect(selected.decision()).toMatchObject({ engineId: 'typesafe', latencyMs: expect.any(Number) as unknown })

    // A single-engine service selects nothing, so an unstamped failure names none.
    const single = await bench()
    single.engine.failure = new JudgmentError('UNAVAILABLE', 'down')
    expect(await single.resolve(1)).toBeUndefined()
    expect(single.decision()).not.toHaveProperty('engineId')
  })

  it('records the engine, usage, and timing facts of an answered call and names the router on every ask', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    const text = 'a small change'
    user(b.session, text)
    b.engine.stamp = { engineId: judgmentEngineId('laya'), usage: { inputTokens: 900, outputTokens: 5, cacheReadTokens: 0 } }
    expect(await b.resolve(1)).toEqual(CHEAP)
    const decision = b.decision()
    expect(b.engine.asks[0]?.consumer).toBe(MODEL_ROUTER_JUDGMENT_CONSUMER)
    expect(decision).toMatchObject({
      engine: 'scripted-judgment',
      model: 'scripted-1',
      latencyMs: 3,
      engineId: 'laya',
      judgeUsage: { inputTokens: 900, outputTokens: 5, cacheReadTokens: 0 },
      eligibilityMs: expect.any(Number) as unknown,
      inputChars: b.engine.asks[0]?.state.length,
    })
    expect(decision.inputChars).toBeGreaterThan(text.length)

    // A late answer is not used, but its call is recorded.
    const late = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 10 } })
    late.engine.askOverride = () => new Promise((resolve) => {
      setTimeout(() => {
        resolve({ answers: [PASSING, EASY], engine: 'scripted-judgment', model: 'scripted-1', latencyMs: 40, engineId: judgmentEngineId('laya'), usage: { inputTokens: 1, outputTokens: 1 } })
      }, 40)
    })
    expect(await late.resolve(1)).toBeUndefined()
    expect(late.decision()).toMatchObject({
      reason: 'engine-unavailable', engineFailure: { code: 'DEADLINE' },
      engine: 'scripted-judgment', latencyMs: 40, engineId: 'laya', judgeUsage: { inputTokens: 1, outputTokens: 1 },
    })
    expect(late.decision()).not.toHaveProperty('route')
  })

  it('declares the router consumer id to the judgment registry', async () => {
    const ctx = new Context()
    await ctx.plugin(JudgmentDispatch, { defaultEngine: 'none' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    expect(ctx.judgmentEngines.hasConsumer(MODEL_ROUTER_JUDGMENT_CONSUMER)).toBe(false)
    const fiber = await ctx.plugin(ModelRoutingController, CONFIG)
    expect(ctx.judgmentEngines.hasConsumer(MODEL_ROUTER_JUDGMENT_CONSUMER)).toBe(true)
    await fiber.dispose()
    expect(ctx.judgmentEngines.hasConsumer(MODEL_ROUTER_JUDGMENT_CONSUMER)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('records the engine code of a classified failure and none for an unclassified one', async () => {
    const classified = await bench()
    classified.engine.failure = new JudgmentError('UNAVAILABLE', 'the classifier could not be reached')
    expect(await classified.resolve(1)).toBeUndefined()
    expect(classified.decision()).toMatchObject({ reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' } })

    const plain = await bench()
    plain.engine.failure = new Error('socket hang up')
    expect(await plain.resolve(1)).toBeUndefined()
    expect(plain.decision()).toMatchObject({ reason: 'engine-unavailable' })
    expect(plain.decision()).not.toHaveProperty('engineFailure')
  })

  it('turn abort during the ask still propagates', async () => {
    const b = await bench({ config: { ...CONFIG, judgmentDeadlineMs: 30_000 } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    const asking = Promise.withResolvers<undefined>()
    b.engine.askOverride = (input) => {
      asking.resolve(undefined)
      return hangs(input)
    }
    const turn = new AbortController()
    const pending = b.resolve(1, STRONG, turn.signal)
    await asking.promise
    turn.abort(new Error('the user cancelled the turn'))
    await expect(pending).rejects.toThrow('the user cancelled the turn')
    expect(b.decisions()).toHaveLength(0)
  })

  it('held streak survives holdTolerance failures', async () => {
    const config: ModelRouterConfig = { ...CONFIG, hold: { minSteps: 1 } }
    const b = await heldInto(config)
    b.engine.failure = new JudgmentError('UNAVAILABLE', 'the classifier could not be reached')
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'judgment-failure-held',
      selection: { candidateId: 'cheap' },
      engineFailure: { code: 'UNAVAILABLE' },
      sticky: { active: true, stepsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })
    // A missing answer is a failure too; it records no engine code.
    b.engine.failure = undefined
    b.engine.choice = undefined
    nextTurn(b, 3)
    expect(await b.resolve(3)).toEqual(CHEAP)
    expect(b.decision(2)).toMatchObject({ reason: 'judgment-failure-held' })
    expect(b.decision(2)).not.toHaveProperty('engineFailure')
    expect(stickyState(b.session.events)).toMatchObject({ active: true, judgmentFailures: { count: 2, turn: 3 } })

    // The third consecutive failure ends the streak.
    nextTurn(b, 4)
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.decision(3)).toMatchObject({ outcome: 'kept-strong', reason: 'invalid-answer', sticky: { active: false } })

    // An answered call clears the count, so a later streak survives a failure again.
    const answered = await heldInto(config)
    answered.engine.failure = new Error('socket hang up')
    expect(await answered.resolve(2)).toEqual(CHEAP)
    answered.engine.failure = undefined
    nextTurn(answered, 3)
    expect(await answered.resolve(3)).toEqual(CHEAP)
    expect(answered.decision(2)).toMatchObject({ reason: 'gate-passed' })
    expect(stickyState(answered.session.events)).not.toHaveProperty('judgmentFailures')
    answered.engine.failure = new Error('socket hang up')
    nextTurn(answered, 4)
    expect(await answered.resolve(4)).toEqual(CHEAP)
    expect(answered.decision(3)).toMatchObject({ reason: 'judgment-failure-held' })

    // Under the error policy a held failure within tolerance still holds.
    const strict = await heldInto({ ...config, onUnavailable: 'error' })
    strict.engine.failure = new Error('socket hang up')
    expect(await strict.resolve(2)).toEqual(CHEAP)
    expect(strict.decision(1)).toMatchObject({ outcome: 'downgraded', reason: 'judgment-failure-held' })
  })

  it('breaker opens after breakerThreshold and closes after breakerOpenTurns', async () => {
    const b = await bench({
      config: { ...CONFIG, judgmentFailures: { holdTolerance: 0, breakerThreshold: 2, breakerOpenTurns: 2 } },
    })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    b.engine.failure = new JudgmentError('UNAVAILABLE', 'the classifier could not be reached')
    expect(await b.resolve(1)).toBeUndefined()
    nextTurn(b, 2)
    expect(await b.resolve(2)).toBeUndefined()
    const asked = b.engine.asks.length
    expect(asked).toBe(2)

    for (const turn of [3, 4]) {
      nextTurn(b, turn)
      expect(await b.resolve(turn)).toBeUndefined()
      expect(b.decisions().at(-1)).toMatchObject({ outcome: 'kept-strong', reason: 'breaker-open' })
      expect(b.decisions().at(-1)).not.toHaveProperty('engineFailure')
    }
    expect(b.engine.asks).toHaveLength(asked)

    // After the window one call is tried; its failure opens the breaker again.
    nextTurn(b, 5)
    expect(await b.resolve(5)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(asked + 1)
    nextTurn(b, 6)
    expect(await b.resolve(6)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'breaker-open' })

    // An answered call closes it.
    b.engine.failure = undefined
    nextTurn(b, 8)
    expect(await b.resolve(8)).toEqual(CHEAP)
    expect(stickyState(b.session.events)).not.toHaveProperty('judgmentFailures')

    // breakerOpenTurns 0 disables the breaker.
    const off = await bench({ config: { ...CONFIG, judgmentFailures: { breakerThreshold: 1, breakerOpenTurns: 0 } } })
    off.engine.failure = new Error('socket hang up')
    expect(await off.resolve(1)).toBeUndefined()
    openTurn(off.session, 2)
    expect(await off.resolve(2)).toBeUndefined()
    expect(off.engine.asks).toHaveLength(2)
    expect(off.decision(1)).toMatchObject({ reason: 'engine-unavailable' })
  })

  it('counts failures per engine: a switch resets the breaker and the hold tolerance', async () => {
    const b = await bench({
      config: { ...CONFIG, judgmentFailures: { holdTolerance: 0, breakerThreshold: 2, breakerOpenTurns: 5 } },
    })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    b.engine.selected = judgmentEngineId('laya')
    b.engine.failure = new JudgmentError('UNAVAILABLE', 'laya gateway exited')
    expect(await b.resolve(1)).toBeUndefined()
    nextTurn(b, 2)
    expect(await b.resolve(2)).toBeUndefined()
    expect(stickyState(b.session.events).judgmentFailures).toEqual({ count: 2, turn: 2, engineId: 'laya' })
    nextTurn(b, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'breaker-open', engineId: 'laya' })

    // Another engine is not held to the first one's failures.
    b.engine.selected = judgmentEngineId('typesafe')
    nextTurn(b, 4)
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'engine-unavailable', engineId: 'typesafe' })
    expect(stickyState(b.session.events).judgmentFailures).toEqual({ count: 1, turn: 4, engineId: 'typesafe' })
    b.engine.failure = undefined
    nextTurn(b, 5)
    expect(await b.resolve(5)).toEqual(CHEAP)

    // A held streak's tolerance restarts on a switch too.
    const held = await heldInto({ ...CONFIG, hold: { minSteps: 1 }, judgmentFailures: { holdTolerance: 1 } })
    held.engine.selected = judgmentEngineId('laya')
    held.engine.failure = new Error('socket hang up')
    expect(await held.resolve(2)).toEqual(CHEAP)
    expect(held.decision(1)).toMatchObject({ reason: 'judgment-failure-held', engineId: 'laya' })
    held.engine.selected = judgmentEngineId('typesafe')
    nextTurn(held, 3)
    expect(await held.resolve(3)).toEqual(CHEAP)
    expect(held.decision(2)).toMatchObject({ reason: 'judgment-failure-held', engineId: 'typesafe' })
    nextTurn(held, 4)
    expect(await held.resolve(4)).toBeUndefined()
    expect(held.decision(3)).toMatchObject({ reason: 'engine-unavailable', sticky: { active: false } })
  })

  it('holds a breaker opened by a count without an engine id against the next selected engine', async () => {
    // A single-engine service selects nothing, so its failures carry no engine id,
    // as every count logged before per-engine counting does.
    const b = await bench({ config: { ...CONFIG, judgmentFailures: { holdTolerance: 0, breakerThreshold: 2, breakerOpenTurns: 5 } } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    b.engine.failure = new JudgmentError('UNAVAILABLE', 'down')
    expect(await b.resolve(1)).toBeUndefined()
    nextTurn(b, 2)
    expect(await b.resolve(2)).toBeUndefined()
    expect(stickyState(b.session.events).judgmentFailures).toEqual({ count: 2, turn: 2 })

    // The first engine selected afterwards is held off until the window closes.
    b.engine.failure = undefined
    b.engine.selected = judgmentEngineId('laya')
    nextTurn(b, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'breaker-open', engineId: 'laya' })
    expect(b.engine.asks).toHaveLength(2)
    nextTurn(b, 8)
    expect(await b.resolve(8)).toEqual(CHEAP)
    expect(stickyState(b.session.events)).not.toHaveProperty('judgmentFailures')
  })

  it('keeps counting a pre-engine-id failure against any engine', () => {
    const failures = { count: 2, turn: 3 }
    expect(judgmentFailuresFor(failures, 'laya')).toBe(failures)
    expect(judgmentFailuresFor({ ...failures, engineId: 'laya' }, undefined)).toEqual({ ...failures, engineId: 'laya' })
    expect(judgmentFailuresFor({ ...failures, engineId: 'laya' }, 'typesafe')).toBeUndefined()
    expect(judgmentFailuresFor(undefined, 'laya')).toBeUndefined()
  })

  it('does not count a starting or not-installed engine as a failure and makes no call', async () => {
    const b = await bench({
      engine: false,
      config: { ...CONFIG, hold: { minSteps: 1 }, judgmentFailures: { holdTolerance: 0, breakerThreshold: 1, breakerOpenTurns: 5 } },
    })
    await b.ctx.plugin(JudgmentDispatch, { defaultEngine: 'laya' })
    const laya = await registeredEngine(b.ctx, 'laya', { state: 'starting' })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    for (const turn of [1, 2, 3]) {
      if (turn > 1) nextTurn(b, turn)
      expect(await b.resolve(turn)).toBeUndefined()
      expect(b.decisions().at(-1)).toMatchObject({
        outcome: 'kept-strong',
        reason: 'engine-unavailable',
        engineId: 'laya',
        engineFailure: { code: 'UNAVAILABLE', engineState: 'starting' },
      })
      expect(b.decisions().at(-1)).not.toHaveProperty('latencyMs')
    }
    laya.setStatus({ state: 'not-installed', detail: 'run /laya install' })
    nextTurn(b, 4)
    expect(await b.resolve(4)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ engineFailure: { engineState: 'not-installed' } })
    expect(laya.asks).toHaveLength(0)
    expect(stickyState(b.session.events)).not.toHaveProperty('judgmentFailures')

    // Once ready, the first consult asks; the warm-up opened no breaker.
    laya.setStatus({ state: 'ready' })
    nextTurn(b, 5)
    expect(await b.resolve(5)).toEqual(CHEAP)
    expect(laya.asks).toHaveLength(1)
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'gate-passed', engineId: 'laya' })

    // A restart while a streak holds keeps the candidate without spending the tolerance.
    laya.setStatus({ state: 'starting' })
    for (const turn of [6, 7]) {
      nextTurn(b, turn)
      expect(await b.resolve(turn)).toEqual(CHEAP)
      expect(b.decisions().at(-1)).toMatchObject({ reason: 'judgment-failure-held', engineFailure: { engineState: 'starting' } })
    }
    expect(stickyState(b.session.events)).toMatchObject({ active: true })
    expect(stickyState(b.session.events)).not.toHaveProperty('judgmentFailures')

    // An engine that is registered but failing still counts.
    laya.setStatus({ state: 'unavailable', detail: 'gateway exited 1' })
    nextTurn(b, 8)
    expect(await b.resolve(8)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' } })
    expect(b.decisions().at(-1)?.engineFailure).not.toHaveProperty('engineState')
    expect(stickyState(b.session.events).judgmentFailures).toMatchObject({ count: 1, engineId: 'laya' })
  })

  it('refuses a verbalized engine without an accepting operating point and asks it with one', async () => {
    const refused = await bench({ engine: false })
    await refused.ctx.plugin(JudgmentDispatch, { defaultEngine: 'llm:ollama/qwen3:8b' })
    const judge = await registeredEngine(refused.ctx, 'llm:ollama/qwen3:8b', { state: 'ready' }, 'verbalized')
    expect(await refused.resolve(1)).toBeUndefined()
    expect(refused.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'engine-uncalibrated', engineId: 'llm:ollama/qwen3:8b' })
    expect(refused.decision()).not.toHaveProperty('candidateEligibility')
    expect(judge.asks).toHaveLength(0)

    // A point that does not accept verbalized answers refuses too.
    const unaccepted = await bench({
      engine: false,
      config: { ...CONFIG, operatingPoints: [{ engine: 'llm:ollama/qwen3:8b', downgradeThreshold: 0.9, downgradeMargin: 0.2 }] },
    })
    await unaccepted.ctx.plugin(JudgmentDispatch, { defaultEngine: 'llm:ollama/qwen3:8b' })
    await registeredEngine(unaccepted.ctx, 'llm:ollama/qwen3:8b', { state: 'ready' }, 'verbalized')
    expect(await unaccepted.resolve(1)).toBeUndefined()
    expect(unaccepted.decision()).toMatchObject({ reason: 'engine-uncalibrated' })

    const accepted = await bench({
      engine: false,
      config: {
        ...CONFIG,
        operatingPoints: [{ engine: 'llm:ollama/qwen3:8b', downgradeThreshold: 0.85, downgradeMargin: 0.2, acceptVerbalized: true }],
      },
    })
    await accepted.ctx.plugin(JudgmentDispatch, { defaultEngine: 'llm:ollama/qwen3:8b' })
    const acceptedJudge = await registeredEngine(accepted.ctx, 'llm:ollama/qwen3:8b', { state: 'ready' }, 'verbalized')
    expect(await accepted.resolve(1)).toEqual(CHEAP)
    expect(acceptedJudge.asks).toHaveLength(1)
    expect(accepted.decision()).toMatchObject({
      reason: 'gate-passed',
      thresholds: { downgradeThreshold: 0.85, downgradeMargin: 0.2, source: 'operating-point' },
    })
    expect(accepted.decision().thresholds).not.toHaveProperty('calibratedBy')
  })

  it('gates a calibrated engine with its operating point, else the global defaults marked uncalibrated', async () => {
    // Confidence 0.75 fails the global 0.8 floor and passes a calibrated 0.7 point.
    const borderline = { ...PASSING, confidence: 0.75 }
    const pointed = await bench({
      engine: false,
      config: {
        ...CONFIG,
        operatingPoints: [
          { engine: 'laya', downgradeThreshold: 0.7, downgradeMargin: 0.1, calibratedBy: 'prereg-2026-10-routing-v1' },
          { engine: 'typesafe', downgradeThreshold: 0.95, downgradeMargin: 0.3 },
        ],
      },
    })
    await pointed.ctx.plugin(JudgmentDispatch, { defaultEngine: 'laya' })
    await registeredEngine(pointed.ctx, 'laya', { state: 'ready' }, 'calibrated', borderline)
    expect(await pointed.resolve(1)).toEqual(CHEAP)
    // Every threshold in force is recorded, in one fixed key order.
    expect(Object.entries(pointed.decision().thresholds!)).toEqual([
      ['downgradeThreshold', 0.7],
      ['downgradeMargin', 0.1],
      ['entryScoreCeiling', 2],
      ['escalateBackScoreThreshold', 3],
      ['source', 'operating-point'],
      ['calibratedBy', 'prereg-2026-10-routing-v1'],
    ])
    expect(pointed.decision().reason).toBe('gate-passed')

    // Laya without a point uses the global defaults, uncalibrated, and is not fail-closed.
    const global = await bench({ engine: false })
    await global.ctx.plugin(JudgmentDispatch, { defaultEngine: 'laya' })
    await registeredEngine(global.ctx, 'laya', { state: 'ready' }, 'calibrated', borderline)
    expect(await global.resolve(1)).toBeUndefined()
    expect(global.decision()).toMatchObject({
      reason: 'low-confidence',
      thresholds: { downgradeThreshold: 0.8, downgradeMargin: 0.1, source: 'global' },
    })
    expect(global.decision().thresholds).not.toHaveProperty('calibratedBy')

    // A single-engine service selects no engine, so no point applies.
    const single = await bench({ config: { ...CONFIG, operatingPoints: [{ engine: 'laya', downgradeThreshold: 0.99, downgradeMargin: 0.9 }] } })
    expect(await single.resolve(1)).toEqual(CHEAP)
    expect(single.decision()).toMatchObject({ thresholds: { source: 'global' } })

    // Without the difficulty question no difficulty threshold is in force.
    const { difficultyInstructions: _omitted, ...routeOnly } = CONFIG
    const plain = await bench({ config: { ...routeOnly, hold: { minSteps: 0 } } })
    expect(await plain.resolve(1)).toEqual(CHEAP)
    expect(plain.decision().thresholds).toEqual({ downgradeThreshold: 0.8, downgradeMargin: 0.1, source: 'global' })

    // The difficulty thresholds come from the configuration in force at the consult.
    const tuned = await bench({ config: { ...CONFIG, difficulty: { entryScoreCeiling: 3 }, escalateBack: { scoreThreshold: 4 } } })
    expect(await tuned.resolve(1)).toEqual(CHEAP)
    expect(tuned.decision().thresholds).toMatchObject({ entryScoreCeiling: 3, escalateBackScoreThreshold: 4 })
  })

  it('reports an operating point for an unregistered engine once after the settle, and when it resolves', async () => {
    const b = await bench({
      engine: false,
      settings: true,
      config: {
        ...CONFIG,
        operatingPoints: [
          { engine: 'laya', downgradeThreshold: 0.7, downgradeMargin: 0.1 },
          { engine: 'layya', downgradeThreshold: 0.7, downgradeMargin: 0.1 },
        ],
      },
    })
    const error = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => b.ctx.logger)
    const info = vi.spyOn(b.ctx.logger, 'info').mockImplementation(() => b.ctx.logger)
    const gate = await settleGate(b.ctx)
    await b.ctx.plugin(JudgmentDispatch, { defaultEngine: 'laya' })
    await registeredEngine(b.ctx, 'laya', { state: 'ready' })
    const reports = (): string[] => error.mock.calls
      .filter(call => String(call[0]).startsWith('model-router: operatingPoints'))
      .map(call => String(call[1]))
    expect(reports()).toEqual([])

    gate.settle.resolve(undefined)
    await new Promise(resolve => setImmediate(resolve))
    expect(reports()).toEqual(['layya'])
    await registeredEngine(b.ctx, 'other', { state: 'ready' })
    expect(reports()).toEqual(['layya'])

    await registeredEngine(b.ctx, 'layya', { state: 'ready' })
    expect(info.mock.calls.map(call => String(call[1]))).toContain('layya')

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
      operatingPoints: [{ engine: 'gone', downgradeThreshold: 0.7, downgradeMargin: 0.1 }],
    })
    expect(reports()).toEqual(['layya', 'gone'])
    const infos = info.mock.calls.length
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { operatingPoints: [] })
    // A report the configuration no longer names is forgotten without a resolution log.
    expect(info.mock.calls.length).toBe(infos)
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
      operatingPoints: [{ engine: 'gone', downgradeThreshold: 0.7, downgradeMargin: 0.1 }],
    })
    expect(reports()).toEqual(['layya', 'gone', 'gone'])
    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: 'off' })
    expect(reports()).toEqual(['layya', 'gone', 'gone'])
  })

  it('reports nothing when the settle fails or the router leaves before it', async () => {
    for (const outcome of ['reject', 'dispose'] as const) {
      const b = await bench({
        engine: false,
        config: { ...CONFIG, operatingPoints: [{ engine: 'layya', downgradeThreshold: 0.7, downgradeMargin: 0.1 }] },
      })
      const error = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => b.ctx.logger)
      const gate = await settleGate(b.ctx)
      await b.ctx.plugin(JudgmentDispatch, { defaultEngine: 'laya' })
      if (outcome === 'reject') gate.settle.reject(new Error('a fiber failed to load'))
      else {
        await b.routerFiber.dispose()
        gate.settle.resolve(undefined)
      }
      await new Promise(resolve => setImmediate(resolve))
      expect(error.mock.calls.filter(call => String(call[0]).startsWith('model-router: operatingPoints'))).toEqual([])
    }
  })

  it('re-reads the judgment service and its engine immediately before the ask', async () => {
    // The service leaves while candidates are assessed.
    const absent = await bench({ engine: false })
    const fiber = await absent.ctx.plugin(ScriptedJudgment)
    absent.adapter.duringAssessment = () => fiber.dispose().then(() => undefined)
    expect(await absent.resolve(1)).toBeUndefined()
    expect(absent.decision()).toMatchObject({ reason: 'engine-absent' })

    // The deployment switch turns judgment off while candidates are assessed.
    const disabled = await bench({ settings: true })
    disabled.adapter.duringAssessment = () => disabled.ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    expect(await disabled.resolve(1)).toBeUndefined()
    expect(disabled.decision()).toMatchObject({ reason: 'engine-disabled' })
    expect(disabled.engine.asks).toHaveLength(0)

    // A switch to an engine whose breaker is open is not asked.
    const b = await bench({ config: { ...CONFIG, judgmentFailures: { holdTolerance: 0, breakerThreshold: 2, breakerOpenTurns: 5 } } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    b.engine.selected = judgmentEngineId('laya')
    b.engine.failure = new JudgmentError('UNAVAILABLE', 'laya gateway exited')
    expect(await b.resolve(1)).toBeUndefined()
    nextTurn(b, 2)
    expect(await b.resolve(2)).toBeUndefined()
    b.engine.failure = undefined
    b.engine.selected = judgmentEngineId('typesafe')
    b.adapter.duringAssessment = () => {
      b.engine.selected = judgmentEngineId('laya')
      return Promise.resolve()
    }
    nextTurn(b, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'breaker-open', engineId: 'laya' })
    expect(b.engine.asks).toHaveLength(2)
  })
  it('judges an answer or a failure against the engine that produced it', async () => {
    const mismatched = async (config: ModelRouterConfig = CONFIG): Promise<Mismatched> => {
      const b = await bench({ config })
      await engineRegistry(b.ctx)
      await registeredEngine(b.ctx, 'cal', { state: 'ready' })
      await registeredEngine(b.ctx, 'verb', { state: 'ready' }, 'verbalized')
      await registeredEngine(b.ctx, 'pt', { state: 'ready' })
      const warm = await registeredEngine(b.ctx, 'warm', { state: 'ready' })
      b.engine.selected = judgmentEngineId('cal')
      return { b, warm }
    }

    // An answer from a refused engine is recorded and discarded.
    const refused = (await mismatched()).b
    refused.engine.stamp = { engineId: judgmentEngineId('verb'), usage: { inputTokens: 10, outputTokens: 2 } }
    expect(await refused.resolve(1)).toBeUndefined()
    expect(refused.engine.asks).toHaveLength(1)
    expect(refused.decision()).toMatchObject({
      outcome: 'kept-strong',
      reason: 'engine-uncalibrated',
      engineId: 'verb',
      engine: 'scripted-judgment',
      latencyMs: 3,
      judgeUsage: { inputTokens: 10, outputTokens: 2 },
    })
    expect(refused.decision()).not.toHaveProperty('route')
    expect(refused.decision()).not.toHaveProperty('thresholds')

    // An answer from another engine is gated by that engine's operating point.
    const pointed = (await mismatched({
      ...CONFIG,
      operatingPoints: [{ engine: 'pt', downgradeThreshold: 0.95, downgradeMargin: 0.1, calibratedBy: 'prereg-1' }],
    })).b
    pointed.engine.stamp = { engineId: judgmentEngineId('pt') }
    expect(await pointed.resolve(1)).toBeUndefined()
    expect(pointed.decision()).toMatchObject({
      reason: 'low-confidence',
      engineId: 'pt',
      thresholds: { downgradeThreshold: 0.95, source: 'operating-point', calibratedBy: 'prereg-1' },
    })

    // A failure stamped with an engine that is warming up is not counted.
    const stampedWarm = await mismatched()
    stampedWarm.warm.setStatus({ state: 'starting' })
    stampedWarm.b.engine.failure = new JudgmentError('UNAVAILABLE', 'warm is starting', { engineId: judgmentEngineId('warm') })
    expect(await stampedWarm.b.resolve(1)).toBeUndefined()
    expect(stampedWarm.b.decision()).toMatchObject({
      reason: 'engine-unavailable',
      engineId: 'warm',
      engineFailure: { code: 'UNAVAILABLE', engineState: 'starting' },
    })
    expect(stickyState(stampedWarm.b.session.events)).not.toHaveProperty('judgmentFailures')

    // An engine that starts restarting during the ask has not failed.
    const restarting = await mismatched()
    restarting.b.engine.selected = judgmentEngineId('warm')
    restarting.b.engine.askOverride = () => {
      restarting.warm.setStatus({ state: 'starting' })
      return Promise.reject(new JudgmentError('UNAVAILABLE', 'the gateway closed the connection'))
    }
    expect(await restarting.b.resolve(1)).toBeUndefined()
    expect(restarting.b.decision()).toMatchObject({
      engineId: 'warm',
      engineFailure: { code: 'UNAVAILABLE', engineState: 'starting' },
    })
    expect(stickyState(restarting.b.session.events)).not.toHaveProperty('judgmentFailures')

    // The same holds for a restart that outlives the deadline.
    const late = await mismatched({ ...CONFIG, judgmentDeadlineMs: 10 })
    late.b.engine.selected = judgmentEngineId('warm')
    late.b.engine.askOverride = (input) => {
      late.warm.setStatus({ state: 'starting' })
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => { reject(new JudgmentError('ABORTED', 'cancelled')) }, { once: true })
      })
    }
    expect(await late.b.resolve(1)).toBeUndefined()
    expect(late.b.decision()).toMatchObject({ engineFailure: { code: 'DEADLINE', engineState: 'starting' } })
  })
  it('keeps state-too-large and judgment-input-too-large as immediate strong exits of a held streak', async () => {
    const b = await heldInto({ ...CONFIG, hold: { minSteps: 1 } })
    b.engine.failure = new JudgmentError('INPUT_TOO_LARGE', 'complete serialized request exceeds the body limit')
    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({ outcome: 'kept-strong', reason: 'judgment-input-too-large', sticky: { active: false } })
    expect(stickyState(b.session.events)).not.toHaveProperty('judgmentFailures')
  })
})

describe('the sticky streak', () => {
  const config: ModelRouterConfig = { ...CONFIG, hold: { minSteps: 2 } }

  /** Enter a streak at turn 1 and open turn 2. */
  async function entered(options: BenchOptions = {}): Promise<Bench> {
    const b = await bench({ ...options, config: options.config ?? config })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    startStep(b.session, 2)
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
      sticky: { active: true, stepsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })

    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    startStep(b.session, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decision(2)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'gate-failed',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed' },
    })
    expect(stickyState(b.session.events)).toEqual({
      active: false,
      stepsElapsed: 0,
      brokenBy: 'gate-failed',
    })
  })

  it('difficulty in [entryCeiling, exitThreshold) holds but does not enter', async () => {
    const band = { ...EASY, score: 2.5 }
    // Strong: a score inside the band does not enter a streak.
    const strong = await bench({ config })
    openTurn(strong.session, 1)
    user(strong.session, 'a small change')
    strong.engine.score = band
    expect(await strong.resolve(1)).toBeUndefined()
    expect(strong.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'difficulty-too-high', difficulty: { score: 2.5 } })
    // At the ceiling itself entry is already refused.
    const atCeiling = await bench({ config })
    atCeiling.engine.score = { ...EASY, score: 2 }
    expect(await atCeiling.resolve(1)).toBeUndefined()
    expect(atCeiling.decision()).toMatchObject({ reason: 'difficulty-too-high' })

    // Held: the same score keeps the held candidate.
    const held = await entered()
    held.engine.score = band
    expect(await held.resolve(2)).toEqual(CHEAP)
    expect(held.decision(1)).toMatchObject({ outcome: 'downgraded', reason: 'gate-passed', sticky: { active: true, stepsElapsed: 1 } })

    // Held past the horizon: a different candidate is an entry the band refuses,
    // so the held candidate stands instead.
    const twoCandidates: ModelRouterConfig = {
      ...config,
      candidates: [
        { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a test candidate' },
        { id: 'mid', provider: MID.provider, model: MID.model, description: 'a test candidate' },
      ],
    }
    const switching = await entered({ config: twoCandidates })
    closeTurn(switching.session, 2)
    openTurn(switching.session, 3)
    startStep(switching.session, 3)
    switching.engine.choice = { ...PASSING, option: 'mid', probabilities: { mid: 0.9, cheap: 0.05 } }
    switching.engine.score = band
    expect(await switching.resolve(3)).toEqual(CHEAP)
    expect(switching.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      selection: { candidateId: 'cheap' },
      sticky: { active: true, stepsElapsed: 2, enteredTurn: 1, enteredStep: 1 },
    })
    // Below the band the same answer enters the new candidate.
    switching.engine.score = EASY
    closeTurn(switching.session, 3)
    openTurn(switching.session, 4)
    startStep(switching.session, 4)
    expect(await switching.resolve(4)).toEqual(MID)
    expect(switching.decision(2)).toMatchObject({
      reason: 'gate-passed',
      sticky: { active: true, stepsElapsed: 0, enteredTurn: 4, enteredStep: 1 },
    })
  })

  it('ends a held streak at hold.maxSteps without judging, inside the entering turn', async () => {
    const b = await bench({ config: { ...config, hold: { minSteps: 1, maxSteps: 2 } } })
    openTurn(b.session, 1)
    startStep(b.session, 1, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1, STRONG, b.signal, 1)).toEqual(CHEAP)
    startStep(b.session, 1, 2)
    expect(await b.resolve(1, STRONG, b.signal, 2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({ reason: 'gate-passed', sticky: { stepsElapsed: 1, enteredTurn: 1, enteredStep: 1 } })
    const asked = b.engine.asks.length

    startStep(b.session, 1, 3)
    expect(await b.resolve(1, STRONG, b.signal, 3)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(asked)
    expect(b.decision(2)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'hold-cap',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'hold-cap' },
    })
    expect(b.decision(2)).not.toHaveProperty('route')
    // The manual route stands for the rest of the turn.
    startStep(b.session, 1, 4)
    expect(await b.resolve(1, STRONG, b.signal, 4)).toBeUndefined()
    expect(b.decisions()).toHaveLength(3)

    // The cap starts no cooldown: the next turn is judged and may enter again.
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    startStep(b.session, 2)
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(3)).toMatchObject({ reason: 'gate-passed', sticky: { active: true, stepsElapsed: 0, enteredTurn: 2 } })
  })

  it('keeps the manual route without judging for reentryCooldownTurns after a quality exit', async () => {
    const b = await entered()
    b.engine.score = { ...EASY, score: 4 }
    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({ reason: 'escalated', sticky: { brokenBy: 'escalated' } })
    b.engine.score = EASY
    const asked = b.engine.asks.length

    for (const turn of [3, 4]) {
      closeTurn(b.session, turn - 1)
      openTurn(b.session, turn)
      startStep(b.session, turn)
      expect(await b.resolve(turn)).toBeUndefined()
      expect(b.decisions().at(-1)).toMatchObject({ outcome: 'kept-strong', reason: 'reentry-cooldown', sticky: { active: false } })
    }
    expect(b.engine.asks).toHaveLength(asked)

    closeTurn(b.session, 4)
    openTurn(b.session, 5)
    startStep(b.session, 5)
    expect(await b.resolve(5)).toEqual(CHEAP)
    expect(b.decisions().at(-1)).toMatchObject({ reason: 'gate-passed', sticky: { active: true, enteredTurn: 5 } })

    // With the cooldown disabled, the turn after the exit is judged again.
    const off = await entered({ config: { ...config, reentryCooldownTurns: 0 } })
    off.engine.choice = { ...PASSING, option: KEEP_CURRENT_OPTION_ID, probabilities: { [KEEP_CURRENT_OPTION_ID]: 0.9, cheap: 0.05 } }
    expect(await off.resolve(2)).toBeUndefined()
    expect(off.decision(1)).toMatchObject({ reason: 'current-preferred', sticky: { brokenBy: 'current-preferred' } })
    off.engine.choice = PASSING
    closeTurn(off.session, 2)
    openTurn(off.session, 3)
    startStep(off.session, 3)
    expect(await off.resolve(3)).toEqual(CHEAP)
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'escalated' },
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'current-preferred' },
    })
  })

  it('held streak: an answer naming the base-equal candidate ends the streak as current-preferred', async () => {
    const b = await entered({
      config: {
        ...config,
        candidates: [
          { id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a test candidate' },
          { id: 'strong-copy', provider: STRONG.provider, model: STRONG.model, description: 'a test candidate' },
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'current-preferred' },
    })
    expect(stickyState(b.session.events)).toMatchObject({ active: false, brokenBy: 'current-preferred' })
  })

  it('difficultyToEffort applies at entry and is frozen for the streak', async () => {
    const liftConfig = (): ModelRouterConfig => ({
      ...config,
      escalateBack: { scoreThreshold: 3 },
      difficulty: { entryScoreCeiling: 3 },
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
    startStep(lifted.session, 2)
    lifted.engine.score = { ...EASY, score: 1 }
    expect(await lifted.resolve(2)).toEqual({ ...CHEAP, reasoningEffort: 'high' })
    expect(lifted.decision(1)).toMatchObject({
      reason: 'gate-passed',
      selection: { candidateId: 'cheap', reasoningEffort: 'high' },
      sticky: { active: true, stepsElapsed: 1, enteredTurn: 1 },
    })

    // Entered on an easy step: a later hard step does not lift the streak.
    const plain = await bench({ config: liftConfig() })
    openTurn(plain.session, 1)
    user(plain.session, 'a small change')
    expect(await plain.resolve(1)).toEqual(CHEAP)
    closeTurn(plain.session, 1)
    openTurn(plain.session, 2)
    startStep(plain.session, 2)
    plain.engine.score = { ...EASY, score: 2.5 }
    expect(await plain.resolve(2)).toEqual(CHEAP)
    expect(plain.decision(1)).toMatchObject({ reason: 'gate-passed', sticky: { stepsElapsed: 1, enteredTurn: 1 } })
    expect(plain.decision(1).selection).not.toHaveProperty('reasoningEffort')
  })

  it('an effort change mid-streak is treated as a candidate change', async () => {
    // With and without a lift: the held effort is reachable under neither.
    for (const difficultyToEffort of [undefined, { scoreThreshold: 1.5, reasoningEffort: 'high' }]) {
      const b = await bench({
        settings: true,
        config: {
          ...config,
          escalateBack: { scoreThreshold: 3 },
          candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low', description: 'a test candidate' }],
          ...difficultyToEffort === undefined ? {} : { difficultyToEffort },
        },
      })
      openTurn(b.session, 1)
      user(b.session, 'a small change')
      expect(await b.resolve(1)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
      closeTurn(b.session, 1)
      openTurn(b.session, 2)
      startStep(b.session, 2)
      await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'medium', description: 'a test candidate' }],
      })

      // Below the horizon the held effort stands, as for any candidate change.
      expect(await b.resolve(2)).toEqual({ ...CHEAP, reasoningEffort: 'low' })
      expect(b.decision(1)).toMatchObject({ reason: 'sticky-hold', sticky: { stepsElapsed: 1, enteredTurn: 1 } })

      // After the horizon the new effort enters as a new streak.
      closeTurn(b.session, 2)
      openTurn(b.session, 3)
      startStep(b.session, 3)
      expect(await b.resolve(3)).toEqual({ ...CHEAP, reasoningEffort: 'medium' })
      expect(b.decision(2)).toMatchObject({
        reason: 'gate-passed',
        selection: { candidateId: 'cheap', reasoningEffort: 'medium' },
        sticky: { active: true, stepsElapsed: 0, enteredTurn: 3 },
      })
      expect(stickyState(b.session.events)).toMatchObject({ enteredTurn: 3, candidate: { reasoningEffort: 'medium' } })
    }
  })

  it('holds the entered candidate through the horizon and starts a new streak afterward', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        hold: { minSteps: 2 },
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
    startStep(b.session, 2)
    b.engine.choice = { ...PASSING, option: 'mid', probabilities: { mid: 0.9, cheap: 0.05 } }

    // The newly chosen candidate cannot churn an active streak before its horizon.
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, stepsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })

    // Once the horizon is reached the new candidate may enter, and its own
    // entered step must be where the pure fold restarts the elapsed count.
    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    startStep(b.session, 3)
    expect(await b.resolve(3)).toEqual(MID)
    expect(b.decision(2)).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: 'mid', provider: MID.provider, model: MID.model },
      sticky: { active: true, stepsElapsed: 0, enteredTurn: 3, entryBase: STRONG },
    })
    expect(stickyState(b.session.events)).toMatchObject({
      active: true,
      stepsElapsed: 0,
      enteredTurn: 3,
      candidate: { candidateId: 'mid', provider: MID.provider, model: MID.model },
    })
  })

  it('removing a held pool candidate ends the streak', async () => {
    const b = await bench({ settings: true, config: { ...CONFIG, hold: { minSteps: 2 } } })
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'unknown-candidate' },
    })
  })

  it('base-unlisted keeps strong without judging', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    const other = { provider: 'other-provider', model: 'other-model' }
    expect(await b.resolve(1, other)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(0)
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'base-unlisted', sticky: { active: false } })
    expect(b.decision()).not.toHaveProperty('objective')
    expect(b.decision()).not.toHaveProperty('candidateEligibility')
    // The manual route stands for the rest of the turn.
    expect(await b.resolve(1, other, b.signal, 2)).toBeUndefined()
    expect(b.decisions()).toHaveLength(1)

    // A listed route records its objective on every decision it resolves.
    const listed = await bench()
    expect(await listed.resolve(1)).toEqual(CHEAP)
    expect(listed.decision()).toMatchObject({ reason: 'gate-passed', objective: 'dollars' })
    listed.engine.choice = LOW_CONFIDENCE
    const quota = await bench({
      config: { ...CONFIG, routeFrom: [{ provider: STRONG.provider, model: STRONG.model, objective: 'quota', allowEveryTurn: true }] },
    })
    quota.engine.choice = LOW_CONFIDENCE
    expect(await quota.resolve(1)).toBeUndefined()
    expect(quota.decision()).toMatchObject({ reason: 'low-confidence', objective: 'quota' })
  })

  it('ends a held streak with base-unlisted when settings remove its route from routeFrom', async () => {
    const b = await bench({ settings: true, config: { ...CONFIG, hold: { minSteps: 2 } } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    startStep(b.session, 2)

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
      routeFrom: [{ provider: 'other-provider', model: 'other-model', objective: 'dollars' }],
    })
    expect(await b.resolve(2)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'base-unlisted',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'base-unlisted' },
    })
    expect(stickyState(b.session.events)).toMatchObject({ active: false, brokenBy: 'base-unlisted' })

    // A write that leaves routing on with nothing to route from is refused by name.
    await expect(b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { routeFrom: [] }))
      .rejects.toThrow('ModelRouterConfig.routeFrom is empty: routing can never run')
  })

  it('ends the streak as a manual deviation when the manual provider/model moves off the entry base', async () => {
    const b = await entered()
    expect(await b.resolve(2, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'manual-deviation',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'manual-deviation' },
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
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0, enteredTurn: 1 },
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
      stepsElapsed: 0,
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'route-errors', entryBase: STRONG },
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
    const b = await bench({
      config: { ...CONFIG, maxRouteErrors: 1, onUnavailable: 'error', judgmentFailures: { holdTolerance: 0 } },
    })
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
      sticky: { active: false, stepsElapsed: 0 },
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
    const b = await bench({ config: { ...CONFIG, hold: { minSteps: 2 } } })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1, base)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    startStep(b.session, 2)
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
        hold: { minSteps: 2 },
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low', description: 'a test candidate' }],
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
          sticky: { active: false, stepsElapsed: 0 },
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
          sticky: { active: false, stepsElapsed: 0 },
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
    const b = await bench({ config: { ...CONFIG, hold: { minSteps: 2 } } })
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
          sticky: { active: false, stepsElapsed: 0, entryBase: STRONG },
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
    startStep(b.session, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({ reason: 'gate-failed', sticky: { active: false } })
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })

  it('reports nothing for a replayed streak whose entering decision recorded no base', async () => {
    const b = await bench({ config: { ...CONFIG, hold: { minSteps: 2 } } })
    // A hand-written decision with no entry base and no preceding header: the
    // fold holds the candidate but can name no manual route to report.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: '00000000',
      stateSeqs: [0],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0, enteredTurn: 1 },
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'escalated' },
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
      sticky: { active: true, enteredTurn: 1, stepsElapsed: 0 },
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'manual-deviation' },
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'candidate-ineligible' },
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
      sticky: { active: false, stepsElapsed: 0 },
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
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a test candidate' }],
        routeFrom: [{ provider: STRONG.provider, model: STRONG.model, objective: 'dollars' }],
        downgradeThreshold: 0.8,
        downgradeMargin: 0.1,
        routeInstructions: 'Pick the cheapest route that can finish this turn.',
        hold: { minSteps: 0 },
      },
    })
    user(b.session, 'a small change')

    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.engine.asks[0]?.questions.map(question => question.kind)).toEqual(['choice'])
    expect(b.decision()).not.toHaveProperty('difficulty')
    expect(b.decision()).not.toHaveProperty('hint')
  })

  it('holds a streak whose entering decision recorded no entry base', async () => {
    const b = await bench({ config: { ...CONFIG, hold: { minSteps: 2 } } })
    // A log whose first turn entered the streak: no preceding header exists, so
    // the fold has no derived base and the consult falls back to the route in
    // force.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'gate-passed',
      stateHash: '00000000',
      stateSeqs: [0],
      selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0, enteredTurn: 1 },
    })
    openTurn(b.session, 2)
    startStep(b.session, 2)
    user(b.session, 'a small change')
    b.engine.choice = LOW_CONFIDENCE

    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'sticky-hold',
      sticky: { active: true, stepsElapsed: 1, entryBase: STRONG },
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
      sticky: { active: true, stepsElapsed: 0, enteredTurn: 1, entryBase: STRONG },
    })
    expect(b.session.events.some(event => event.type === 'request/header')).toBe(false)
    expect(stickyState(b.session.events).entryBase).toEqual(STRONG)

    // An unchanged manual route re-affirms the streak rather than ending it.
    openTurn(b.session, 2)
    startStep(b.session, 2)
    user(b.session, 'another small change')
    expect(await b.resolve(2, STRONG)).toEqual(CHEAP)
    expect(b.decision(1)).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      sticky: { active: true, stepsElapsed: 1, enteredTurn: 1, entryBase: STRONG },
    })

    // The same log now sees a manual provider/model switch and ends the streak.
    closeTurn(b.session, 2)
    openTurn(b.session, 3)
    expect(await b.resolve(3, { provider: 'other-provider', model: 'other-model' })).toBeUndefined()
    expect(b.decision(2)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'manual-deviation',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'manual-deviation' },
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
      sticky: { active: false, stepsElapsed: 0 },
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

  it('observes whether the first reply after an ended streak carried thinking', async () => {
    /** One assistant reply in the open turn, with or without a reasoning block. */
    function reply(b: Bench, turn: number, thinking: boolean): void {
      b.session.append('assistant/message', {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [...thinking ? [{ type: 'reasoning' as const, text: 'plan' }] : [], { type: 'text' as const, text: 'done' }],
          source: { provider: STRONG.provider, model: STRONG.model },
        }),
      }, { surfaceOp: 'append' })
    }
    const b = await bench({ projections: true })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    reply(b, 1, false)
    // No streak has ended yet, so the routed reply is not a return.
    expect(projectionOf(b.ctx, b.session)).not.toHaveProperty('returnThinking')
    closeTurn(b.session, 1)

    openTurn(b.session, 2)
    b.engine.score = { ...EASY, score: 4 }
    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({ reason: 'escalated' })
    reply(b, 2, true)
    expect(projectionOf(b.ctx, b.session).returnThinking).toBe('present')
    // Later replies do not overwrite the observed return.
    reply(b, 2, false)
    expect(projectionOf(b.ctx, b.session).returnThinking).toBe('present')
    closeTurn(b.session, 2)

    // A strong decision that ended no streak starts no new observation.
    openTurn(b.session, 3)
    expect(await b.resolve(3)).toBeUndefined()
    expect(b.decision(2)).toMatchObject({ reason: 'reentry-cooldown' })
    reply(b, 3, false)
    expect(projectionOf(b.ctx, b.session).returnThinking).toBe('present')
    closeTurn(b.session, 3)

    // The next ended streak's return replaces it.
    for (const turn of [4, 5]) {
      openTurn(b.session, turn)
      await b.resolve(turn)
      closeTurn(b.session, turn)
    }
    openTurn(b.session, 6)
    b.engine.score = EASY
    expect(await b.resolve(6)).toEqual(CHEAP)
    closeTurn(b.session, 6)
    openTurn(b.session, 7)
    b.engine.score = { ...EASY, score: 4 }
    expect(await b.resolve(7)).toBeUndefined()
    reply(b, 7, false)
    expect(projectionOf(b.ctx, b.session).returnThinking).toBe('absent')
  })

  it('reports the last decision and the sticky streak with its elapsed steps', async () => {
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
        stepsElapsed: 0,
        selection: { candidateId: 'cheap', provider: CHEAP.provider, model: CHEAP.model },
      },
    })

    closeTurn(b.session, 1)
    openTurn(b.session, 3)
    startStep(b.session, 3, 1)
    startStep(b.session, 3, 2)
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({
      active: true,
      stepsElapsed: 2,
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
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({ active: false, stepsElapsed: 0 })
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
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({ active: false, stepsElapsed: 0 })
  })

  it('retains the last streak’s entry base after that streak broke', async () => {
    const b = await bench({ projections: true, config: { ...CONFIG, hold: { minSteps: 2 } } })
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

    // The session already runs the pool candidate, which routing does not start
    // from, and no streak ever recorded a route to restore.
    expect(await b.resolve(1, { provider: CHEAP.provider, model: CHEAP.model })).toBeUndefined()
    expect(b.decision(0)).toMatchObject({ reason: 'base-unlisted', sticky: { active: false } })
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
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0 },
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
        stepsElapsed: 0,
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
      sticky: { active: false, stepsElapsed: 0 },
    })
    const hinted = projectionOf(b.ctx, b.session)
    expect(hinted.last).toEqual({
      outcome: 'kept-strong',
      reason: 'low-confidence',
      hint: 'consider-stronger',
    })
    expect(hinted.sticky).toEqual({ active: false, stepsElapsed: 0 })

    // A held streak whose decision named no selection: the sticky view carries none.
    b.session.append('model-routing/decision', {
      outcome: 'downgraded',
      reason: 'sticky-hold',
      stateHash: '00000000',
      stateSeqs: [0],
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 1, enteredTurn: 4 },
    })
    expect(projectionOf(b.ctx, b.session).sticky).toEqual({ active: true, stepsElapsed: 0 })
  })
})

describe('configuration at plugin load', () => {
  it('loads the documented composition and resolves every default', async () => {
    const b = await bench()
    const config = b.ctx.modelRouting.config()
    expect(config).toMatchObject({
      initialMode: 'on',
      hold: { minSteps: 20, maxSteps: 40 },
      entryScoreCeiling: 2,
      reentryCooldownTurns: 2,
      escalateBackScoreThreshold: 3,
      maxRouteErrors: 2,
      onUnavailable: 'fallback',
      inTurnFallback: 'manual',
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
      candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a test candidate' }],
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

describe('in-turn fallback', () => {
  /** A failure the loop reports for one attempt on a route. */
  function failure(code = 'AUTH'): LlmFailure {
    return { message: 'the route failed', code }
  }

  /**
   * Dispatch the loop's request-error waterfall for one failed attempt; the
   * terminal `next` is what the loop supplies when no listener recovers.
   */
  function requestError(
    b: Bench,
    options: { turn?: number; step?: number; provider?: string; code?: string; signal?: AbortSignal } = {},
  ): Promise<RequestErrorAction> {
    return agentEvents(b.ctx, b.agent).waterfall(
      'agent/request-error',
      {
        turn: options.turn ?? 1,
        step: options.step ?? 1,
        provider: options.provider ?? CHEAP.provider,
        failure: failure(options.code),
        retryPolicy: undefined,
        signal: options.signal ?? b.signal,
      },
      () => Promise.resolve(undefined),
    )
  }

  /** Route turn 1 step 1 to the candidate and log the request header and error chunk the loop would. */
  async function routedAndFailed(options: BenchOptions = {}): Promise<Bench> {
    const b = await bench(options)
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)
    b.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'finish', reason: { kind: 'error', failure: failure() } },
    })
    return b
  }

  it('candidate stream error retries the same step on the manual route', async () => {
    const b = await routedAndFailed()
    const failedChunkSeq = b.session.events.at(-1)?.seq

    expect(await requestError(b)).toEqual({ kind: 'retry' })
    expect(b.decision(1)).toEqual({
      outcome: 'kept-strong',
      reason: 'route-failed',
      stateHash: b.decision(0).stateHash,
      stateSeqs: b.decision(0).stateSeqs,
      failure: { code: 'AUTH', provider: CHEAP.provider, model: CHEAP.model },
      failedChunkSeq,
      objective: 'dollars',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'route-failed', entryBase: STRONG },
    })

    // The retried request resolves the manual route without a second judgment,
    // including when the caller's manual base is the failed header's route.
    expect(await b.resolve(1)).toBeUndefined()
    expect(await b.resolve(1, CHEAP)).toEqual(STRONG)
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(2)
    expect(stickyState(b.session.events)).toMatchObject({ active: false, brokenBy: 'route-failed' })

    // A second failure in that step, now on the manual route, stays terminal.
    header(b.session, STRONG.provider, STRONG.model)
    expect(await requestError(b, { provider: STRONG.provider })).toBeUndefined()
    expect(b.decisions()).toHaveLength(2)
  })

  it('defers to llm-retry when it schedules a retry', async () => {
    const b = await routedAndFailed()
    // A downstream listener standing in for llm-retry: it owns a transient retry.
    let downstreamCalls = 0
    b.ctx.on('agent/request-error', async (_payload, next) => {
      downstreamCalls += 1
      const action = await next()
      return action ?? { kind: 'retry' }
    })

    expect(await requestError(b)).toEqual({ kind: 'retry' })
    expect(downstreamCalls).toBe(1)
    expect(b.decisions()).toHaveLength(1)
    // The candidate's retry keeps the downgraded pin.
    expect(await b.resolve(1)).toEqual(CHEAP)
  })

  it('inTurnFallback off leaves the failure terminal', async () => {
    const b = await routedAndFailed({ config: { ...CONFIG, inTurnFallback: 'off' } })

    expect(await requestError(b)).toBeUndefined()
    expect(b.decisions()).toHaveLength(1)
  })

  it('aborted failure is not converted', async () => {
    const b = await routedAndFailed()
    const controller = new AbortController()
    controller.abort()

    expect(await requestError(b, { code: 'ABORTED' })).toBeUndefined()
    expect(await requestError(b, { signal: controller.signal })).toBeUndefined()
    expect(b.decisions()).toHaveLength(1)
  })

  it('converts only the request this controller routed', async () => {
    const b = await routedAndFailed()

    // Another step, another turn, or another provider did not run the downgrade.
    expect(await requestError(b, { step: 2 })).toBeUndefined()
    expect(await requestError(b, { turn: 2 })).toBeUndefined()
    expect(await requestError(b, { provider: STRONG.provider })).toBeUndefined()
    expect(b.decisions()).toHaveLength(1)

    // A manual decision for the step, or no request header yet, is not a downgrade that failed.
    const kept = await bench()
    openTurn(kept.session, 1)
    kept.engine.choice = LOW_CONFIDENCE
    expect(await kept.resolve(1)).toBeUndefined()
    header(kept.session, STRONG.provider, STRONG.model)
    expect(await requestError(kept, { provider: STRONG.provider })).toBeUndefined()
    const unsent = await bench()
    openTurn(unsent.session, 1)
    expect(await unsent.resolve(1)).toEqual(CHEAP)
    expect(await requestError(unsent)).toBeUndefined()
    expect(unsent.decisions()).toHaveLength(1)
    // A header from an earlier turn that ran the selection's provider with
    // another model is not the failed attempt either.
    const stale = await bench()
    openTurn(stale.session, 1)
    header(stale.session, CHEAP.provider, 'cheap-model-previous')
    closeTurn(stale.session, 1)
    openTurn(stale.session, 2)
    expect(await stale.resolve(2)).toEqual(CHEAP)
    expect(await requestError(stale, { turn: 2 })).toBeUndefined()
    expect(stale.decisions()).toHaveLength(1)
  })

  it('records no failed chunk when the failed attempt logged none', async () => {
    const b = await bench()
    openTurn(b.session, 1)
    expect(await b.resolve(1)).toEqual(CHEAP)
    header(b.session, CHEAP.provider, CHEAP.model)

    expect(await requestError(b)).toEqual({ kind: 'retry' })
    expect(b.decision(1)).not.toHaveProperty('failedChunkSeq')
    // An unrelated route in force for the retry keeps its own manual choice.
    expect(await b.resolve(1, MID)).toBeUndefined()
  })

  it('only delegates after the plugin fiber is disposed', async () => {
    const b = await routedAndFailed()
    // Capture the router's callback mid-dispatch, as a waterfall in flight holds it.
    const captured = Promise.withResolvers<undefined>()
    let resume: (() => void) | undefined
    b.ctx.on('agent/request-error', async (_payload, next) => {
      await new Promise<void>((resolve) => {
        resume = resolve
        captured.resolve(undefined)
      })
      return next()
    })
    const pending = requestError(b)
    await captured.promise
    await b.routerFiber.dispose()
    resume?.()

    expect(await pending).toBeUndefined()
    expect(b.decisions()).toHaveLength(1)
  })

  it('a callback entered after disposal only delegates', async () => {
    const b = await routedAndFailed()
    // A waterfall captured the router's listener before its fiber was disposed
    // and enters it afterwards: the stale callback must not append a decision.
    let downstreamCalls = 0
    b.ctx.on('agent/request-error', async (_payload, next) => {
      downstreamCalls += 1
      return next()
    })
    const upstream = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    b.ctx.on('agent/request-error', async (_payload, next) => {
      entered.resolve(undefined)
      await upstream.promise
      return next()
    }, { prepend: true })
    const pending = requestError(b)
    await entered.promise
    await b.routerFiber.dispose()
    upstream.resolve(undefined)

    expect(await pending).toBeUndefined()
    expect(downstreamCalls).toBe(1)
    expect(b.decisions()).toHaveLength(1)
    // A fresh dispatch after disposal no longer reaches the router at all.
    expect(await requestError(b)).toBeUndefined()
    expect(b.decisions()).toHaveLength(1)
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
      objective: 'dollars',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'unknown-candidate' },
    })
  })

  it('breaks a same-step retry when settings remove its base from routeFrom', async () => {
    const b = await bench({ settings: true })
    expect(await b.resolve(1)).toEqual(CHEAP)

    await b.ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, {
      routeFrom: [{ provider: 'other-provider', model: 'other-model', objective: 'dollars' }],
    })

    // The retry of the same step keeps the manual route and logs exactly one exit.
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(2)
    expect(b.decisions().filter(decision => decision.reason === 'base-unlisted')).toHaveLength(1)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'base-unlisted',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'base-unlisted' },
    })
    expect(b.decision(1)).not.toHaveProperty('objective')
    expect(b.decision(1)).not.toHaveProperty('candidateEligibility')
    // A configuration exit starts no re-entry cooldown.
    expect(stickyState(b.session.events).cooldownTurn).toBeUndefined()
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
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'candidate-ineligible' },
    })
  })

  it('revalidates a held route with its selected reasoning effort', async () => {
    const b = await bench({
      config: {
        ...CONFIG,
        candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low', description: 'a test candidate' }],
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
    const b = await bench({ config: { ...CONFIG, hold: { minSteps: 2 } } })
    expect(await b.resolve(1)).toEqual(CHEAP)
    closeTurn(b.session, 1)
    openTurn(b.session, 2)
    b.adapter.setModelInfo(CHEAP.provider, CHEAP.model, { context: { contextWindow: 1 } })

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'candidate-ineligible',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'candidate-ineligible' },
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

  it('reads its fitting for its own consumer id and records the offered characters and the routed engine', async () => {
    const b = await bench()
    user(b.session, 'earlier task')
    user(b.session, 'continue')
    const offered: string[][] = []
    // Only the router's consumer has fitting, as under an override to a fitting engine.
    b.engine.fittingForConsumer = {
      ask: async (input) => {
        offered.push([...input.states])
        expect(input.consumer).toBe(MODEL_ROUTER_JUDGMENT_CONSUMER)
        return { kind: 'unfit', engine: 'laya', model: 'pinned', limits: FIT_LIMITS, reason: 'state', engineId: judgmentEngineId('laya') }
      },
    }
    expect(b.engine.fitting).toBeUndefined()
    expect(await b.resolve()).toBeUndefined()
    expect(b.engine.asks).toEqual([])
    expect(b.decision()).toMatchObject({
      reason: 'judgment-input-too-large',
      engineId: 'laya',
      latencyMs: expect.any(Number) as unknown,
      inputChars: offered[0]!.reduce((total, text) => total + text.length, 0),
    })
    expect(offered[0]).toHaveLength(2)
  })
})
