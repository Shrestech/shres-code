import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { credentialRef } from '@shres-code/shres-code-credentials'
import { JudgmentError, judgmentQuestionId } from '@shres-code/shres-code-judgment'
import type {
  JudgmentBinaryQuestion,
  JudgmentChoiceQuestion,
  JudgmentScoreQuestion,
} from '@shres-code/shres-code-judgment'
import { MAX_TIMER_DELAY_MS } from '@shres-code/shres-code-timeout'
import TypesafeJudgmentEngine, {
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODELS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_STATUSES,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  retryWait,
} from '../src/index.ts'
import type { TypesafeJudgmentConfig } from '../src/index.ts'
import { MemoryCredentials } from './credentials-memory.ts'
import { closeMockServers, mockServer } from './mock-server.ts'
import type { Behavior, MockServer } from './mock-server.ts'

const API_KEY_REF = 'TYPESAFE_API_KEY'
const ANSWERED_MODEL = 'jev-latest-2026-05-01'

const BINARY: JudgmentBinaryQuestion = {
  kind: 'binary',
  id: judgmentQuestionId('urgent'),
  instructions: 'Does this convey urgency?',
}

const CHOICE: JudgmentChoiceQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('severity'),
  instructions: 'How severe is this?',
  options: [{ option: 'low', description: 'no action needed' }, { option: 'high' }],
}

const SCORE: JudgmentScoreQuestion = {
  kind: 'score',
  id: judgmentQuestionId('difficulty'),
  instructions: 'How hard is this?',
  levels: ['trivial', 'routine', 'novel'],
}

const contexts: Context[] = []
const redactions = { count: 0 }

/** Response body for one scripted answer, with the vendor's usage envelope. */
function answerBody(answers: Record<string, unknown>, model = ANSWERED_MODEL): string {
  return JSON.stringify({ model, answers, usage: { input_tokens: 128, output_tokens: 0 } })
}

/** Deployment egress hook: counts its consultations and replaces `secret`. */
class StubRedactor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  async redactState(state: string): Promise<string> {
    redactions.count += 1
    await Promise.resolve()
    return state.replaceAll('secret', '[redacted]')
  }
}

interface HarnessOptions {
  config?: Partial<TypesafeJudgmentConfig>
  seed?: Record<string, string>
  credentials?: boolean
  redactor?: boolean
}

/** Mount the engine against a loopback stub with a memory credentials provider. */
async function harness(
  script: Behavior[],
  options: HarnessOptions = {},
): Promise<{ ctx: Context; server: MockServer }> {
  redactions.count = 0
  const server = await mockServer(script)
  const ctx = new Context()
  contexts.push(ctx)
  if (options.credentials !== false) {
    await ctx.plugin(MemoryCredentials, options.seed ?? { [API_KEY_REF]: 'key-one' })
  }
  if (options.redactor === true) await ctx.plugin(StubRedactor)
  await ctx.plugin(TypesafeJudgmentEngine, { apiKeyRef: API_KEY_REF, endpoint: server.url, ...options.config })
  return { ctx, server }
}

/** Dispose one context now and drop it from the afterEach sweep. */
async function disposeContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

/** The failure one ask rejected with, asserted to be a judgment failure. */
async function askFailure(ask: () => Promise<unknown>): Promise<JudgmentError> {
  try {
    await ask()
  } catch (error: unknown) {
    if (error instanceof JudgmentError) return error
    throw error
  }
  throw new Error('the ask resolved instead of failing')
}

/** The wire body of one recorded request. */
function wireBody(server: MockServer, index = 0): Record<string, unknown> {
  const request = server.requests[index]
  if (request === undefined) throw new Error(`the stub server recorded no request at index ${index}`)
  return request.body as Record<string, unknown>
}

