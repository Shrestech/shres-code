import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { JudgmentEngineRegistry, JudgmentError, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentBinaryQuestion,
  JudgmentChoiceQuestion,
  JudgmentFittingInput,
  JudgmentInput,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import ShieldJudgmentEngine, {
  readFittedWireResponse,
  readWireResponse,
  SHIELD_ENGINE_DESCRIPTOR,
  SHIELD_ENGINE_ID,
  toWireRequest,
} from '../src/index.ts'
import type { ShieldJudgmentConfig } from '../src/index.ts'
import { closeMockServers, mockServer, redirectServer } from './mock-server.ts'
import type { MockResponse, MockServer } from './mock-server.ts'


/** A context with a bare engine registry, the one service a provider injects. */
function engineContext(): Context {
  const ctx = new Context()
  ctx.provide('judgmentEngines', new JudgmentEngineRegistry((error: unknown) => {
    throw error
  }))
  return ctx
}

/** The engine this provider registered on `ctx`. */
function engine(ctx: Context): ShieldJudgmentEngine {
  const entry = ctx.judgmentEngines.get(SHIELD_ENGINE_ID)
  if (entry === undefined) throw new Error('the engine is not registered')
  return entry.engine as ShieldJudgmentEngine
}

const MODELS = { fast: 'shield-fast@1', accurate: 'shield-accurate@1' }

const BINARY: JudgmentBinaryQuestion = {
  kind: 'binary',
  id: judgmentQuestionId('urgent'),
  instructions: 'Does this require immediate attention?',
  criteria: { yes: 'immediate attention is required', no: 'it can wait' },
}

const CHOICE: JudgmentChoiceQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('route'),
  instructions: 'Which route is a safe fit?',
  options: [
    { option: 'keep-current', description: 'retain the strong route' },
    { option: 'cheap', description: 'use the lower-cost route' },
  ],
}

const SCORE: JudgmentScoreQuestion = {
  kind: 'score',
  id: judgmentQuestionId('difficulty'),
  instructions: 'How difficult is this turn?',
  levels: ['routine', 'novel', 'hard'],
}

const contexts: Context[] = []

class StubRedactor extends Service {
  static calls = 0

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  redactState(state: string): string {
    StubRedactor.calls += 1
    return state.replaceAll('secret', '[redacted]')
  }
}

/** Redactor fixture whose output proves each fitted candidate is visited once. */
class StatefulRedactor extends Service {
  static inputs: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  redactState(state: string): string {
    StatefulRedactor.inputs.push(state)
    return `${state}|redacted-${StatefulRedactor.inputs.length}`
  }
}

/** Redactor fixture used to preserve provider-error and cancellation classes. */
class ThrowingRedactor extends Service {
  static abortController: AbortController | undefined
  static error = new Error('redactor failed')

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  redactState(_state: string): string {
    ThrowingRedactor.abortController?.abort()
    throw ThrowingRedactor.error
  }
}

/** Redactor fixture that never settles until the caller cancels the ask. */
class NeverResolvingRedactor extends Service {
  static calls = 0

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  redactState(_state: string): Promise<string> {
    NeverResolvingRedactor.calls += 1
    return new Promise<string>(() => {})
  }
}

/** Redactor fixture whose rejected promise must remain observed after cancellation races. */
class RejectingRedactor extends Service {
  static error: unknown = new Error('async redactor failed')

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  async redactState(_state: string): Promise<string> {
    throw RejectingRedactor.error
  }
}

afterEach(async () => {
  StubRedactor.calls = 0
  StatefulRedactor.inputs = []
  ThrowingRedactor.abortController = undefined
  ThrowingRedactor.error = new Error('redactor failed')
  NeverResolvingRedactor.calls = 0
  RejectingRedactor.error = new Error('async redactor failed')
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

/** Start the provider against one deterministic local response script. */
async function harness(
  script: MockResponse[],
  options: { redactor?: boolean; statefulRedactor?: boolean; config?: Partial<ShieldJudgmentConfig> } = {},
): Promise<{ ctx: Context; server: MockServer }> {
  const server = await mockServer(script)
  const ctx = engineContext()
  contexts.push(ctx)
  if (options.statefulRedactor === true) await ctx.plugin(StatefulRedactor)
  else if (options.redactor === true) await ctx.plugin(StubRedactor)
  await ctx.plugin(ShieldJudgmentEngine, {
    endpoint: server.url,
    models: MODELS,
    ...options.config,
  })
  return { ctx, server }
}

/** Valid complete response used as the base for boundary tests. */
function answerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'shield',
    model: MODELS.fast,
    latencyMs: 7.25,
    answers: [
      { kind: 'binary', id: BINARY.id, probability: 0.25 },
      {
        kind: 'choice',
        id: CHOICE.id,
        option: 'cheap',
        probabilities: { 'keep-current': 0.1, cheap: 0.9 },
        confidence: 0.9,
      },
      {
        kind: 'score',
        id: SCORE.id,
        score: 1.0004,
        probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 },
        confidence: 0.5,
      },
    ],
    ...overrides,
  }
}

