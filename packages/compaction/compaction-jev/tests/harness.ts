/**
 * Shared harness for the compaction-jev suites.
 *
 * TEST DOUBLES (all local to this package's tests, all labelled):
 * - {@link ContextAdapter}: the smallest real \`LlmAdapter\` that serves both roles
 *   a compaction routes through — it advertises one context window, which prices
 *   the conversation target's pressure, and streams one text draft for every
 *   one-shot call.
 * - {@link ScriptedJudgment}: the smallest real \`JudgmentService\` subclass — it
 *   answers typed questions from a script and records every ask. Mounted
 *   through \`ctx.plugin\` exactly as a provider is.
 * - {@link MemorySettings}: the smallest real settings provider (one in-memory
 *   document), used only for the deployment toggle.
 * - {@link ScriptedSummarizer}: the deterministic summarizer every draft comes
 *   from, so a diff compares the engines and not the drafts.
 * - {@link TestJevEngine}: the engine under test.
 * - {@link InheritedSummarizerJevEngine}: the engine with its real inherited
 *   summarizer, for the verify cascade.
 */

import { Context } from '@shres-code/cordis'
import BasicCompactionEngine from '@shres-code/shres-code-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@shres-code/shres-code-compaction-basic'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@shres-code/shres-code-llm'
import LlmRuntime, { CallId, LlmAdapter, createMessage, createToolResultMessage, createUserMessage } from '@shres-code/shres-code-llm'
import JudgmentService from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentInput, JudgmentQuestion, JudgmentResult } from '@shres-code/shres-code-judgment'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import SessionStore, { Session, SessionId } from '@shres-code/shres-code-session'
import TokenMeter from '@shres-code/shres-code-token-meter'
import type { TokenMeasurement } from '@shres-code/shres-code-token-meter'
import type { Agent } from '@shres-code/shres-code-agent'
import JevCompactionEngine from '../src/index.ts'
import type { JevCompactionConfig } from '../src/index.ts'

/** The routed model every session requests. */
export const MODEL = 'test-model'
/** Provider route an explicitly configured escalation pair names. */
export const ESCALATION_PROVIDER = 'escalation-provider'
/** Model the escalation route names. */
export const ESCALATION_MODEL = 'escalation-model'
/** One live turn cancellation signal for the whole suite. */
export const SIGNAL = new AbortController().signal

/**
 * TEST DOUBLE: an adapter that advertises one context window and streams one
 * text draft per call. It is the smallest adapter that can serve both roles a
 * compaction routes through — the conversation target whose capacity prices
 * pressure, and the one-shot summarization call.
 */
export class ContextAdapter extends LlmAdapter {
  /** Text the adapter streams back on every call. */
  text = 'conversation draft'
  /** Provider-reported usage for every call, when set. */
  usage: TokenUsage | undefined
  /** Every call this adapter received, in order. */
  readonly calls: GenerateOptions[] = []

  constructor(private readonly contextWindow: number) {
    super()
  }

