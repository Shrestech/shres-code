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
import { agentEvents } from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection } from '@shres-code/shres-code-agent'
import CommandRuntime from '@shres-code/shres-code-commands'
import JudgmentService, { JUDGMENT_SETTINGS_NAMESPACE, JudgmentError } from '@shres-code/shres-code-judgment'
import type {
  JudgmentAnswer,
  JudgmentChoiceAnswer,
  JudgmentInput,
  JudgmentResult,
  JudgmentScoreAnswer,
} from '@shres-code/shres-code-judgment'
import { ReasoningEffortId, createUserMessage } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session, TurnEndReason } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import { CommandId } from '@shres-code/shres-code-commands/brand'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import ModelRoutingController, {
  DIFFICULTY_QUESTION_ID,
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
  /** Every ask, in order. */
  readonly asks: JudgmentInput[] = []
  /** Route answer to return; \`undefined\` answers no route question at all. */
  choice: JudgmentChoiceAnswer | undefined = PASSING
  /** Difficulty answer to return; \`undefined\` answers no score question. */
  score: JudgmentScoreAnswer | undefined = EASY
  /** When set, the ask rejects with it instead of answering. */
  failure: Error | undefined

  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
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
function agentFor(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

interface Bench {
  ctx: Context
  session: Session
  agent: Agent
  signal: AbortSignal
  engine: ScriptedJudgment
  /** One consult for a turn, against the strong manual route by default. */
  resolve(turn?: number, base?: ModelSelection): Promise<ModelSelection | undefined>
  decisions(): ModelRoutingDecision[]
  decision(index?: number): ModelRoutingDecision
}

interface BenchOptions {
  config?: ModelRouterConfig
  /** Mount the scripted engine (default true). */
  engine?: boolean
  commands?: boolean
  projections?: boolean
  /** Mount the settings provider (needed for the deployment toggle). */
  settings?: boolean
}

async function bench(options: BenchOptions = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.settings === true) await ctx.plugin(MemorySettings)
  if (options.projections === true) await ctx.plugin(SessionProjectionRegistry)
  if (options.engine !== false) await ctx.plugin(ScriptedJudgment)
  if (options.commands === true) {
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
  }
  await ctx.plugin(ModelRoutingController, options.config ?? CONFIG)
  const session = ctx.sessions.create()
  const agent = agentFor(session)
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
    resolve: (turn = 1, base = STRONG) => ctx.modelRouting.resolveRequest(agent, turn, 1, base, signal),
    decisions,
    decision: (index = 0) => {
      const found = decisions()[index]
      if (found === undefined) throw new Error(`no routing decision at index ${String(index)}`)
      return found
    },
  }
}

