/**
 * An LLM-as-judge engine for the typed-judgment seam, registered in
 * `ctx.judgmentEngines` as `llm:<provider>/<model>` for `judgment-dispatch`
 * to route asks to.
 *
 * One ask is one model request on the configured `ctx.llm` route: the state
 * and the questions go in as one user message, and the judge answers through
 * one `judgment_answer` tool call whose parameter schema names every question
 * and every option or level. The probabilities are the model's own stated
 * numbers, so the descriptor declares calibration `verbalized`. No adapter
 * in this repository exposes token log-probabilities, so there is no
 * `logprob` path.
 *
 * The engine is an explicit composition choice and never falls back: until
 * `ctx.llm` resolves the configured route, its status is `starting`,
 * `unavailable`, or `unconfigured`, and every ask fails with that class. The
 * route is resolved again whenever the llm adapter topology changes. The
 * optional `ctx.judgmentRedactor` hook is consulted exactly once for each ask
 * that sends a request, before the size bound is checked, and each ask makes
 * exactly one model request with no retry.
 *
 * @module @shres-code/shres-code-judgment-llm
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import { JudgmentError, judgmentEngineId, registerJudgmentEngine } from '@shres-code/shres-code-judgment'
import type {
  JudgmentEngine,
  JudgmentEngineDescriptor,
  JudgmentEngineId,
  JudgmentInput,
  JudgmentQuestion,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import { BlockAssembler, createUserMessage, LlmError, ReasoningEffortId } from '@shres-code/shres-code-llm'
import type { GenerateOptions } from '@shres-code/shres-code-llm'
import { ANSWER_TOOL_NAME, answerTool, readAnswers, renderJudgeMessage, JUDGE_SYSTEM_PROMPT } from './answer.ts'
import { DEFAULT_TIMEOUT_MS, resolveConfig } from './config.ts'
import type { LlmJudgmentConfig, ResolvedLlmJudgmentConfig } from './config.ts'

export { ANSWER_TOOL_NAME, answerTool, JUDGE_SYSTEM_PROMPT, readAnswers, renderJudgeMessage } from './answer.ts'
export { DEFAULT_TIMEOUT_MS, resolveConfig } from './config.ts'
export type { LlmJudgmentConfig, LlmJudgmentEgress, ResolvedLlmJudgmentConfig } from './config.ts'

/** Value the seam reports as the engine that produced an answer. */
const ENGINE = 'llm'

/** Config omitted by a direct construction; {@link resolveConfig} rejects it by name. */
const NO_CONFIG = {} as LlmJudgmentConfig

/** The statuses this engine publishes: every state other than `ready` names its cause. */
type LlmJudgmentStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'starting' | 'unavailable' | 'unconfigured'; readonly detail: string }

/** Status while the configured route has not resolved yet. */
const STARTING: LlmJudgmentStatus = Object.freeze({ state: 'starting', detail: 'resolving the configured llm route' })

/** Status once the configured route resolved and accepts the configured controls. */
const READY: LlmJudgmentStatus = Object.freeze({ state: 'ready' })

/**
 * Build the registry id of the engine serving one route.
 * @param provider - the configured provider route.
 * @param model - the configured model id.
 * @returns `llm:<provider>/<model>`, branded.
 */
export function llmJudgmentEngineId(provider: string, model: string): JudgmentEngineId {
  return judgmentEngineId(`llm:${provider}/${model}`)
}

/**
 * Answers typed questions through one configured `ctx.llm` route and
 * registers itself in `ctx.judgmentEngines` for the lifetime of its fiber.
 */
export class LlmJudgmentEngine implements JudgmentEngine {
  /** The engine registry provided by `judgment-dispatch`, and the llm runtime that serves the route. */
  static inject = ['judgmentEngines', 'llm']