const FIT_LIMITS = {
  maxSequenceTokens: 128,
  maxHeadTokens: 64,
  maxBatchTokens: 256,
  manifestSha256: 'a'.repeat(64),
}

/** Valid answered response for the atomic fitted endpoint. */
function fittedBody(overrides: {
  fit?: Record<string, unknown> | null
  result?: Record<string, unknown>
} = {}): Record<string, unknown> {
  return {
    kind: 'answered',
    fit: overrides.fit === null ? null : {
      selectedIndex: 1,
      stateTokens: 8,
      sequenceTokens: [20, 24, 28],
      paddedTokens: 84,
      limits: FIT_LIMITS,
      ...overrides.fit,
    },
    result: answerBody(overrides.result),
  }
}

/** Valid explicit capacity rejection for the atomic fitted endpoint. */
function unfitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'unfit',
    engine: 'shield',
    model: MODELS.fast,
    limits: FIT_LIMITS,
    reason: 'state',
    ...overrides,
  }
}

/** One fully typed ask used by transport tests. */
function ask(overrides: Partial<JudgmentInput> = {}): JudgmentInput {
  return {
    state: 'secret route state',
    questions: [BINARY, CHOICE, SCORE],
    tier: 'fast',
    ...overrides,
  }
}

/** One fitted ask with the shared typed questions. */
function fittedAsk(overrides: Partial<JudgmentFittingInput> = {}): JudgmentFittingInput {
  return {
    states: ['first state', 'second state'],
    questions: [BINARY, CHOICE, SCORE],
    tier: 'fast',
    ...overrides,
  }
}

/** Await one provider failure and preserve its stable judgment code. */
async function failure(operation: () => Promise<unknown>): Promise<JudgmentError> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof JudgmentError) return error
    throw error
  }
  throw new Error('the operation resolved instead of failing')
}