/** One recorded request's wire questions, keyed by question id. */
function wireQuestions(server: MockServer, index = 0): Record<string, Record<string, unknown>> {
  return wireBody(server, index).questions as Record<string, Record<string, unknown>>
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

describe('resolveConfig', () => {
  it('resolves every omitted field from its default', () => {
    expect(resolveConfig({ apiKeyRef: API_KEY_REF })).toEqual({
      apiKeyRef: API_KEY_REF,
      endpoint: DEFAULT_ENDPOINT,
      models: DEFAULT_MODELS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retry: {
        maxRetries: DEFAULT_MAX_RETRIES,
        delayMs: DEFAULT_RETRY_DELAY_MS,
        statuses: [...DEFAULT_RETRY_STATUSES],
      },
    })
  })

  it('keeps explicit values and drops trailing slashes from the endpoint', () => {
    expect(resolveConfig({
      apiKeyRef: API_KEY_REF,
      endpoint: 'http://127.0.0.1:1234/',
      models: { fast: 'fast-id', accurate: 'accurate-id' },
      timeoutMs: 1_000,
      retry: { maxRetries: 3, delayMs: 50, statuses: [503] },
    })).toEqual({
      apiKeyRef: API_KEY_REF,
      endpoint: 'http://127.0.0.1:1234',
      models: { fast: 'fast-id', accurate: 'accurate-id' },
      timeoutMs: 1_000,
      retry: { maxRetries: 3, delayMs: 50, statuses: [503] },
    })
  })

  it('retries only the vendor documented transient statuses by default', () => {
    expect(DEFAULT_RETRY_STATUSES).toEqual([429, 529])
    expect(DEFAULT_MAX_RETRIES).toBe(1)
    expect(DEFAULT_RETRY_DELAY_MS).toBe(300)
  })

  it('detaches the resolved retry policy from the caller list', () => {
    const statuses = [503]
    const resolved = resolveConfig({ apiKeyRef: API_KEY_REF, retry: { statuses } })

    statuses.push(500)

    expect(resolved.retry.statuses).toEqual([503])
  })

  it('rejects an unknown key inside the retry entry by name', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, retry: { attempts: 2 } as never }))
      .toThrow(/TypesafeJudgmentConfig.retry: unknown key "attempts"/)
  })

  it('rejects a retry budget that is not a non-negative safe integer', () => {
    for (const maxRetries of [-1, 1.5, 'twice']) {
      expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, retry: { maxRetries } as never }))
        .toThrow(/retry.maxRetries must be a non-negative safe integer/)
    }
  })

  it('rejects a retry wait that is negative, non-finite, or unschedulable', () => {
    for (const delayMs of [-1, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, retry: { delayMs } }))
        .toThrow(new RegExp('retry.delayMs must be a non-negative finite number no greater than ' + String(MAX_TIMER_DELAY_MS)))
    }
  })

  it('rejects a retry status outside the HTTP range', () => {
    for (const statuses of [[99], [600], [429.5], ['429']]) {
      expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, retry: { statuses } as never }))
        .toThrow(/retry.statuses must hold HTTP statuses from 100 through 599/)
    }
  })

  it('rejects a positive retry budget with no status to spend it on, and accepts a disabled one', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, retry: { maxRetries: 1, statuses: [] } }))
      .toThrow(/maxRetries is 1 while no status is retryable/)
    // Disabled retry keeps an empty list coherent.
    expect(resolveConfig({ apiKeyRef: API_KEY_REF, retry: { maxRetries: 0, statuses: [] } }).retry)
      .toEqual({ maxRetries: 0, delayMs: DEFAULT_RETRY_DELAY_MS, statuses: [] })
  })

  it('rejects an unknown key by name', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, timeout: 10 } as never))
      .toThrow(/TypesafeJudgmentConfig: unknown key "timeout"/)
  })

  it('rejects a missing or non-string credential reference', () => {
    expect(() => resolveConfig({} as never)).toThrow(/apiKeyRef must be a non-empty string/)
    expect(() => resolveConfig({ apiKeyRef: '' })).toThrow(/apiKeyRef must be a non-empty string/)
    expect(() => resolveConfig({ apiKeyRef: 7 } as never)).toThrow(/apiKeyRef must be a non-empty string/)
  })

  it('rejects an endpoint with no usable base', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, endpoint: '/' }))
      .toThrow(/endpoint must be a non-empty string/)
  })

  it('rejects an empty model id for either tier', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, models: { fast: '', accurate: 'accurate-id' } }))
      .toThrow(/models\.fast must be a non-empty string/)
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, models: { fast: 'fast-id' } as never }))
      .toThrow(/models\.accurate must be a non-empty string/)
  })

  it('rejects a deadline that is not a positive finite number', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, timeoutMs: 'soon' } as never))
      .toThrow(/timeoutMs must be a positive finite number/)
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, timeoutMs: 0 }))
      .toThrow(/timeoutMs must be a positive finite number/)
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, timeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a deadline above the largest schedulable timer', () => {
    expect(() => resolveConfig({ apiKeyRef: API_KEY_REF, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(`timeoutMs (${MAX_TIMER_DELAY_MS + 1}) must be no greater than ${MAX_TIMER_DELAY_MS}`)
  })
})