/** One logged user message. */
function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** One full request-header snapshot for a route. */
function header(session: Session, provider: string, model: string, system?: string): void {
  session.append('request/header', {
    header: { config: { provider, model }, ...system === undefined ? {} : { system } },
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
    expect(b.engine.asks[0]).toMatchObject({ state: 'a small change', tier: 'fast' })
    expect(b.engine.asks[0]?.signal).toBe(b.signal)
    expect(b.engine.asks[0]?.questions).toEqual([
      {
        kind: 'choice',
        id: ROUTE_QUESTION_ID,
        instructions: CONFIG.routeInstructions,
        options: [{ option: 'cheap', description: 'a small change in familiar code' }],
      },
      {
        kind: 'score',
        id: DIFFICULTY_QUESTION_ID,
        instructions: CONFIG.difficultyInstructions,
        levels: [...(b.ctx.modelRouting.config().difficultyLevels)],
      },
    ])
  })

  it('commits a between-turns switch, reports noop for the mode already in force, and folds it from the log', async () => {
    const b = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: false })
    expect(b.ctx.modelRouting.set(b.agent, false)).toBe('noop')

    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('committed')
    expect(b.ctx.modelRouting.modeOf(b.session)).toBe(true)
    expect(b.ctx.modelRouting.get(b.agent)).toEqual({ active: true })
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('noop')
    expect(b.ctx.modelRouting.set(b.agent, false)).toBe('committed')
    expect(b.session.events.flatMap(event => event.type === 'model-routing/mode' ? [event.data.active] : [])).toEqual([true, false])
  })

  it('queues a switch during an open turn and commits it at the next accepted pre-step', async () => {
    const b = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(b.session, 1)
    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('queued')
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

  it('cancels a between-turns reversal of a queued switch without logging, and a pre-step flush that nets out', async () => {
    const cancelled = await bench({ config: { ...CONFIG, initialMode: 'off' } })
    openTurn(cancelled.session, 1)
    expect(cancelled.ctx.modelRouting.set(cancelled.agent, true)).toBe('queued')
    closeTurn(cancelled.session, 1)
    // Back to the logged state: the pending intent clears, nothing lands.
    expect(cancelled.ctx.modelRouting.set(cancelled.agent, false)).toBe('cancelled')
    expect(cancelled.session.events.some(event => event.type === 'model-routing/mode')).toBe(false)
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
    expect(netted.session.events.some(event => event.type === 'model-routing/mode')).toBe(false)
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
    // The intent is still parked (it nets out at the next accepted pre-step).
    expect(await route(off, '/route')).toBe('Routing is off. A change applies from the next step.')
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
    expect(between.session.events.some(event => event.type === 'model-routing/mode')).toBe(false)
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

  it('refuses the candidate already in force as the manual route', async () => {
    const b = await bench()
    expect(await b.resolve(1, { provider: CHEAP.provider, model: CHEAP.model })).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'candidate-equals-base' })
  })

  it('refuses the candidate already in force at the same reasoning effort', async () => {
    const b = await bench({
      config: { ...CONFIG, candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: 'low' }] },
    })
    expect(await b.resolve(1, { provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: ReasoningEffortId('low') })).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'candidate-equals-base' })
    // A different effort on the same route is still a change of route, and the
    // selected route runs at the candidate's own effort.
    expect(await b.resolve(2, { provider: CHEAP.provider, model: CHEAP.model, reasoningEffort: ReasoningEffortId('high') }))
      .toEqual({ ...CHEAP, reasoningEffort: 'low' })
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
      difficultyToEffort: { scoreThreshold: 4, reasoningEffort: 'high' },
    })

    // At the threshold and above it, the SELECTED candidate runs at the lift.
    for (const score of [4, 4.5]) {
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
    strong.engine.score = { ...EASY, score: 5 }
    expect(await strong.resolve(1)).toBeUndefined()
    expect(strong.decision()).not.toHaveProperty('selection')
    expect(strong.decision()).not.toHaveProperty('hint')
  })

  it('adds the advisory hint to a strong turn above the configured threshold', async () => {
    const b = await bench({ config: { ...CONFIG, hardHint: { scoreThreshold: 4 } } })
    b.engine.choice = LOW_CONFIDENCE
    b.engine.score = { ...EASY, score: 5 }
    expect(await b.resolve(1)).toBeUndefined()
    expect(b.decision()).toMatchObject({ outcome: 'kept-strong', reason: 'low-confidence', hint: 'consider-stronger', difficulty: { score: 5 } })

    // Below the threshold the hint is absent, and it never rides a downgrade.
    const below = await bench({ config: { ...CONFIG, hardHint: { scoreThreshold: 4 } } })
    below.engine.choice = LOW_CONFIDENCE
    expect(await below.resolve(1)).toBeUndefined()
    expect(below.decision()).not.toHaveProperty('hint')
    const downgraded = await bench({ config: { ...CONFIG, hardHint: { scoreThreshold: 4 } } })
    downgraded.engine.score = { ...EASY, score: 5 }
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
      sticky: { active: true, turnsElapsed: 1 },
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
    expect(stickyState(b.session.events, b.ctx.modelRouting.config())).toEqual({
      active: false,
      turnsElapsed: 0,
      brokenBy: 'gate-failed',
    })
  })

  it('escalates back at any elapsed count when the difficulty answer is high', async () => {
    const b = await entered({ config: CONFIG })
    b.engine.choice = LOW_CONFIDENCE
    b.engine.score = { ...EASY, score: 4.5 }

    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'escalated',
      difficulty: { score: 4.5 },
      sticky: { active: false, turnsElapsed: 0, brokenBy: 'escalated' },
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
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 1 },
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

  it('reports route-errors from the fold and re-judges from scratch after it', async () => {
    const b = await entered()
    routeFailure(b.session, 2)
    routeFailure(b.session, 3)
    expect(stickyState(b.session.events, b.ctx.modelRouting.config())).toEqual({
      active: false,
      turnsElapsed: 0,
      brokenBy: 'route-errors',
    })

    b.engine.choice = LOW_CONFIDENCE
    expect(await b.resolve(2)).toBeUndefined()
    expect(b.decision(1)).toMatchObject({
      outcome: 'kept-strong',
      reason: 'low-confidence',
      sticky: { active: false, turnsElapsed: 0 },
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
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 1 },
    })

    expect(stickyState(b.session.events, b.ctx.modelRouting.config()).active).toBe(true)
    expect(b.ctx.modelRouting.stickySelection(b.agent)).toBeUndefined()
  })
})