describe('ShieldJudgmentEngine', () => {
  it('redacts once, maps the typed ask, and returns the owned identity', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: answerBody() }], { redactor: true })

    const result = await engine(ctx).ask(ask())

    expect(result).toEqual({
      engine: 'shield',
      model: MODELS.fast,
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher is typed as any.
      latencyMs: expect.any(Number),
      answers: [
        { kind: 'binary', id: BINARY.id, probability: 0.25 },
        {
          kind: 'choice',
          id: CHOICE.id,
          option: 'cheap',
          probabilities: { 'keep-current': 0.1, cheap: 0.9 },
          confidence: 0.9,
        },
        {
          kind: 'score',
          id: SCORE.id,
          score: 1.0004,
          probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 },
          confidence: 0.5,
        },
      ],
    })
    expect(StubRedactor.calls).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.method).toBe('POST')
    expect(server.requests[0]?.path).toBe('/v1/judgments')
    expect(server.requests[0]?.body).toEqual({
      state: '[redacted] route state',
      model: MODELS.fast,
      questions: [
        {
          kind: 'binary',
          id: BINARY.id,
          instructions: BINARY.instructions,
          criteria: BINARY.criteria,
        },
        {
          kind: 'choice',
          id: CHOICE.id,
          instructions: CHOICE.instructions,
          options: CHOICE.options,
        },
        {
          kind: 'score',
          id: SCORE.id,
          instructions: SCORE.instructions,
          levels: SCORE.levels,
        },
      ],
    })
  })

  it('resolves an omitted tier to the accurate pinned artifact', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: {
      engine: 'shield', model: MODELS.accurate, latencyMs: 1, answers: [],
    } }])

    const result = await engine(ctx).ask({ state: 'state', questions: [] })

    expect(result.model).toBe(MODELS.accurate)
    expect(server.requests[0]?.body).toMatchObject({ model: MODELS.accurate, questions: [] })
  })

  it('maps HTTP and JSON failures to stable judgment errors', async () => {
    const unavailable = await harness([{ kind: 'text', status: 503, body: 'busy' }])
    const unavailableFailure = await failure(() => engine(unavailable.ctx).ask(ask()))
    expect(unavailableFailure.code).toBe('UNAVAILABLE')
    expect(unavailableFailure.message).toContain('HTTP 503')

    const malformed = await harness([{ kind: 'text', body: 'not json' }])
    const malformedFailure = await failure(() => engine(malformed.ctx).ask(ask()))
    expect(malformedFailure.code).toBe('INVALID_ANSWER')
  })

  it('maps gateway model and response-size violations to INVALID_ANSWER', async () => {
    const mismatched = await harness([{ kind: 'json', body: answerBody({ model: 'other-model' }) }])
    expect((await failure(() => engine(mismatched.ctx).ask(ask()))).code).toBe('INVALID_ANSWER')

    const oversized = await harness(
      [{ kind: 'json', body: answerBody(), headers: { 'content-length': '10000' } }],
      { config: { maxResponseBytes: 100 } },
    )
    const oversizedFailure = await failure(() => engine(oversized.ctx).ask(ask()))
    expect(oversizedFailure.code).toBe('INVALID_ANSWER')
    expect(oversizedFailure.message).toContain('maxResponseBytes 100')

    const streamedOversized = await harness(
      [{ kind: 'json', body: answerBody() }],
      { config: { maxResponseBytes: 100 } },
    )
    const streamedFailure = await failure(() => engine(streamedOversized.ctx).ask(ask()))
    expect(streamedFailure.code).toBe('INVALID_ANSWER')
  })

  it('counts UTF-8, escaped state, and question overhead before sending an oversized request', async () => {
    const state = `😀"\\${'x'.repeat(40)}`
    const serialized = JSON.stringify(toWireRequest(state, MODELS.fast, [BINARY, CHOICE, SCORE]))
    const requestBytes = new TextEncoder().encode(serialized).byteLength
    const { ctx, server } = await harness(
      [{ kind: 'json', body: answerBody() }],
      { config: { maxRequestBytes: requestBytes - 1 } },
    )

    const oversizedFailure = await failure(() => engine(ctx).ask(ask({ state })))

    expect(oversizedFailure.code).toBe('INPUT_TOO_LARGE')
    expect(oversizedFailure.message).toContain(`maxRequestBytes ${requestBytes - 1}`)
    expect(server.requests).toEqual([])
  })

  it('accepts a request whose serialized UTF-8 body is exactly at the configured cap', async () => {
    const state = `😀"\\${'x'.repeat(40)}`
    const serialized = JSON.stringify(toWireRequest(state, MODELS.fast, [BINARY, CHOICE, SCORE]))
    const requestBytes = new TextEncoder().encode(serialized).byteLength
    const { ctx, server } = await harness(
      [{ kind: 'json', body: answerBody() }],
      { config: { maxRequestBytes: requestBytes } },
    )

    await expect(engine(ctx).ask(ask({ state }))).resolves.toMatchObject({ model: MODELS.fast })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.body).toMatchObject({ state, model: MODELS.fast })
  })

  it('classifies caller cancellation separately from the request deadline', async () => {
    const caller = await harness([{ kind: 'stall' }], { config: { timeoutMs: 500 } })
    const controller = new AbortController()
    const pending = engine(caller.ctx).ask(ask({ signal: controller.signal }))
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    controller.abort()
    expect((await failure(() => pending)).code).toBe('ABORTED')

    const deadline = await harness([{ kind: 'stall' }], { config: { timeoutMs: 10 } })
    expect((await failure(() => engine(deadline.ctx).ask(ask()))).code).toBe('UNAVAILABLE')
  })

  it('rejects a pre-cancelled ordinary ask before redaction or HTTP', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: answerBody() }], { statefulRedactor: true })
    const controller = new AbortController()
    controller.abort()

    expect((await failure(() => engine(ctx).ask(ask({ signal: controller.signal })))).code).toBe('ABORTED')
    expect(StatefulRedactor.inputs).toEqual([])
    expect(server.requests).toEqual([])
  })

  it('cancels an ordinary ask while its redactor never resolves', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: answerBody() }])
    await ctx.plugin(NeverResolvingRedactor)
    const controller = new AbortController()
    const pending = engine(ctx).ask(ask({ signal: controller.signal }))

    await Promise.resolve()
    expect(NeverResolvingRedactor.calls).toBe(1)
    controller.abort()

    expect((await failure(() => pending)).code).toBe('ABORTED')
    expect(server.requests).toEqual([])
  })

  it('observes an asynchronous redactor rejection without opening HTTP', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: answerBody() }])
    await ctx.plugin(RejectingRedactor)
    const error = new Error('async redactor failed for this ask')
    RejectingRedactor.error = error
    const controller = new AbortController()

    await expect(engine(ctx).ask(ask({ signal: controller.signal }))).rejects.toBe(error)
    RejectingRedactor.error = 'plain rejection'
    await expect(engine(ctx).ask(ask({ signal: new AbortController().signal }))).rejects.toThrow('plain rejection')
    expect(server.requests).toEqual([])
  })

  it('handles cancellation between the initial check and redactor setup', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: answerBody() }], { statefulRedactor: true })
    const controller = new AbortController()
    const originalAdd = controller.signal.addEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
      originalAdd(type, listener, options)
      controller.abort()
    })

    expect((await failure(() => engine(ctx).ask(ask({ signal: controller.signal })))).code).toBe('ABORTED')
    expect(StatefulRedactor.inputs).toEqual([])
    expect(server.requests).toEqual([])
  })

  it('refuses a redirect before the gateway can forward state to another target', async () => {
    const servers = await redirectServer()
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, {
      endpoint: servers.redirect.url,
      models: MODELS,
      timeoutMs: 500,
    })

    const redirectFailure = await failure(() => engine(ctx).ask(ask()))

    expect(redirectFailure.code).toBe('UNAVAILABLE')
    expect(servers.targetRequests()).toBe(0)
  })

  it('classifies a refused connection as unavailable', async () => {
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, {
      endpoint: 'http://127.0.0.1:1',
      models: MODELS,
      timeoutMs: 500,
    })

    expect((await failure(() => engine(ctx).ask(ask()))).code).toBe('UNAVAILABLE')
  })

  it('handles a successful response with no body stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: null,
      headers: new Headers(),
      text: async () => 'x'.repeat(101),
    } as unknown as Response)))
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, {
      endpoint: 'http://127.0.0.1:8765',
      models: MODELS,
      maxResponseBytes: 100,
    })

    expect((await failure(() => engine(ctx).ask(ask()))).code).toBe('INVALID_ANSWER')

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: null,
      headers: new Headers(),
      text: async () => { throw new Error('body read failed') },
    } as unknown as Response)))
    const failedBody = engineContext()
    contexts.push(failedBody)
    await failedBody.plugin(ShieldJudgmentEngine, {
      endpoint: 'http://127.0.0.1:8765',
      models: MODELS,
    })
    expect((await failure(() => engine(failedBody).ask(ask()))).code).toBe('UNAVAILABLE')

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: null,
      headers: new Headers(),
      text: async () => JSON.stringify(answerBody({ answers: [] })),
    } as unknown as Response)))
    const emptyBody = engineContext()
    contexts.push(emptyBody)
    await emptyBody.plugin(ShieldJudgmentEngine, {
      endpoint: 'http://127.0.0.1:8765',
      models: MODELS,
    })
    expect((await failure(() => engine(emptyBody).ask(ask()))).code).toBe('INVALID_ANSWER')
    vi.unstubAllGlobals()
  })

  it('classifies a body read failure and invalid UTF-8', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('body broke')) },
    }), { status: 200 })))
    const failedRead = engineContext()
    contexts.push(failedRead)
    await failedRead.plugin(ShieldJudgmentEngine, {
      endpoint: 'http://127.0.0.1:8765',
      models: MODELS,
    })
    expect((await failure(() => engine(failedRead).ask(ask()))).code).toBe('UNAVAILABLE')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xff]), { status: 200 })))
    const invalidUtf8 = engineContext()
    contexts.push(invalidUtf8)
    await invalidUtf8.plugin(ShieldJudgmentEngine, {
      endpoint: 'http://127.0.0.1:8765',
      models: MODELS,
    })
    expect((await failure(() => engine(invalidUtf8).ask(ask()))).code).toBe('INVALID_ANSWER')
    vi.unstubAllGlobals()
  })

  it('fits redacted candidates once, selects the reported state, and asks the fitted endpoint', async () => {
    const { ctx, server } = await harness(
      [{ kind: 'json', body: fittedBody() }],
      { statefulRedactor: true },
    )
    const fitting = engine(ctx).fitting
    if (fitting === undefined) throw new Error('Shield provider did not expose fitting')

    const result = await fitting.ask(fittedAsk({ states: ['short secret', 'longer secret state'] }))

    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered') throw new Error('expected an answered fit')
    expect(result.fit).toMatchObject({
      selectedIndex: 1,
      state: 'longer secret state|redacted-2',
      stateTokens: 8,
      sequenceTokens: [20, 24, 28],
      paddedTokens: 84,
      limits: FIT_LIMITS,
    })
    expect(result.result.model).toBe(MODELS.fast)
    expect(StatefulRedactor.inputs).toEqual(['short secret', 'longer secret state'])
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/judgments/fitted',
      body: {
        states: ['short secret|redacted-1', 'longer secret state|redacted-2'],
        model: MODELS.fast,
      },
    })
  })

  it('returns an explicit unfit result without asking inference', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: unfitBody() }])
    const fitting = engine(ctx).fitting
    if (fitting === undefined) throw new Error('Shield provider did not expose fitting')

    await expect(fitting.ask(fittedAsk())).resolves.toEqual({
      kind: 'unfit',
      engine: 'shield',
      model: MODELS.fast,
      limits: FIT_LIMITS,
      reason: 'state',
    })
    expect(server.requests[0]?.path).toBe('/v1/judgments/fitted')
  })

  it('rejects a pre-cancelled fitted ask before redacting candidates', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: fittedBody() }], { statefulRedactor: true })
    const fitting = engine(ctx).fitting
    if (fitting === undefined) throw new Error('Shield provider did not expose fitting')
    const controller = new AbortController()
    controller.abort()

    expect((await failure(() => fitting.ask(fittedAsk({ signal: controller.signal })))).code).toBe('ABORTED')
    expect(StatefulRedactor.inputs).toEqual([])
    expect(server.requests).toEqual([])
  })

  it('preserves a redactor failure and classifies one that aborts the caller', async () => {
    const ordinaryFailure = await harness([{ kind: 'json', body: fittedBody() }])
    await ordinaryFailure.ctx.plugin(ThrowingRedactor)
    const ordinaryFitting = engine(ordinaryFailure.ctx).fitting
    if (ordinaryFitting === undefined) throw new Error('Shield provider did not expose fitting')
    const ordinaryError = new Error('ordinary redactor failed')
    ThrowingRedactor.error = ordinaryError
    await expect(ordinaryFitting.ask(fittedAsk())).rejects.toBe(ordinaryError)

    const cancelled = await harness([{ kind: 'json', body: fittedBody() }])
    await cancelled.ctx.plugin(ThrowingRedactor)
    const cancelledFitting = engine(cancelled.ctx).fitting
    if (cancelledFitting === undefined) throw new Error('Shield provider did not expose fitting')
    const controller = new AbortController()
    ThrowingRedactor.error = new Error('cancelled redactor failed')
    ThrowingRedactor.abortController = controller
    expect((await failure(() => cancelledFitting.ask(fittedAsk({ signal: controller.signal })))).code).toBe('ABORTED')
  })

  it('rejects fitted selection, counts, limits, and identity mismatches', async () => {
    const bodies = [
      null,
      { kind: 'other' },
      fittedBody({ fit: { selectedIndex: 2 } }),
      fittedBody({ fit: { sequenceTokens: [20] } }),
      fittedBody({ fit: { sequenceTokens: 'not-an-array' } }),
      fittedBody({ fit: { paddedTokens: 1 } }),
      fittedBody({ fit: { stateTokens: 129 } }),
      fittedBody({ fit: { sequenceTokens: [0, 24, 28] } }),
      fittedBody({ fit: { sequenceTokens: [4, 24, 28] } }),
      fittedBody({ fit: null }),
      fittedBody({ fit: { limits: { ...FIT_LIMITS, manifestSha256: 'bad' } } }),
      fittedBody({ fit: { limits: null } }),
      fittedBody({ fit: { limits: { ...FIT_LIMITS, maxBatchTokens: 80 } } }),
      fittedBody({ result: { engine: 'other-engine' } }),
      fittedBody({ result: { model: 'other-model' } }),
      unfitBody({ engine: 'other-engine' }),
      unfitBody({ model: 7 }),
      unfitBody({ model: '' }),
      unfitBody({ model: 'other-model' }),
      unfitBody({ reason: 'unknown' }),
      unfitBody({ limits: { ...FIT_LIMITS, maxSequenceTokens: 0 } }),
      unfitBody({ limits: { ...FIT_LIMITS, maxHeadTokens: 0 } }),
      unfitBody({ limits: { ...FIT_LIMITS, maxBatchTokens: 0 } }),
      unfitBody({ limits: { ...FIT_LIMITS, maxBatchTokens: Number.POSITIVE_INFINITY } }),
    ]

    for (const body of bodies) {
      const { ctx } = await harness([{ kind: 'json', body }])
      const fitting = engine(ctx).fitting
      if (fitting === undefined) throw new Error('Shield provider did not expose fitting')
      expect((await failure(() => fitting.ask(fittedAsk()))).code).toBe('INVALID_ANSWER')
    }
  })

  it('accepts every unfit reason and an empty fitted question batch', async () => {
    for (const reason of ['head', 'option', 'batch'] as const) {
      const { ctx } = await harness([{ kind: 'json', body: unfitBody({ reason }) }])
      const fitting = engine(ctx).fitting
      if (fitting === undefined) throw new Error('Shield provider did not expose fitting')
      await expect(fitting.ask(fittedAsk())).resolves.toMatchObject({ kind: 'unfit', reason })
    }

    const result = readFittedWireResponse({
      kind: 'answered',
      fit: {
        selectedIndex: 0,
        stateTokens: 2,
        sequenceTokens: [],
        paddedTokens: 0,
        limits: FIT_LIMITS,
      },
      result: answerBody({ answers: [] }),
    }, ['empty-question-state'], [], MODELS.fast)
    expect(result).toMatchObject({ kind: 'answered', fit: { selectedIndex: 0, state: 'empty-question-state', paddedTokens: 0 } })
  })

  it('does not resolve a fitted result after caller cancellation during body delivery', async () => {
    const body = JSON.stringify(fittedBody())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        }, 30)
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, { endpoint: 'http://127.0.0.1:8765', models: MODELS })
    const fitting = engine(ctx).fitting
    if (fitting === undefined) throw new Error('Shield provider did not expose fitting')
    const controller = new AbortController()
    const pending = fitting.ask(fittedAsk({ signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 5)

    expect((await failure(() => pending)).code).toBe('ABORTED')
    vi.unstubAllGlobals()
  })

  it('does not resolve an ordinary result after caller cancellation during body delivery', async () => {
    const body = JSON.stringify(answerBody())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        }, 30)
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, { endpoint: 'http://127.0.0.1:8765', models: MODELS })
    const controller = new AbortController()
    const pending = engine(ctx).ask(ask({ signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 5)

    expect((await failure(() => pending)).code).toBe('ABORTED')
    vi.unstubAllGlobals()
  })

  it('removes the caller listener after synchronous redaction completes', async () => {
    const { ctx } = await harness([{ kind: 'json', body: answerBody() }])
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    await engine(ctx).ask(ask({ signal: controller.signal }))

    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('cancels a fitted ask while its redactor never resolves', async () => {
    const { ctx, server } = await harness([{ kind: 'json', body: fittedBody() }])
    await ctx.plugin(NeverResolvingRedactor)
    const fitting = engine(ctx).fitting
    if (fitting === undefined) throw new Error('Shield provider did not expose fitting')
    const controller = new AbortController()
    const pending = fitting.ask(fittedAsk({ signal: controller.signal }))

    await Promise.resolve()
    expect(NeverResolvingRedactor.calls).toBe(1)
    controller.abort()

    expect((await failure(() => pending)).code).toBe('ABORTED')
    expect(server.requests).toEqual([])
  })
})