describe('request mapping', () => {
  it('posts the ask to the vendor path with the bearer key and the resolved model', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.8 } }) },
    ])

    await ctx.judgment.ask({
      state: 'payments are failing',
      questions: [{ ...BINARY, criteria: { yes: 'act now', no: 'wait' } }],
    })

    const request = server.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/v1/systemone')
    expect(request?.headers.authorization).toBe('Bearer key-one')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(wireBody(server)).toEqual({
      state: 'payments are failing',
      model: 'jev-latest',
      questions: {
        urgent: {
          type: 'noul',
          instructions: 'Does this convey urgency?',
          criteria: { true: 'act now', false: 'wait' },
        },
      },
    })
  })

  it('omits noul criteria when the question carries none', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    await ctx.judgment.ask({ state: 'state', questions: [BINARY] })

    expect(wireQuestions(server).urgent).toEqual({
      type: 'noul',
      instructions: 'Does this convey urgency?',
    })
  })

  it('omits noul criteria when the question carries an empty criteria object', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    await ctx.judgment.ask({ state: 'state', questions: [{ ...BINARY, criteria: {} }] })

    expect(wireQuestions(server).urgent).not.toHaveProperty('criteria')
  })

  it('maps only the criteria side the question set', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    await ctx.judgment.ask({ state: 'state', questions: [{ ...BINARY, criteria: { no: 'wait' } }] })

    expect(wireQuestions(server).urgent?.criteria).toEqual({ false: 'wait' })
  })

  it('maps a choice question to one criteria entry per option, null without a description', async () => {
    const { ctx, server } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          severity: { type: 'choice', choice: 'low', probabilities: { low: 0.9, high: 0.1 }, confidence: 0.9 },
        }),
      },
    ])

    await ctx.judgment.ask({ state: 'state', questions: [CHOICE] })

    expect(wireQuestions(server).severity).toEqual({
      type: 'choice',
      instructions: 'How severe is this?',
      criteria: { low: 'no action needed', high: null },
    })
  })

  it('maps a score question to its ordered levels', async () => {
    const { ctx, server } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          difficulty: {
            type: 'score',
            score: 1.4,
            legend: { '0': 'trivial', '1': 'routine' },
            probabilities: { '0': 0.6, '1': 0.4 },
            confidence: 0.9,
          },
        }),
      },
    ])

    await ctx.judgment.ask({ state: 'state', questions: [SCORE] })

    expect(wireQuestions(server).difficulty).toEqual({
      type: 'score',
      instructions: 'How hard is this?',
      criteria: ['trivial', 'routine', 'novel'],
    })
  })

  it('maps each tier to its own model and an omitted tier to the accurate model', async () => {
    const answered = answerBody({ urgent: { type: 'noul', noul: 0.5 } })
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answered },
      { kind: 'json', status: 200, body: answered },
      { kind: 'json', status: 200, body: answered },
    ])

    await ctx.judgment.ask({ state: 'state', questions: [BINARY], tier: 'fast' })
    await ctx.judgment.ask({ state: 'state', questions: [BINARY], tier: 'accurate' })
    await ctx.judgment.ask({ state: 'state', questions: [BINARY] })

    expect(server.requests.map(request => (request.body as { model: string }).model))
      .toEqual(['jev-preview', 'jev-latest', 'jev-latest'])
  })

  it('maps a tier through the configured model mapping', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ], { config: { models: { fast: 'fast-id', accurate: 'accurate-id' } } })

    await ctx.judgment.ask({ state: 'state', questions: [BINARY], tier: 'fast' })

    expect(wireBody(server).model).toBe('fast-id')
  })
})

