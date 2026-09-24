import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { JudgmentEngineRegistry, JudgmentError, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type { JudgmentBinaryQuestion, JudgmentChoiceQuestion, JudgmentInput } from '@shres-code/shres-code-judgment'
import LlmRuntime, { ReasoningEffortId } from '@shres-code/shres-code-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@shres-code/shres-code-llm'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import LlmJudgmentEngine, { DEFAULT_TIMEOUT_MS, JUDGE_SYSTEM_PROMPT, llmJudgmentEngineId, renderJudgeMessage, resolveConfig } from '../src/index.ts'
import type { LlmJudgmentConfig } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const PROVIDER = 'judge'
const MODEL = 'judge-small'
const ID = llmJudgmentEngineId(PROVIDER, MODEL)
const BASE: LlmJudgmentConfig = { provider: PROVIDER, model: MODEL, egress: 'remote', maxStateTokens: 1000 }

const URGENT: JudgmentBinaryQuestion = { kind: 'binary', id: judgmentQuestionId('urgent'), instructions: 'Is this urgent?' }
const ROUTE: JudgmentChoiceQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('route'),
  instructions: 'Which route?',
  options: [{ option: 'keep-current' }, { option: 'flash' }],
}

/** A scripted judge answer through the answer tool. */
function answer(answers: Record<string, unknown>): StreamChunk[] {
  return toolCallResponse('judge-call', 'judgment_answer', { answers })
}

/** Resolves models with a declared temperature fact and optional reasoning levels. */
class FactAdapter extends MockAdapter {
  constructor(script: Script, private readonly facts: Partial<LlmResolvedModelInfo> = {}) {
    super(script)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), ...this.facts }
  }
}

/** Counts its consultations and replaces `secret`. */
class CountingRedactor extends Service {
  calls = 0

  constructor(ctx: Context, private readonly onRedact?: () => void) {
    super(ctx, 'judgmentRedactor')
  }

  async redactState(state: string): Promise<string> {
    this.calls += 1
    this.onRedact?.()
    await Promise.resolve()
    return state.replaceAll('secret', '[redacted]')
  }
}

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A context with the llm runtime and a bare engine registry. */
async function base(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('judgmentEngines', new JudgmentEngineRegistry((error: unknown) => {
    throw error
  }))
  await ctx.plugin(LlmRuntime)
  return ctx
}

/** Mount the engine and return it with its registry entry. */
async function mount(ctx: Context, config: Partial<LlmJudgmentConfig> = {}) {
  const fiber = await ctx.plugin(LlmJudgmentEngine, { ...BASE, ...config })
  const entry = ctx.judgmentEngines.get(llmJudgmentEngineId(config.provider ?? PROVIDER, config.model ?? MODEL))
  if (entry === undefined) throw new Error('the engine did not register')
  return { fiber, entry, engine: entry.engine as LlmJudgmentEngine }
}

/** Wait until the engine's route resolution settles out of `starting`. */
async function settled(entry: { status(): { state: string } }): Promise<void> {
  await vi.waitFor(() => { expect(entry.status().state).not.toBe('starting') })
}

/** Boot a ready engine over one scripted adapter. */
async function ready(script: Script, config: Partial<LlmJudgmentConfig> = {}, facts: Partial<LlmResolvedModelInfo> = {}) {
  const ctx = await base()
  const adapter = new FactAdapter(script, facts)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const mounted = await mount(ctx, config)
  await settled(mounted.entry)
  expect(mounted.entry.status()).toEqual({ state: 'ready' })
  return { ctx, adapter, ...mounted }
}

/** The judgment failure one ask rejected with. */
async function failure(ask: Promise<unknown>): Promise<JudgmentError> {
  try {
    await ask
  } catch (error: unknown) {
    if (error instanceof JudgmentError) return error
    throw error
  }
  throw new Error('the ask resolved instead of failing')
}

function input(over: Partial<JudgmentInput> = {}): JudgmentInput {
  return { state: 'the user says the build is broken', questions: [ROUTE, URGENT], ...over }
}