describe('judgment-shield response validation', () => {
  it('maps every typed question form without adding provider fields', () => {
    const binaryYesOnly: JudgmentBinaryQuestion = {
      kind: 'binary', id: judgmentQuestionId('yes-only'), instructions: 'yes', criteria: { yes: 'yes' },
    }
    const binaryNoOnly: JudgmentBinaryQuestion = {
      kind: 'binary', id: judgmentQuestionId('no-only'), instructions: 'no', criteria: { no: 'no' },
    }
    const binaryBare: JudgmentBinaryQuestion = {
      kind: 'binary', id: judgmentQuestionId('bare'), instructions: 'bare',
    }
    const choiceBare: JudgmentChoiceQuestion = {
      kind: 'choice', id: judgmentQuestionId('choice-bare'), instructions: 'choice', options: [{ option: 'a' }, { option: 'b', description: 'b' }],
    }
    expect(toWireRequest('state', MODELS.fast, [binaryYesOnly, binaryNoOnly, binaryBare, choiceBare])).toEqual({
      state: 'state',
      model: MODELS.fast,
      questions: [
        { kind: 'binary', id: 'yes-only', instructions: 'yes', criteria: { yes: 'yes' } },
        { kind: 'binary', id: 'no-only', instructions: 'no', criteria: { no: 'no' } },
        { kind: 'binary', id: 'bare', instructions: 'bare' },
        { kind: 'choice', id: 'choice-bare', instructions: 'choice', options: [{ option: 'a' }, { option: 'b', description: 'b' }] },
      ],
    })
  })

  it('accepts a rounded score expectation and a tied choice argmax', () => {
    const body = answerBody({
      answers: [
        { kind: 'binary', id: BINARY.id, probability: 0.5 },
        {
          kind: 'choice', id: CHOICE.id, option: 'keep-current',
          probabilities: { 'keep-current': 0.5, cheap: 0.5 }, confidence: 0.5,
        },
        {
          kind: 'score', id: SCORE.id, score: 1.002,
          probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 }, confidence: 0.5,
        },
      ],
    })
    expect(readWireResponse(body, [BINARY, CHOICE, SCORE], MODELS.fast).answers).toHaveLength(3)
  })

  it('rejects a non-argmax choice, incomplete distribution, and mismatched score', () => {
    const base = answerBody().answers as unknown[]
    const nonArgmax = answerBody({ answers: [
      { kind: 'binary', id: BINARY.id, probability: 0.5 },
      {
        kind: 'choice', id: CHOICE.id, option: 'keep-current',
        probabilities: { 'keep-current': 0.1, cheap: 0.9 }, confidence: 0.5,
      },
      base[2],
    ] })
    expect(() => readWireResponse(nonArgmax, [BINARY, CHOICE, SCORE], MODELS.fast))
      .toThrow(/argmax/)

    const incomplete = answerBody({ answers: [
      base[0],
      {
        kind: 'choice', id: CHOICE.id, option: 'cheap',
        probabilities: { cheap: 1 }, confidence: 1,
      },
      base[2],
    ] })
    expect(() => readWireResponse(incomplete, [BINARY, CHOICE, SCORE], MODELS.fast))
      .toThrow(/exactly one probability/)

    const scoreMismatch = answerBody({ answers: [
      base[0],
      base[1],
      {
        kind: 'score', id: SCORE.id, score: 0,
        probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 }, confidence: 0.5,
      },
    ] })
    expect(() => readWireResponse(scoreMismatch, [BINARY, CHOICE, SCORE], MODELS.fast))
      .toThrow(/probability expectation/)
  })

  it('rejects non-normalized, unknown, and out-of-range distributions', () => {
    const base = answerBody().answers as unknown[]
    const cases: unknown[] = [
      answerBody({ answers: [
        base[0],
        { kind: 'choice', id: CHOICE.id, option: 'cheap', probabilities: { 'keep-current': 0.2, cheap: 0.2 }, confidence: 1 },
        base[2],
      ] }),
      answerBody({ answers: [
        base[0],
        { kind: 'choice', id: CHOICE.id, option: 'cheap', probabilities: { 'keep-current': 0, cheap: 0.5, extra: 0.5 }, confidence: 1 },
        base[2],
      ] }),
      answerBody({ answers: [
        { kind: 'binary', id: BINARY.id, probability: 2 }, base[1], base[2],
      ] }),
    ]
    for (const body of cases) {
      expect(() => readWireResponse(body, [BINARY, CHOICE, SCORE], MODELS.fast))
        .toThrow(/judgment-shield response/)
    }

    const prototypeOption: JudgmentChoiceQuestion = {
      kind: 'choice',
      id: judgmentQuestionId('prototype-option'),
      instructions: 'choose',
      options: [{ option: '__proto__' }, { option: 'ordinary' }],
    }
    const prototypeProbabilities = Object.fromEntries([
      ['__proto__', 0.9],
      ['ordinary', 0.1],
    ])
    expect(readWireResponse({
      engine: 'shield', model: MODELS.fast, latencyMs: 1,
      answers: [{
        kind: 'choice', id: prototypeOption.id, option: '__proto__',
        probabilities: prototypeProbabilities, confidence: 0.9,
      }],
    }, [prototypeOption], MODELS.fast).answers[0]).toMatchObject({ option: '__proto__' })
  })

  it('rejects malformed response envelopes and answer identities', () => {
    const validAnswers = answerBody().answers as unknown[]
    const malformed: unknown[] = [
      null,
      { engine: 'wrong', model: MODELS.fast, latencyMs: 1, answers: [] },
      { engine: 'shield', model: '', latencyMs: 1, answers: [] },
      { engine: 'shield', model: MODELS.fast, latencyMs: -1, answers: [] },
      { engine: 'shield', model: MODELS.fast, latencyMs: 1, answers: 'no' },
      { engine: 'shield', model: MODELS.fast, latencyMs: 1, answers: [] },
      answerBody({ answers: [{}, validAnswers[1], validAnswers[2]] }),
      answerBody({ answers: [validAnswers[0], validAnswers[0], validAnswers[2]] }),
      answerBody({ answers: [validAnswers[0], { ...validAnswers[1] as object, id: 'unknown' }, validAnswers[2]] }),
    ]
    for (const body of malformed) {
      expect(() => readWireResponse(body, [BINARY, CHOICE, SCORE], MODELS.fast))
        .toThrow(/judgment-shield response/)
    }
  })

  it('rejects mismatched answer kinds and invalid scalar fields', () => {
    const base = answerBody().answers as unknown[]
    const mismatch: unknown[] = [
      answerBody({ answers: [{ kind: 'choice', id: BINARY.id, option: 'cheap' }, base[1], base[2]] }),
      answerBody({ answers: [base[0], { kind: 'score', id: CHOICE.id }, base[2]] }),
      answerBody({ answers: [base[0], base[1], { kind: 'binary', id: SCORE.id, probability: 0.5 }] }),
      answerBody({ answers: [{ id: BINARY.id, probability: 0.5 }, base[1], base[2]] }),
      answerBody({ answers: [{ kind: 'binary', id: BINARY.id, probability: Number.NaN }, base[1], base[2]] }),
      answerBody({ answers: [{ kind: 'binary', id: BINARY.id, probability: 0.5 }, { kind: 'choice', id: CHOICE.id, option: 'missing', probabilities: { 'keep-current': 0.5, cheap: 0.5 }, confidence: 0.5 }, base[2]] }),
      answerBody({ answers: [{ kind: 'binary', id: BINARY.id, probability: 0.5 }, { kind: 'choice', id: CHOICE.id, option: 7, probabilities: { 'keep-current': 0.5, cheap: 0.5 }, confidence: 0.5 }, base[2]] }),
      answerBody({ answers: [base[0], { kind: 'choice', id: CHOICE.id, option: 'cheap', probabilities: { 'keep-current': 0.5, cheap: 0.5 }, confidence: 2 }, base[2]] }),
      answerBody({ answers: [base[0], base[1], { kind: 'score', id: SCORE.id, score: 1, probabilities: undefined, confidence: 0.5 }] }),
      answerBody({ answers: [base[0], base[1], { kind: 'score', id: SCORE.id, score: -0.1, probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 }, confidence: 0.5 }] }),
      answerBody({ answers: [base[0], base[1], { kind: 'score', id: SCORE.id, score: 3.1, probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 }, confidence: 0.5 }] }),
      answerBody({ answers: [base[0], base[1], { kind: 'score', id: SCORE.id, score: 1, probabilities: { '0': 0.5, '1': 0.5, '2': 0 }, confidence: Number.NaN }] }),
    ]
    for (const body of mismatch) {
      expect(() => readWireResponse(body, [BINARY, CHOICE, SCORE], MODELS.fast))
        .toThrow(/judgment-shield response/)
    }
  })
})