describe('response mapping', () => {
  it('maps a noul answer to a binary answer', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.83 } }) },
    ])

    const result = await ctx.judgment.ask({ state: 'state', questions: [BINARY] })

    expect(result.answers).toEqual([{ kind: 'binary', id: 'urgent', probability: 0.83 }])
  })

  it('maps a choice answer to a choice answer with its distribution', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          severity: { type: 'choice', choice: 'high', probabilities: { low: 0.2, high: 0.8 }, confidence: 0.75 },
        }),
      },
    ])

    const result = await ctx.judgment.ask({ state: 'state', questions: [CHOICE] })

    expect(result.answers).toEqual([{
      kind: 'choice',
      id: 'severity',
      option: 'high',
      probabilities: { low: 0.2, high: 0.8 },
      confidence: 0.75,
    }])
  })

  it('maps a score answer keyed by level index and drops the legend', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          difficulty: {
            type: 'score',
            score: 1.4,
            legend: { '0': 'trivial', '1': 'routine' },
            probabilities: { '0': 0.6, '1': 0.4 },
            confidence: 0.9,
          },
        }),
      },
    ])

    const result = await ctx.judgment.ask({ state: 'state', questions: [SCORE] })

    expect(result.answers).toEqual([{
      kind: 'score',
      id: 'difficulty',
      score: 1.4,
      probabilities: { '0': 0.6, '1': 0.4 },
      confidence: 0.9,
    }])
  })

  it('answers in the order the questions were asked', async () => {
    const { ctx, server } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          urgent: { type: 'noul', noul: 0.4 },
          severity: { type: 'choice', choice: 'low', probabilities: { low: 0.6, high: 0.4 }, confidence: 0.6 },
        }),
      },
    ])

    const result = await ctx.judgment.ask({ state: 'state', questions: [CHOICE, BINARY] })

    expect(Object.keys(wireQuestions(server))).toEqual(['severity', 'urgent'])
    expect(result.answers.map(answer => answer.id)).toEqual(['severity', 'urgent'])
  })

  it('accepts a response with no usage envelope', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: JSON.stringify({ model: ANSWERED_MODEL, answers: { urgent: { type: 'noul', noul: 0.2 } } }),
      },
    ])

    const result = await ctx.judgment.ask({ state: 'state', questions: [BINARY] })

    expect(result.answers).toEqual([{ kind: 'binary', id: 'urgent', probability: 0.2 }])
  })

  it('reports the engine, the response model id, and a whole-millisecond latency', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    const result = await ctx.judgment.ask({ state: 'state', questions: [BINARY], tier: 'accurate' })

    expect(result.engine).toBe('typesafe')
    expect(result.model).toBe(ANSWERED_MODEL)
    expect(Number.isInteger(result.latencyMs)).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('response validation', () => {
  it('rejects an answer whose discriminant does not match the question', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          urgent: { type: 'choice', choice: 'low', probabilities: { low: 1 }, confidence: 1 },
        }),
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('with type "choice" instead of "noul"')
  })

  it('rejects an answer carrying no discriminant at all', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { noul: 0.5 } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('with type "no type" instead of "noul"')
  })

  it('rejects a response that answers none of the questions', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({}) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('has no answer for question "urgent"')
  })

  it('rejects a body that is not JSON', async () => {
    const { ctx } = await harness([{ kind: 'malformed', status: 200, body: 'not json at all' }])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('body is not JSON')
  })

  it('rejects a JSON body that is not an object', async () => {
    const { ctx } = await harness([{ kind: 'json', status: 200, body: '[1, 2]' }])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('body is not a JSON object')
  })

  it('rejects a response without a usable model id', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: JSON.stringify({ model: '', answers: {} }) },
      { kind: 'json', status: 200, body: JSON.stringify({ model: 7, answers: {} }) },
    ])

    const empty = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))
    const numeric = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(empty.code).toBe('INVALID_ANSWER')
    expect(empty.message).toContain('has no model id')
    expect(numeric.code).toBe('INVALID_ANSWER')
    expect(numeric.message).toContain('has no model id')
  })

  it('rejects a response without an answers object', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: JSON.stringify({ model: ANSWERED_MODEL }) },
      { kind: 'json', status: 200, body: JSON.stringify({ model: ANSWERED_MODEL, answers: [] }) },
    ])

    const absent = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))
    const array = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(absent.message).toContain('has no answers object')
    expect(array.message).toContain('has no answers object')
  })

  it('rejects a choice answer naming an option the question did not offer', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          severity: { type: 'choice', choice: 'critical', probabilities: { critical: 1 }, confidence: 1 },
        }),
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [CHOICE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('with option "critical", which it was not asked')
  })

  it('rejects a choice answer that names no option', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({ severity: { type: 'choice', probabilities: { low: 1 }, confidence: 1 } }),
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [CHOICE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('with no option')
  })

  it('rejects a noul answer that is not a number', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 'high' } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('non-finite noul')
  })

  it('rejects a noul answer that is not finite', async () => {
    const { ctx } = await harness([
      {
        kind: 'malformed',
        status: 200,
        body: `{"model":"${ANSWERED_MODEL}","answers":{"urgent":{"type":"noul","noul":1e400}}}`,
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('non-finite noul')
  })

  it('rejects an answer with no probabilities object', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ severity: { type: 'choice', choice: 'low', confidence: 1 } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [CHOICE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('no probabilities object')
  })

  it('rejects a choice answer missing a requested option probability', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          severity: { type: 'choice', choice: 'low', probabilities: { low: 1 }, confidence: 1 },
        }),
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [CHOICE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('has no probability for option "high"')
  })

  it('rejects a probability entry that is not finite', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          severity: { type: 'choice', choice: 'low', probabilities: { low: 'most' }, confidence: 1 },
        }),
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [CHOICE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('non-finite probability for "low"')
  })

  it('rejects a score answer with no confidence', async () => {
    const { ctx } = await harness([
      {
        kind: 'json',
        status: 200,
        body: answerBody({
          difficulty: { type: 'score', score: 1, probabilities: { '0': 1 } },
        }),
      },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [SCORE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('non-finite confidence')
  })

  it('rejects a score answer whose discriminant is another kind', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ difficulty: { type: 'noul', noul: 0.5 } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [SCORE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('instead of "score"')
  })

  it('rejects a choice answer whose discriminant is another kind', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ severity: { type: 'noul', noul: 0.5 } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [CHOICE] }))

    expect(failure.code).toBe('INVALID_ANSWER')
    expect(failure.message).toContain('instead of "choice"')
  })
})