describe('configuration', () => {
  it('applies the default timeout and keeps the optional controls it was given', () => {
    expect(resolveConfig(BASE)).toEqual({ ...BASE, timeoutMs: DEFAULT_TIMEOUT_MS })
    expect(resolveConfig({ ...BASE, egress: 'local', reasoningEffort: 'low', temperature: 0, timeoutMs: 5 }))
      .toEqual({ ...BASE, egress: 'local', reasoningEffort: 'low', temperature: 0, timeoutMs: 5 })
  })

  it.each([
    ['an unknown key', { ...BASE, fallback: 'deepseek' }, 'unknown config key "fallback"'],
    ['a missing provider', { ...BASE, provider: '' }, 'provider must be a non-empty string'],
    ['a missing model', { ...BASE, model: undefined }, 'model must be a non-empty string'],
    ['a missing egress', { ...BASE, egress: undefined }, 'egress must be "local" for a route that runs on this machine or "remote" for any other route'],
    ['an unknown egress', { ...BASE, egress: 'none' }, 'egress must be "local"'],
    ['an empty reasoningEffort', { ...BASE, reasoningEffort: '' }, 'reasoningEffort must be a non-empty string'],
    ['a fractional maxStateTokens', { ...BASE, maxStateTokens: 1.5 }, 'maxStateTokens must be a positive integer'],
    ['a zero maxStateTokens', { ...BASE, maxStateTokens: 0 }, 'maxStateTokens must be a positive integer'],
    ['a zero timeoutMs', { ...BASE, timeoutMs: 0 }, 'timeoutMs must be a positive number'],
    ['a negative temperature', { ...BASE, temperature: -1 }, 'temperature must be a finite non-negative number'],
  ])('rejects %s by name', (_case, config, message) => {
    expect(() => resolveConfig(config as LlmJudgmentConfig)).toThrow(message)
  })

  it('fails load on a row with no route, and a direct construction with no config by field name', async () => {
    const ctx = await base()
    await expect(ctx.plugin(LlmJudgmentEngine)).rejects.toThrow('$.provider missing required value')
    expect(() => new LlmJudgmentEngine(ctx)).toThrow('judgment-llm: provider must be a non-empty string')
  })
})

describe('registration', () => {
  it.each(['remote', 'local'] as const)('registers the route id with the configured %s egress, verbalized and unfitted', async (egress) => {
    const { entry } = await ready([], { egress })
    expect(entry.descriptor).toEqual({
      id: 'llm:judge/judge-small',
      label: 'LLM judge (judge/judge-small)',
      egress,
      calibration: 'verbalized',
      supportsFitting: false,
    })
    expect(entry.engine.fitting).toBeUndefined()
  })

  it('unregisters with its fiber, and a resolution finishing afterwards publishes nothing', async () => {
    const ctx = await base()
    const release = Promise.withResolvers<undefined>()
    ctx.llm.registerAdapter([PROVIDER], new class extends MockAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        await release.promise
        return super.resolveModel(provider, model)
      }
    }([]))
    const { fiber, entry } = await mount(ctx)
    expect(entry.status()).toEqual({ state: 'starting', detail: 'resolving the configured llm route' })
    await fiber.dispose()
    expect(ctx.judgmentEngines.get(ID)).toBeUndefined()
    release.resolve(undefined)
    await Promise.resolve()
    expect(entry.status().state).toBe('starting')
  })
})

describe('status', () => {
  it('is unavailable while no adapter serves the route, and ready once one registers', async () => {
    const ctx = await base()
    const changes = vi.fn()
    ctx.judgmentEngines.subscribe(changes)
    const { entry } = await mount(ctx)
    await settled(entry)
    expect(entry.status()).toEqual({ state: 'unavailable', detail: 'judge/judge-small does not resolve: no adapter registered for provider "judge"' })
    const announced = changes.mock.calls.length

    const unregister = ctx.llm.registerAdapter([PROVIDER], new MockAdapter([]))
    await vi.waitFor(() => { expect(entry.status()).toEqual({ state: 'ready' }) })
    expect(changes.mock.calls.length).toBeGreaterThan(announced)

    unregister()
    await vi.waitFor(() => { expect(entry.status().state).toBe('unavailable') })
  })

  it('never answers while unavailable, and makes no request', async () => {
    const ctx = await base()
    const { entry, engine } = await mount(ctx)
    await settled(entry)
    const error = await failure(engine.ask(input()))
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toBe('judgment-llm: engine llm:judge/judge-small is unavailable: judge/judge-small does not resolve: no adapter registered for provider "judge"')
  })

  it('reports a non-Error resolution failure as its text', async () => {
    const ctx = await base()
    ctx.llm.registerAdapter([PROVIDER], new class extends MockAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        // oxlint-disable-next-line prefer-promise-reject-errors -- an adapter may reject with a non-Error value
        return Promise.reject('catalog offline')
      }
    }([]))
    const { entry } = await mount(ctx)
    await settled(entry)
    expect(entry.status()).toEqual({ state: 'unavailable', detail: 'judge/judge-small does not resolve: catalog offline' })
  })

  it('config rejects temperature on a model that forbids it: unconfigured by field name, logged once', async () => {
    const ctx = await base()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    const adapter = new FactAdapter([], { acceptsTemperature: false })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    const { entry, engine } = await mount(ctx, { temperature: 0.2 })
    await settled(entry)
    const detail = 'temperature is set, but judge/judge-small does not accept a stated temperature; remove temperature from this engine\'s config'
    expect(entry.status()).toEqual({ state: 'unconfigured', detail })
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(`judgment-llm: engine llm:judge/judge-small is unconfigured: ${detail}`)

    const refused = await failure(engine.ask(input()))
    expect(refused.code).toBe('UNCONFIGURED')
    expect(refused.message).toContain('temperature is set')
    expect(adapter.requests).toHaveLength(0)

    // Re-resolution after a topology change reaches the same status and logs nothing new.
    ctx.llm.registerAdapter(['other'], new MockAdapter([]))
    await Promise.resolve()
    await settled(entry)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('accepts temperature where the route makes no claim or accepts it', async () => {
    for (const facts of [{}, { acceptsTemperature: true }]) {
      const { entry } = await ready([], { temperature: 0.2 }, facts)
      expect(entry.status().state).toBe('ready')
    }
  })

  it('is unconfigured when the route refuses the configured reasoning effort', async () => {
    const ctx = await base()
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    ctx.llm.registerAdapter([PROVIDER], new MockAdapter([], { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] }))
    const { entry } = await mount(ctx, { reasoningEffort: 'max' })
    await settled(entry)
    expect(entry.status()).toEqual({
      state: 'unconfigured',
      detail: 'reasoningEffort is not supported by judge/judge-small: provider "judge" model "judge-small" does not support reasoning effort "max"',
    })
  })
})