  /** The most recent call, or `undefined` when none was made. */
  get lastOptions(): GenerateOptions | undefined {
    return this.calls.at(-1)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Every adapter one test context registered, by the role it serves. */
const adaptersByContext = new WeakMap<Context, { conversation: ContextAdapter; escalation: ContextAdapter }>()

/** A context with the inherited engine's dependencies and both adapter routes. */
export function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  void new SessionStore(ctx)
  const conversation = new ContextAdapter(contextWindow)
  const escalation = new ContextAdapter(contextWindow)
  escalation.text = 'escalation draft'
  ctx.llm.registerAdapter([MODEL], conversation)
  ctx.llm.registerAdapter([ESCALATION_PROVIDER], escalation)
  adaptersByContext.set(ctx, { conversation, escalation })
  return ctx
}

/** The adapter serving the conversation route (and an unconfigured summarizer). */
export function conversationAdapter(ctx: Context): ContextAdapter {
  const entry = adaptersByContext.get(ctx)
  if (entry === undefined) throw new Error('harness: this context was not built by createContext')
  return entry.conversation
}

/** The adapter serving the escalation route. */
export function escalationAdapter(ctx: Context): ContextAdapter {
  const entry = adaptersByContext.get(ctx)
  if (entry === undefined) throw new Error('harness: this context was not built by createContext')
  return entry.escalation
}

/** The smallest honest Agent surface the engine reads: a real session and routing options. */
export function agent(session: Session, model?: string): Agent {
  return {
    session,
    options: model === undefined ? {} : { provider: MODEL, model },
  } as Agent
}

/** Closed two-message turns followed by one open turn for durable compaction events. */
export function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`conversation-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Closed tool turns, one assistant tool-call per turn followed by its result. */
export function toolConversation(turns = 3, chars = 300): Session {
  const session = Session.create(SessionId(`tools-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    const callId = CallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} `.repeat(chars / 10) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn} `.repeat(chars / 10) },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn} `.repeat(chars / 10) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/**
 * Closed turns whose assistant message leaves one tool call unanswered, so no
 * cut after the first surface node is tool-pairing balanced.
 */
export function openToolCallConversation(turns = 3, chars = 300): Session {
  const session = Session.create(SessionId(`open-tool-calls-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    const callId = CallId(`open-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} `.repeat(chars / 10) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn} `.repeat(chars / 10) },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Question id the engine's segment score question carries for one span. */
export function segmentQuestion(startSeq: number, endSeq: number): string {
  return `segment:${startSeq}:${endSeq}`
}

/** Question id the engine's boundary hazard question carries for one edge. */
export function boundaryQuestion(edge: 'start' | 'end', seq: number): string {
  return `boundary:${edge}:${seq}`
}

/** One scripted score answer. */
export interface ScriptedScore {
  /** Score the engine reports. */
  score: number
  /** Confidence the engine reports. */
  confidence: number
}

/** TEST DOUBLE: a scripted judgment engine, mounted as a real provider. */
export class ScriptedJudgment extends JudgmentService {
  /** Every ask, in order. */
  readonly asks: JudgmentInput[] = []
  /** Score answers by question id; an unmapped id falls back to {@link defaultScore}. */
  readonly scores = new Map<string, ScriptedScore>()
  /** Binary answers by question id; an unmapped id falls back to {@link defaultProbability}. */
  readonly probabilities = new Map<string, number>()
  /** Question ids to answer with nothing at all. */
  readonly omitted = new Set<string>()
  /**
   * Ordered per-ask scripts: entry N replaces the maps for ask N + 1, so a case
   * can answer the first battery one way and the escalation battery another.
   * Asks beyond the list fall back to the maps.
   */
  readonly script: Array<{
    /** Score answers for this ask, by question id. */
    scores?: Record<string, ScriptedScore>
    /** Binary answers for this ask, by question id. */
    probabilities?: Record<string, number>
    /** Question ids this ask answers with nothing. */
    omit?: string[]
  }> = []
  /** Score answer for a question {@link scores} does not map. */
  defaultScore: ScriptedScore | undefined
  /** Binary answer for a question {@link probabilities} does not map. */
  defaultProbability = 0
  /** When set, the ask rejects with it instead of answering. */
  failure: Error | undefined
  /** 1-based ask indices that reject with {@link failure} instead of answering. */
  readonly failingAsks = new Set<number>()
  /** Engine name reported on every result. */
  engineName = 'scripted-judgment'
  /** Model name reported on every result. */
  modelName = 'scripted-1'
  /** Duration reported on every result. */
  latency = 3

  /** The asks that carried at least one question of the given kind. */
  asksOfKind(kind: JudgmentQuestion['kind']): JudgmentInput[] {
    return this.asks.filter(input => input.questions.some(question => question.kind === kind))
  }

  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    const failure = this.failure
    if (failure !== undefined && (this.failingAsks.size === 0 || this.failingAsks.has(this.asks.length))) {
      return Promise.reject(failure)
    }
    const step = this.script.shift()
    const scores = step === undefined ? this.scores : new Map(Object.entries(step.scores ?? {}))
    const probabilities = step === undefined
      ? this.probabilities
      : new Map(Object.entries(step.probabilities ?? {}))
    const omitted = step === undefined ? this.omitted : new Set(step.omit ?? [])
    const answers: JudgmentAnswer[] = []
    for (const question of input.questions) {
      if (omitted.has(question.id)) continue
      if (question.kind === 'binary') {
        answers.push({
          kind: 'binary',
          id: question.id,
          probability: probabilities.get(question.id) ?? this.defaultProbability,
        })
      } else if (question.kind === 'score') {
        const scripted = scores.get(question.id) ?? this.defaultScore
        if (scripted === undefined) continue
        answers.push({
          kind: 'score',
          id: question.id,
          score: scripted.score,
          probabilities: {},
          confidence: scripted.confidence,
        })
      }
      // A choice question is never asked by this backend, so none is answered.
    }
    return Promise.resolve({
      answers,
      engine: this.engineName,
      model: this.modelName,
      latencyMs: this.latency,
    })
  }
}

/** TEST DOUBLE: the smallest real settings provider — one in-memory document. */
export class MemorySettings extends SettingsProvider {
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

/** TEST DOUBLE: the deterministic summarizer the engine under test serves drafts from. */
class ScriptedSummarizer {
  /** The draft every call returns. */
  summary: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]
  /** Provider recorded on the draft. */
  provider = 'summary-provider'
  /** Model recorded on the draft. */
  model = 'summary-model'
  /** Generation cap recorded on the draft. */
  maxTokens = 123
  /** Every summarization input, in order. */
  readonly calls: SummarizationInput[] = []
  /** 1-based call indices that fail instead of returning a draft. */
  readonly failingCalls = new Set<number>()
  /** Failure thrown for every index in {@link failingCalls}. */
  failure: Error = new Error('scripted summarization failure')

  /** Produce one draft, or throw this call's scripted failure. */
  run(input: SummarizationInput): Promise<SummaryResult> {
    this.calls.push(input)
    const failure = this.failure
    if (failure !== undefined && this.failingCalls.has(this.calls.length)) return Promise.reject(failure)
    return Promise.resolve({
      summary: this.summary,
      provider: this.provider,
      model: this.model,
      maxTokens: this.maxTokens,
    })
  }
}

/** TEST DOUBLE: the engine under test, with a scripted summarizer and an exposed hook. */
export class TestJevEngine extends JevCompactionEngine {
  constructor(
    ctx: Context,
    config: JevCompactionConfig,
    readonly summarizer = new ScriptedSummarizer(),
  ) {
    super(ctx, config)
  }

  /** Expose the protected selection hook. */
  public override selectRange(
    session: Session,
    measurement: TokenMeasurement,
    retainTokens: number,
    pinSeqs: readonly number[],
  ): Promise<{ start: number; end: number } | null> {
    return super.selectRange(session, measurement, retainTokens, pinSeqs)
  }

  /** Serve every draft from the scripted summarizer. */
  protected override summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return this.summarizer.run(input)
  }
}

/** TEST DOUBLE: the engine with its REAL inherited summarizer, for the verify cascade. */
export class InheritedSummarizerJevEngine extends JevCompactionEngine {
  /** Expose the protected hook the cascade runs inside. */
  public override summarize(
    input: SummarizationInput,
    owner: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return super.summarize(input, owner, signal)
  }

  /** Expose the protected selection hook. */
  public override selectRange(
    session: Session,
    measurement: TokenMeasurement,
    retainTokens: number,
    pinSeqs: readonly number[],
  ): Promise<{ start: number; end: number } | null> {
    return super.selectRange(session, measurement, retainTokens, pinSeqs)
  }
}

/** Drive one automatic attempt for a session. */
export function compactIfNeeded(
  engine: BasicCompactionEngine,
  session: Session,
  trigger: 'pressure' | 'context-overflow' = 'pressure',
  model: string | undefined = MODEL,
): Promise<{ shadowedRange: { start: number; end: number }; shadowedSeqs: number[]; shadowedTokenCount: number } | null> {
  return engine.compactIfNeeded(agent(session, model), trigger, SIGNAL)
}

/** Every companion selection event of one session, in order. */
export function selectionEvents(session: Session) {
  return session.events.flatMap(event => event.type === 'compaction/selection' ? [event.data] : [])
}

/** Every companion verification event of one session, in order. */
export function verificationEvents(session: Session) {
  return session.events.flatMap(event => event.type === 'compaction/verification' ? [event.data] : [])
}

/** Every durable summary event of one session, in order. */
export function summaryEvents(session: Session) {
  return session.events.flatMap(event => event.type === 'compaction/summary' ? [event.data] : [])
}

/** The base compaction config every engine is built from. */
const BASE_CONFIG = {
  auto: false,
  thresholdRatio: 0.8,
  retainTokens: 100,
} as const

/** The required judgment texts plus one battery check. */
export function jevOverrides(overrides: Partial<JevCompactionConfig> = {}): JevCompactionConfig {
  return {
    ...BASE_CONFIG,
    segmentScoreInstructions: 'How much does a later turn depend on this segment?',
    boundaryInstructions: 'Does this edge cut through work that belongs together?',
    verifyInstructions: 'How well does this summary preserve what a later turn needs?',
    verifyChecks: [{ name: 'constraints', instructions: 'Does the summary drop a stated constraint?' }],
    ...overrides,
  }
}