describe('provider failures', () => {
  it.each([401, 422, 500])('fails UNAVAILABLE on HTTP %i without spending a retry', async (status) => {
    const { ctx, server } = await harness([
      { kind: 'json', status, body: JSON.stringify({ error: { message: `refused ${status}` } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain(`HTTP ${status}`)
    expect(failure.message).toContain(`refused ${status}`)
    // A deterministic refusal is answered from the first response: the vendor's
    // 401 and 422 cannot change on a repeat, and the stub would answer 500 if a
    // second request were sent.
    expect(server.requests).toHaveLength(1)
  })

  it('reads a message from the top level of a JSON error body', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 500, body: JSON.stringify({ message: 'backend is down' }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.message).toContain('HTTP 500')
    expect(failure.message).toContain('backend is down')
  })

  it('reports the status when the error body is not JSON', async () => {
    const { ctx } = await harness([{ kind: 'malformed', status: 502, body: '<html>bad gateway</html>' }])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('HTTP 502')
    expect(failure.message).not.toContain('bad gateway')
  })

  it('reports the status when the error body is JSON that is not an object', async () => {
    const { ctx } = await harness([{ kind: 'json', status: 500, body: 'null' }])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('HTTP 500')
  })

  it('reports the status when the error body carries no message', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 422, body: JSON.stringify({ error: { code: 'validation_failed' } }) },
    ])

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('HTTP 422')
    expect(failure.message).not.toContain('validation_failed')
  })
})