describe('one ask', () => {
  it('sends one judge request on the configured route and returns validated answers', async () => {
    const { adapter, engine } = await ready([answer({ route: { 'keep-current': 0.25, flash: 0.75 }, urgent: 0.9 })], {
      reasoningEffort: 'low',
      temperature: 0,
    }, { reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } })
    const { answers, latencyMs, ...identity } = await engine.ask(input())

    expect(identity).toEqual({ engine: 'llm', model: MODEL, usage: { inputTokens: 10, outputTokens: 5 } })
    expect(Number.isInteger(latencyMs) && latencyMs >= 0).toBe(true)
    expect(answers).toHaveLength(2)
    expect(answers[0]).toMatchObject({ kind: 'choice', id: 'route', option: 'flash', probabilities: { 'keep-current': 0.25, flash: 0.75 } })
    expect(answers[1]).toEqual({ kind: 'binary', id: 'urgent', probability: 0.9 })
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0] as GenerateOptions
    expect(request).toMatchObject({
      provider: PROVIDER,
      model: MODEL,
      reasoningEffort: 'low',
      temperature: 0,
      system: JUDGE_SYSTEM_PROMPT,
      tools: [{ name: 'judgment_answer' }],
    })
    expect(request.messages).toHaveLength(1)
    const [message] = request.messages
    expect(message).toMatchObject({ role: 'user', source: { kind: 'plugin', plugin: 'shres-judgment-llm' } })
    expect(message?.content).toEqual([{ type: 'text', text: renderJudgeMessage('the user says the build is broken', [ROUTE, URGENT]) }])
  })

  it('omits the optional controls it was not configured with, and usage the route did not report', async () => {
    const chunks = answer({ route: { 'keep-current': 1, flash: 0 }, urgent: 0 }).filter(chunk => chunk.type !== 'usage')
    const { adapter, engine } = await ready([chunks])
    const result = await engine.ask(input())
    expect(result).not.toHaveProperty('usage')
    const request = adapter.requests[0] as GenerateOptions
    expect(request).not.toHaveProperty('reasoningEffort')
    expect(request).not.toHaveProperty('temperature')
  })

  it('answers an ask with no questions without a request or a redaction', async () => {
    const { ctx, adapter, engine } = await ready([])
    const redactor = new CountingRedactor(ctx)
    expect(await engine.ask(input({ questions: [] }))).toEqual({ answers: [], engine: 'llm', model: MODEL, latencyMs: 0 })
    expect(redactor.calls).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('consults the redactor exactly once and sends only the redacted state', async () => {
    const { ctx, adapter, engine } = await ready([answer({ route: { 'keep-current': 1, flash: 0 }, urgent: 0 })])
    const redactor = new CountingRedactor(ctx)
    await engine.ask(input({ state: 'the secret key is in the log' }))
    expect(redactor.calls).toBe(1)
    const sent = JSON.stringify(adapter.requests[0]?.messages)
    expect(sent).toContain('the [redacted] key is in the log')
    expect(sent).not.toContain('secret')
  })

  it('bounds the redacted state in UTF-8 bytes before any request', async () => {
    const { ctx, adapter, engine } = await ready([], { maxStateTokens: 4 })
    const redactor = new CountingRedactor(ctx)
    const error = await failure(engine.ask(input({ state: 'naïve' })))
    expect(error.code).toBe('INPUT_TOO_LARGE')
    expect(error.message).toBe('judgment-llm: the state is 6 bytes, above maxStateTokens 4')
    expect(redactor.calls).toBe(1)
    expect(adapter.requests).toHaveLength(0)
  })

  it('makes exactly one request when the route fails, and classifies it unavailable', async () => {
    const failing: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'overloaded', code: 'SERVER_ERROR', status: 529 } } }]
    const { adapter, engine } = await ready([failing, answer({ route: { 'keep-current': 1, flash: 0 }, urgent: 0 })])
    const error = await failure(engine.ask(input()))
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toBe('judgment-llm: the judge request to judge/judge-small failed: overloaded')
    expect(error.cause).toMatchObject({ code: 'SERVER_ERROR', status: 529 })
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails unavailable naming timeoutMs when the request outlives it', async () => {
    const { engine } = await ready(['hang'], { timeoutMs: 20 })
    const error = await failure(engine.ask(input()))
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toBe('judgment-llm: the judge request did not finish within timeoutMs 20')
  })

  it.each([
    ['a text answer', textResponse('flash'), 'made 0 tool call(s)'],
    ['two tool calls', [
      ...toolCallResponse('a', 'judgment_answer', { answers: {} }).slice(0, 4),
      ...toolCallResponse('b', 'judgment_answer', { answers: {} }).map(chunk => ('index' in chunk ? { ...chunk, index: 1 } : chunk)),
    ] as StreamChunk[], 'made 2 tool call(s)'],
    ['another tool', toolCallResponse('c', 'bash', { command: 'ls' }), 'made 1 tool call(s)'],
  ])('rejects %s as INVALID_ANSWER', async (_case, chunks, message) => {
    const { engine } = await ready([chunks])
    const error = await failure(engine.ask(input()))
    expect(error.code).toBe('INVALID_ANSWER')
    expect(error.message).toBe(`judgment-llm: the judge must answer with exactly one judgment_answer call, and ${message}`)
  })

  it('rejects an answer cut off at the output limit', async () => {
    const { engine } = await ready([maxTokensResponse('{"answers":')])
    const error = await failure(engine.ask(input()))
    expect(error.code).toBe('INVALID_ANSWER')
    expect(error.message).toBe('judgment-llm: the judge answer was cut off at the output token limit')
  })

  it('rejects an answer that omits a requested option', async () => {
    const { engine } = await ready([answer({ route: { flash: 1 }, urgent: 0 })])
    const error = await failure(engine.ask(input()))
    expect(error.code).toBe('INVALID_ANSWER')
    expect(error.message).toContain('omits "keep-current"')
  })
})