  /**
   * Composition config schema. Unrecognized keys and wrong types fail plugin
   * load by name; the route, `egress`, and `maxStateTokens` are required.
   */
  static Config: z<LlmJudgmentConfig> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    egress: z.union(['local', 'remote'] as const).required(),
    reasoningEffort: z.string(),
    maxStateTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
    temperature: z.number().min(0),
  })

  /** Resolved and validated ask facts. */
  readonly config: ResolvedLlmJudgmentConfig
  /** Registry facts: the route's id, the configured egress, and verbalized calibration. */
  readonly descriptor: JudgmentEngineDescriptor
  /** The provider context, read for the llm runtime, the logger, and the redaction hook. */
  private readonly ctx: Context
  /** Announces a status change to the registry's subscribers. */
  private readonly announce: () => void
  /** The current status the registry and every ask read. */
  private current: LlmJudgmentStatus = STARTING
  /** Unconfigured details already logged, so each is reported once. */
  private readonly reported = new Set<string>()
  /** Incremented per resolution and on disposal, so only the latest resolution publishes. */
  private generation = 0

  /**
   * @param ctx - the provider context whose fiber owns the registration and the route resolution.
   * @param config - composition config; a row that names none fails load on the missing route.
   */
  constructor(ctx: Context, config: LlmJudgmentConfig = NO_CONFIG) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    this.descriptor = Object.freeze({
      id: llmJudgmentEngineId(this.config.provider, this.config.model),
      label: `LLM judge (${this.config.provider}/${this.config.model})`,
      egress: this.config.egress,
      calibration: 'verbalized',
      supportsFitting: false,
    })
    this.announce = registerJudgmentEngine(ctx, { engine: this, descriptor: this.descriptor, status: () => this.current })
    ctx.effect(() => {
      const resolution = new AbortController()
      void this.resolveRoute(resolution.signal)
      const stopObserving = ctx.on('llm/adapters-updated', () => { void this.resolveRoute(resolution.signal) })
      return () => {
        stopObserving()
        resolution.abort()
        this.generation += 1
        this.current = STARTING
      }
    }, `judgment-llm route ${this.descriptor.id}`)
  }

  /**
   * Answer one set of typed questions about one state with one model request.
   * An ask with no questions makes no request and consults no redactor.
   * @param input - the state, the questions, and the cancellation signal. The
   *   tier has no effect: one configured route serves both tiers.
   * @returns the answers in ask order with `engine: 'llm'`, the exact model id
   *   the route resolved, the ask's duration in whole milliseconds, and the
   *   request's token usage when the route reported it.
   * @throws JudgmentError code `UNCONFIGURED` when the route refuses a
   *   configured control, code `UNAVAILABLE` while the route is unresolved,
   *   when the request fails, or when it outlives `timeoutMs`, code
   *   `INPUT_TOO_LARGE` when the redacted state exceeds `maxStateTokens`
   *   bytes, code `INVALID_ANSWER` when the judge's answer cannot answer the
   *   questions asked, or code `ABORTED` when the caller cancelled the ask.
   */
  async ask(input: JudgmentInput): Promise<JudgmentResult> {
    const startedAt = performance.now()
    throwIfCancelled(input.signal)
    const model = this.readyModel()
    if (input.questions.length === 0) return { answers: [], engine: ENGINE, model, latencyMs: 0 }
    const state = await this.redactState(input.state)
    throwIfCancelled(input.signal)
    const stateBytes = Buffer.byteLength(state, 'utf8')
    if (stateBytes > this.config.maxStateTokens) {
      throw new JudgmentError(
        'INPUT_TOO_LARGE',
        `judgment-llm: the state is ${stateBytes} bytes, above maxStateTokens ${this.config.maxStateTokens}`,
      )
    }
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline])
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(this.request(state, input.questions, signal))) assembler.push(chunk)
    // A cancelled ask fails even when the route finished the request anyway.
    throwIfCancelled(input.signal)
    const finish = assembler.finish
    if (finish.kind === 'aborted' || finish.kind === 'error') {
      if (deadline.aborted) {
        throw new JudgmentError('UNAVAILABLE', `judgment-llm: the judge request did not finish within timeoutMs ${this.config.timeoutMs}`)
      }
      throw new JudgmentError(
        'UNAVAILABLE',
        `judgment-llm: the judge request to ${this.config.provider}/${this.config.model} failed: ${finish.failure.message}`,
        { cause: finish.failure },
      )
    }
    if (finish.kind === 'max-tokens') {
      throw new JudgmentError('INVALID_ANSWER', 'judgment-llm: the judge answer was cut off at the output token limit')
    }
    const calls = assembler.blocks().filter(block => block.type === 'tool-call')
    const call = calls[0]
    if (calls.length !== 1 || call?.name !== ANSWER_TOOL_NAME) {
      throw new JudgmentError(
        'INVALID_ANSWER',
        `judgment-llm: the judge must answer with exactly one ${ANSWER_TOOL_NAME} call, and made ${calls.length} tool call(s)`,
      )
    }
    const answers = readAnswers(call.arguments, input.questions)
    const usage = assembler.usage
    return {
      answers,
      engine: ENGINE,
      model,
      latencyMs: Math.round(performance.now() - startedAt),
      ...usage === undefined ? {} : { usage: { ...usage } },
    }
  }

  /** The judge request for one redacted state. */
  private request(state: string, questions: readonly JudgmentQuestion[], signal: AbortSignal): GenerateOptions {
    const config = this.config
    return {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) },
      ...config.temperature === undefined ? {} : { temperature: config.temperature },
      system: JUDGE_SYSTEM_PROMPT,
      messages: [createUserMessage({
        content: [{ type: 'text', text: renderJudgeMessage(state, questions) }],
        source: { kind: 'plugin', plugin: 'shres-judgment-llm' },
      })],
      tools: [answerTool(questions)],
      signal,
    }
  }

  /** The exact model id to answer with, or the failure the current status names. */
  private readyModel(): string {
    const status = this.current
    if (status.state === 'ready') return this.config.model
    throw new JudgmentError(
      status.state === 'unconfigured' ? 'UNCONFIGURED' : 'UNAVAILABLE',
      `judgment-llm: engine ${this.descriptor.id} is ${status.state}: ${status.detail}`,
    )
  }

  /** Consult the deployment's egress hook once, or send the state unchanged. */
  private async redactState(state: string): Promise<string> {
    const redactor = this.ctx.get('judgmentRedactor')
    return redactor === undefined ? state : await redactor.redactState(state)
  }

  /**
   * Resolve the configured route and the controls the judge request states,
   * then publish the resulting status unless a later resolution or disposal
   * superseded this one.
   */
  private async resolveRoute(signal: AbortSignal): Promise<void> {
    this.generation += 1
    const generation = this.generation
    const { provider, model, reasoningEffort, temperature } = this.config
    let next: LlmJudgmentStatus
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
      if (reasoningEffort !== undefined) {
        await this.ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: ReasoningEffortId(reasoningEffort) }, signal)
      }
      next = temperature !== undefined && info.acceptsTemperature === false
        ? {
          state: 'unconfigured',
          detail: `temperature is set, but ${provider}/${model} does not accept a stated temperature; remove temperature from this engine's config`,
        }
        : READY
    } catch (error: unknown) {
      next = unresolvedStatus(error, provider, model)
    }
    if (signal.aborted || generation !== this.generation) return
    this.publish(next)
  }

  /** Publish a changed status, logging a newly reported misconfiguration once. */
  private publish(next: LlmJudgmentStatus): void {
    if (statusKey(next) === statusKey(this.current)) return
    this.current = next
    if (next.state === 'unconfigured' && !this.reported.has(next.detail)) {
      this.reported.add(next.detail)
      this.ctx.logger.error(`judgment-llm: engine ${this.descriptor.id} is unconfigured: ${next.detail}`)
    }
    this.announce()
  }
}

/**
 * The status a failed route resolution leaves: a refused reasoning effort is
 * a misconfiguration, and every other failure, an absent adapter included,
 * leaves the route unavailable until the adapter topology changes.
 */
function unresolvedStatus(error: unknown, provider: string, model: string): LlmJudgmentStatus {
  if (error instanceof LlmError && error.code === 'UNSUPPORTED_REASONING_EFFORT') {
    return { state: 'unconfigured', detail: `reasoningEffort is not supported by ${provider}/${model}: ${error.message}` }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { state: 'unavailable', detail: `${provider}/${model} does not resolve: ${message}` }
}

/** One comparable string per status, so an unchanged resolution announces nothing. */
function statusKey(status: LlmJudgmentStatus): string {
  return status.state === 'ready' ? status.state : `${status.state}\n${status.detail}`
}

/** Fail an ask the caller has cancelled. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new JudgmentError('ABORTED', 'judgment-llm: the ask was cancelled by the caller', { cause: signal.reason })
  }
}

export default LlmJudgmentEngine