describe('credentials', () => {
  it('fails UNCONFIGURED without a credentials service and sends nothing', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ], { credentials: false })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'secret state', questions: [BINARY] }))

    expect(failure.code).toBe('UNCONFIGURED')
    expect(failure.message).toContain('mount the credentials seam (ctx.credentials)')
    expect(server.requests).toEqual([])
  })

  it('fails UNCONFIGURED when the reference holds no value and sends nothing', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ], { seed: {} })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNCONFIGURED')
    expect(failure.message).toContain(`store ${API_KEY_REF} through the credentials service`)
    expect(server.requests).toEqual([])
  })

  it('fails UNCONFIGURED when the reference resolves to a blank value and sends nothing', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ], { seed: { [API_KEY_REF]: '' } })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNCONFIGURED')
    expect(server.requests).toEqual([])
  })

  it('re-resolves the reference on every ask instead of caching the key', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    await ctx.judgment.ask({ state: 'first', questions: [BINARY] })
    await ctx.credentials.set(credentialRef(API_KEY_REF), 'key-two')
    await ctx.judgment.ask({ state: 'second', questions: [BINARY] })

    expect(server.requests.map(request => request.headers.authorization))
      .toEqual(['Bearer key-one', 'Bearer key-two'])
  })
})

describe('state redaction', () => {
  it('sends the state unchanged when no redactor is composed', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    await ctx.judgment.ask({ state: 'the secret is in the state', questions: [BINARY] })

    expect(wireBody(server).state).toBe('the secret is in the state')
    expect(redactions.count).toBe(0)
  })

  it('sends what the redactor returned and consults it once per ask', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ], { redactor: true })

    await ctx.judgment.ask({ state: 'the secret is in the state', questions: [BINARY] })

    expect(wireBody(server).state).toBe('the [redacted] is in the state')
    expect(redactions.count).toBe(1)

    await ctx.judgment.ask({ state: 'another secret', questions: [BINARY] })

    expect(wireBody(server, 1).state).toBe('another [redacted]')
    expect(redactions.count).toBe(2)
  })
})