describe('cancellation', () => {
  it('fails ABORTED before any redaction or request when already cancelled', async () => {
    const { ctx, adapter, engine } = await ready([])
    const redactor = new CountingRedactor(ctx)
    const controller = new AbortController()
    const reason = new Error('turn cancelled')
    controller.abort(reason)
    const error = await failure(engine.ask(input({ signal: controller.signal })))
    expect(error.code).toBe('ABORTED')
    expect(error.message).toBe('judgment-llm: the ask was cancelled by the caller')
    expect(error.cause).toBe(reason)
    expect(redactor.calls).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails ABORTED without a request when cancelled during redaction', async () => {
    const { ctx, adapter, engine } = await ready([])
    const controller = new AbortController()
    new CountingRedactor(ctx, () => { controller.abort() })
    expect((await failure(engine.ask(input({ signal: controller.signal })))).code).toBe('ABORTED')
    expect(adapter.requests).toHaveLength(0)
  })

  it('cancels the in-flight request and fails ABORTED', async () => {
    const { adapter, engine } = await ready(['hang'])
    const controller = new AbortController()
    const asked = engine.ask(input({ signal: controller.signal }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    controller.abort()
    expect((await failure(asked)).code).toBe('ABORTED')
    expect(adapter.requests[0]?.signal?.aborted).toBe(true)
  })

  it('fails ABORTED when cancelled after the route finished anyway', async () => {
    const controller = new AbortController()
    const { engine } = await ready([() => {
      controller.abort()
      return answer({ route: { 'keep-current': 1, flash: 0 }, urgent: 0 })
    }])
    // The scripted adapter stops streaming on an aborted signal, so the stream ends without a finish chunk.
    expect((await failure(engine.ask(input({ signal: controller.signal })))).code).toBe('ABORTED')
  })
})