describe('engine registration', () => {
  it('registers as a local fitting engine naming its models and destination, and withdraws when its own fiber disposes', async () => {
    const server = await mockServer([])
    const ctx = engineContext()
    contexts.push(ctx)
    const provider = await ctx.plugin(ShieldJudgmentEngine, { endpoint: server.url, models: MODELS })

    const entry = ctx.judgmentEngines.get(SHIELD_ENGINE_ID)
    expect(entry?.engine).toBeInstanceOf(ShieldJudgmentEngine)
    expect(entry?.engine.fitting).toBeDefined()
    expect(entry?.status()).toEqual({ state: 'ready' })
    expect(ctx.judgmentEngines.list()).toEqual([{
      ...SHIELD_ENGINE_DESCRIPTOR,
      models: MODELS,
      destination: new URL(server.url).host,
    }])
    expect(server.requests).toEqual([])

    await provider.dispose()

    expect(ctx.judgmentEngines.get(SHIELD_ENGINE_ID)).toBeUndefined()
  })
})

describe('gateway readiness', () => {
  /** A loopback port nothing listens on: a server's port, released. */
  async function closedPort(): Promise<string> {
    const server = await mockServer([])
    const url = server.url
    await server.close()
    return url
  }

  /** The registry status of the Shield engine. */
  function statusOf(ctx: Context): unknown {
    return ctx.judgmentEngines.get(SHIELD_ENGINE_ID)?.status()
  }

  it('finishes loading unavailable, naming the refused connection, when nothing listens', async () => {
    const url = await closedPort()
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, { endpoint: url, models: MODELS })

    const status = statusOf(ctx) as { state: string; detail?: string }
    expect(status.state).toBe('unavailable')
    expect(status.detail).toMatch(new RegExp(`^judgment-shield: the gateway at ${new URL(url).host} is not accepting connections: .*ECONNREFUSED`))
  })

  it('reports ready once a gateway starts listening, on a status read', async () => {
    const url = await closedPort()
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, { endpoint: url, models: MODELS })
    expect(statusOf(ctx)).toMatchObject({ state: 'unavailable' })
    const { createServer } = await import('node:net')
    const listener = createServer(socket => socket.destroy())
    await new Promise<void>((resolve) => {
      listener.listen(Number(new URL(url).port), '127.0.0.1', resolve)
    })
    try {
      await vi.waitFor(() => {
        expect(statusOf(ctx)).toEqual({ state: 'ready' })
      })
    } finally {
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve()
        })
      })
    }
  })

  it('re-probes on its interval and announces a gateway that stopped', async () => {
    const server = await mockServer([])
    const ctx = engineContext()
    contexts.push(ctx)
    let announced = 0
    ctx.judgmentEngines.subscribe(() => {
      announced += 1
    })
    await ctx.plugin(ShieldJudgmentEngine, { endpoint: server.url, models: MODELS, readinessIntervalMs: 20 })
    expect(statusOf(ctx)).toEqual({ state: 'ready' })
    const before = announced

    await server.close()

    await vi.waitFor(() => {
      expect(announced).toBeGreaterThan(before)
      expect((ctx.judgmentEngines.get(SHIELD_ENGINE_ID)?.status() as { state: string }).state).toBe('unavailable')
    })
  })

  it('reports ready after an answered ask and fitted ask, and leaves a failed ask to the probe', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody() },
      { kind: 'json', status: 500, body: { error: 'boom' } },
      { kind: 'json', status: 200, body: fittedBody() },
    ])
    expect(statusOf(ctx)).toEqual({ state: 'ready' })

    await engine(ctx).ask(ask())
    await failure(() => engine(ctx).ask(ask()))
    expect(statusOf(ctx)).toEqual({ state: 'ready' })
    await engine(ctx).fitting.ask(fittedAsk())
    expect(statusOf(ctx)).toEqual({ state: 'ready' })
  })

  it('probes after an UNAVAILABLE ask, reporting a gateway that went away before the interval', async () => {
    const server = await mockServer([])
    const ctx = engineContext()
    contexts.push(ctx)
    await ctx.plugin(ShieldJudgmentEngine, { endpoint: server.url, models: MODELS })
    expect(statusOf(ctx)).toEqual({ state: 'ready' })

    await server.close()
    const error = await failure(() => engine(ctx).ask(ask()))

    expect(error.code).toBe('UNAVAILABLE')
    await vi.waitFor(() => {
      expect(statusOf(ctx)).toMatchObject({ state: 'unavailable' })
    })
  })
})