describe('deadline and cancellation', () => {
  it('fails UNAVAILABLE naming timeoutMs when the request outlives the deadline', async () => {
    const { ctx } = await harness([{ kind: 'stall' }], { config: { timeoutMs: 50 } })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('within timeoutMs 50')
  })

  it('fails UNAVAILABLE naming timeoutMs when the body outlives the deadline', async () => {
    const { ctx } = await harness([{ kind: 'partial', status: 200, head: '{"model":"' }], { config: { timeoutMs: 50 } })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('within timeoutMs 50')
  })

  it('fails UNAVAILABLE naming timeoutMs when an error body outlives the deadline', async () => {
    const { ctx } = await harness([{ kind: 'partial', status: 500, head: '{"error":' }], { config: { timeoutMs: 50 } })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('within timeoutMs 50')
  })

  it('fails ABORTED when the caller aborted before the ask', async () => {
    const { ctx } = await harness([{ kind: 'stall' }])
    const controller = new AbortController()
    controller.abort()

    const failure = await askFailure(() => ctx.judgment.ask({
      state: 'state',
      questions: [BINARY],
      signal: controller.signal,
    }))

    expect(failure.code).toBe('ABORTED')
    expect(failure.message).toContain('cancelled by the caller')
  })

  it('fails ABORTED when the caller aborts while the request is outstanding', async () => {
    const { ctx } = await harness([{ kind: 'stall' }])
    const controller = new AbortController()

    const pending = ctx.judgment.ask({ state: 'state', questions: [BINARY], signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)

    const failure = await askFailure(() => pending)

    expect(failure.code).toBe('ABORTED')
  })

  it('fails ABORTED when the caller aborts while the body is outstanding', async () => {
    const { ctx } = await harness([{ kind: 'partial', status: 200, head: '{"model":"' }])
    const controller = new AbortController()

    const pending = ctx.judgment.ask({ state: 'state', questions: [BINARY], signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)

    const failure = await askFailure(() => pending)

    expect(failure.code).toBe('ABORTED')
  })

  it('fails ABORTED when the caller aborts while an error body is outstanding', async () => {
    const { ctx } = await harness([{ kind: 'partial', status: 500, head: '{"error":' }])
    const controller = new AbortController()

    const pending = ctx.judgment.ask({ state: 'state', questions: [BINARY], signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)

    const failure = await askFailure(() => pending)

    expect(failure.code).toBe('ABORTED')
  })
})


/** Fake the timer the retry wait arms, leaving real I/O and `AbortSignal` timers alone. */
function fakeRetryTimer(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/**
 * Let real I/O run until the stub has answered, without advancing a timer.
 * @param server - the stub the ask's requests land on.
 */
async function drainRefusal(server: MockServer): Promise<void> {
  for (let turn = 0; turn < 200 && server.requests.length === 0; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  // The refusal is in flight; these turns read its body and arm the retry wait.
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

/**
 * Advance the faked retry timer until the ask settles, yielding real I/O between
 * advances so the request each release sends can complete.
 * @param pending - the ask to settle.
 * @returns the settled ask.
 */
async function settleRetry<T>(pending: Promise<T>): Promise<T> {
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  for (let turn = 0; turn < 400 && !settled; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS)
  }
  return pending
}

describe('bounded retry', () => {
  it('retries a 429 after one fixed wait and answers the second attempt', async () => {
    fakeRetryTimer()
    const { ctx, server } = await harness([
      { kind: 'json', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) },
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.7 } }) },
    ])

    const pending = ctx.judgment.ask({ state: 'state', questions: [BINARY] })
    await drainRefusal(server)

    // The refusal is in and the retry is armed on the faked timer: nothing is sent
    // until that wait elapses, which is the one fixed delay the policy configures.
    expect(server.requests).toHaveLength(1)

    const result = await settleRetry(pending)

    expect(server.requests).toHaveLength(2)
    // A retry re-sends the ask it already sent, byte for byte.
    expect(server.requests[1]?.body).toEqual(server.requests[0]?.body)
    expect(result.answers).toEqual([{ kind: 'binary', id: 'urgent', probability: 0.7 }])
    expect(result.engine).toBe('typesafe')
  })

  it('retries a 529 after one fixed wait and answers the second attempt', async () => {
    fakeRetryTimer()
    const { ctx, server } = await harness([
      { kind: 'json', status: 529, body: JSON.stringify({ error: { message: 'overloaded' } }) },
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.55 } }) },
    ])

    const pending = ctx.judgment.ask({ state: 'state', questions: [BINARY] })
    await drainRefusal(server)
    expect(server.requests).toHaveLength(1)

    const result = await settleRetry(pending)

    expect(server.requests).toHaveLength(2)
    expect(result.answers).toEqual([{ kind: 'binary', id: 'urgent', probability: 0.55 }])
  })

  it('surfaces the last refusal as UNAVAILABLE once the budget is spent', async () => {
    fakeRetryTimer()
    const { ctx, server } = await harness([
      { kind: 'json', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) },
      { kind: 'json', status: 429, body: JSON.stringify({ error: { message: 'still busy' } }) },
    ])

    const failure = await askFailure(() => settleRetry(ctx.judgment.ask({ state: 'state', questions: [BINARY] })))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('HTTP 429')
    expect(failure.message).toContain('still busy')
    // The default budget is one retry, and the failure is the response that spent it.
    expect(server.requests).toHaveLength(2)
  })

  it('sends no retry when the budget is zero', async () => {
    const { ctx, server } = await harness([
      { kind: 'json', status: 429, body: JSON.stringify({ message: 'slow down' }) },
    ], { config: { retry: { maxRetries: 0 } } })

    const failure = await askFailure(() => ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('slow down')
    expect(server.requests).toHaveLength(1)
  })

  it('retries only a status the policy names', async () => {
    // A deployment that names 503 leaves the vendor's rate limit to its caller.
    const unnamed = await harness([
      { kind: 'json', status: 429, body: JSON.stringify({ message: 'slow down' }) },
    ], { config: { retry: { statuses: [503] } } })

    const failure = await askFailure(() => unnamed.ctx.judgment.ask({ state: 'state', questions: [BINARY] }))

    expect(failure.message).toContain('HTTP 429')
    expect(unnamed.server.requests).toHaveLength(1)

    // The status it does name is retried.
    fakeRetryTimer()
    const named = await harness([
      { kind: 'json', status: 503, body: JSON.stringify({ message: 'try later' }) },
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.6 } }) },
    ], { config: { retry: { statuses: [503] } } })

    const pending = named.ctx.judgment.ask({ state: 'state', questions: [BINARY] })
    await drainRefusal(named.server)
    expect(named.server.requests).toHaveLength(1)

    await expect(settleRetry(pending)).resolves.toMatchObject({ engine: 'typesafe' })
    expect(named.server.requests).toHaveLength(2)
  })

  it('aborts the ask while the retry wait is outstanding', async () => {
    fakeRetryTimer()
    const { ctx, server } = await harness([
      { kind: 'json', status: 429, body: JSON.stringify({ message: 'slow down' }) },
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.7 } }) },
    ])
    const controller = new AbortController()

    const pending = ctx.judgment.ask({ state: 'state', questions: [BINARY], signal: controller.signal })
    await drainRefusal(server)
    expect(server.requests).toHaveLength(1)

    controller.abort()

    const failure = await askFailure(() => pending)

    expect(failure.code).toBe('ABORTED')
    expect(failure.message).toContain('cancelled by the caller')
    // The wait ended the ask where it stood: the doomed retry was never sent.
    expect(server.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS)
    expect(server.requests).toHaveLength(1)
  })
})