describe('the intra-turn pin', () => {
  it('judges once per turn and re-judges the next turn', async () => {
    const b = await bench()
    user(b.session, 'a small change')
    expect(await b.resolve(1)).toEqual(CHEAP)
    // A later step of the same turn, and a same-turn request retry.
    expect(await b.resolve(1)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(1)
    expect(b.decisions()).toHaveLength(1)

    openTurn(b.session, 2)
    user(b.session, 'another small change')
    expect(await b.resolve(2)).toEqual(CHEAP)
    expect(b.engine.asks).toHaveLength(2)
    expect(b.decisions()).toHaveLength(2)
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
    expect(await b.resolve(1)).toBeUndefined()
    expect(await b.resolve(1)).toBeUndefined()
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
      sticky: { active: true, turnsElapsed: 0, enteredTurn: 1 },
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
    expect(stickyState(b.session.events, b.ctx.modelRouting.config()).entryBase).toEqual(STRONG)

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
    expect(b.decision().stateSeqs).toEqual([1, 2, 3])
    expect(b.engine.asks[0]?.state).toBe('second\n\nthird\n\nfourth')
    expect(b.decision().stateHash).toBe(stateHash('second\n\nthird\n\nfourth'))
  })

  it('keeps only the current message with contextTurns 0', async () => {
    const b = await bench({ config: { ...CONFIG, state: { contextTurns: 0 } } })
    user(b.session, 'first')
    user(b.session, 'second')
    await b.resolve(1)
    expect(b.decision().stateSeqs).toEqual([1])
    expect(b.engine.asks[0]?.state).toBe('second')
  })

  it('skips a message with no text and joins several text blocks of one message', async () => {
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
    expect(b.decision().stateSeqs).toEqual([1])
    expect(b.engine.asks[0]?.state).toBe('head\ntail')
  })

  it('caps the assembled state at maxChars and hashes exactly what it sent', async () => {
    const b = await bench({ config: { ...CONFIG, state: { maxChars: 12 } } })
    user(b.session, 'the first long message')
    user(b.session, 'the second long message')

    await b.resolve(1)
    const sent = b.engine.asks[0]?.state ?? ''
    const assembled = 'the first long message\n\nthe second long message'
    expect(sent).toBe(assembled.slice(assembled.length - 12))
    expect(sent).toHaveLength(12)
    expect(b.decision().stateHash).toBe(stateHash(sent))
    expect(b.decision().stateSeqs).toEqual([0, 1])
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

  it('reports a logged /route selection as pending until the mode event records it', async () => {
    const b = await bench({ projections: true, commands: true, config: { ...CONFIG, initialMode: 'off' } })
    await b.ctx.commands.execute(b.agent, '/route', b.signal)
    expect(projectionOf(b.ctx, b.session).pending).toBe(true)

    expect(b.ctx.modelRouting.set(b.agent, true)).toBe('committed')
    expect(projectionOf(b.ctx, b.session)).toMatchObject({ active: true, pending: false })
  })

  it('reports the last decision and the sticky streak with its elapsed turns', async () => {
    const b = await bench({ projections: true })
    openTurn(b.session, 1)
    user(b.session, 'a small change')
    await b.resolve(1)

    expect(projectionOf(b.ctx, b.session)).toEqual({
      active: false,
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
      sticky: { active: true, turnsElapsed: 0 },
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
      sticky: { active: true, turnsElapsed: 1, enteredTurn: 4 },
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
      escalateBackScoreThreshold: 4,
      maxRouteErrors: 2,
      onUnavailable: 'fallback',
      tier: 'fast',
      state: { contextTurns: 2, maxChars: 12_000 },
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
    } as unknown as ModelRouterConfig)).rejects.toThrow('ModelRouterConfig.difficultyToEffort.scoreThreshold must be a number from 1 through 5')
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
    const agent = agentFor(session)
    expect(ctx.get('modelRouting')).toBeInstanceOf(ModelRoutingController)
    expect(ctx.commands.find(agent, 'route')).toBeDefined()
    expect(projectionOf(ctx, session)).toBeDefined()

    await fiber.dispose()

    expect(ctx.get('modelRouting')).toBeUndefined()
    expect(ctx.commands.find(agent, 'route')).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(session).values.modelRouting).toBeUndefined()
  })
})