describe('retryWait', () => {
  it('resolves once the delay elapses and not before', async () => {
    fakeRetryTimer()
    const signal = new AbortController().signal
    let settled = false
    const waiting = retryWait(DEFAULT_RETRY_DELAY_MS, signal)
    void waiting.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS - 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('rejects with the signal own reason when the ask is cancelled during the wait', async () => {
    fakeRetryTimer()
    const controller = new AbortController()
    const waiting = retryWait(DEFAULT_RETRY_DELAY_MS, controller.signal)

    controller.abort(new Error('caller gave up'))

    await expect(waiting).rejects.toThrow('caller gave up')
  })

  it('ends at once when the signal is already aborted', async () => {
    fakeRetryTimer()
    const controller = new AbortController()
    controller.abort('caller gave up')

    // An AbortSignal fires no event for an abort that already happened, so the wait
    // reads it up front; a reason that is not an Error is wrapped, because a wait
    // never rejects with a non-error value.
    const waiting = retryWait(DEFAULT_RETRY_DELAY_MS, controller.signal)

    await expect(waiting).rejects.toThrow(/retry wait was cancelled by the caller/)
    // Nothing was scheduled: the delay never ran.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries on the next timer turn with a zero delay', async () => {
    fakeRetryTimer()
    const waiting = retryWait(0, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)

    await expect(waiting).resolves.toBeUndefined()
  })
})
describe('service registration', () => {
  it('registers as ctx.judgment and withdraws the service when its fiber disposes', async () => {
    const { ctx } = await harness([
      { kind: 'json', status: 200, body: answerBody({ urgent: { type: 'noul', noul: 0.5 } }) },
    ])

    expect(ctx.judgment).toBeInstanceOf(TypesafeJudgmentEngine)
    expect(ctx.get('judgment')).toBeInstanceOf(TypesafeJudgmentEngine)

    await disposeContext(ctx)

    expect(ctx.get('judgment')).toBeUndefined()
  })
})
