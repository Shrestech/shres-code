import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentDefaultModel from '@shres-code/shres-code-agent-default-model'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import CommandRuntime from '@shres-code/shres-code-commands'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import * as LlmRetryPlugin from '@shres-code/shres-code-llm-retry'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import { JUDGMENT_SETTINGS_NAMESPACE, judgmentEngineId } from '@shres-code/shres-code-judgment'
import JudgmentDispatch, { JudgmentEnginesGateway } from '@shres-code/shres-code-judgment-dispatch'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import TypesafeJudgmentEngine from '@shres-code/shres-code-judgment-typesafe'
import ShieldJudgmentEngine from '@shres-code/shres-code-judgment-shield'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import ModelRoutingController, {
  KEEP_CURRENT_OPTION_ID,
  ROUTE_QUESTION_ID,
} from '../src/index.ts'

const CREDENTIALS_SPECIFIER = '@test/model-router-credentials'
type ProviderKind = 'typesafe' | 'shield'
const SHIELD_MODEL = 'convaiinnovations/laya@1c5edc17a7acd8701df6fc341c0d179f1c62c982'
const ROUTER_SPECIFIER = '@shres-code/shres-code-model-router'
const SETTINGS_SPECIFIER = '@shres-code/shres-code-settings-file'
const RETRY_SPECIFIER = '@shres-code/shres-code-llm-retry'
const PROVIDER = 'deepseek-official'
const MANUAL_MODEL = 'deepseek-v4-pro'
const CANDIDATE_ID = 'flash'
const CANDIDATE_MODEL = 'deepseek-v4-flash'
const ROUTE_CONFIDENCE = 0.9
const ROUTE_REMAINDER = 0.1
const COMPOSITION_TIMEOUT_MS = 60_000

interface RouteScript {
  readonly choice: typeof KEEP_CURRENT_OPTION_ID | typeof CANDIDATE_ID
  readonly score: number
}

interface WireQuestion {
  readonly type: string
  readonly criteria?: unknown
}

interface ScriptedAnswer {
  readonly type: string
  readonly choice?: string
  readonly score?: number
  readonly probabilities: Record<string, number>
  readonly confidence: number
}

interface JudgmentRequestBody {
  readonly model?: unknown
  readonly states?: unknown
  readonly questions?: Record<string, WireQuestion> | ShieldQuestion[]
}

interface ShieldQuestion {
  readonly id: string
  readonly kind: string
  readonly options?: { option: string; description?: string }[]
  readonly levels?: string[]
}

interface RecordedJudgmentRequest {
  readonly path: string
  readonly body: JudgmentRequestBody
}

/** Loopback provider endpoint with scripted decisions and each provider's real wire format. */
class LoopbackJudgmentServer {
  readonly requests: RecordedJudgmentRequest[] = []
  private readonly script: readonly RouteScript[]
  private server: Server | undefined
  private cursor = 0

  constructor(script: readonly RouteScript[], private readonly provider: ProviderKind) {
    this.script = script
  }

  /** Start the endpoint and return its base URL. */
  async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the judgment stub has no port')
    return `http://127.0.0.1:${address.port}`
  }

  /** Stop the endpoint and close any accepted connections. */
  async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    })
    this.server = undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JudgmentRequestBody
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    this.requests.push({
      path,
      body,
    })
    const script = this.script[Math.min(this.cursor, this.script.length - 1)]
    this.cursor += 1
    if (script === undefined) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'judgment script exhausted' } }))
      return
    }
    const answers: Record<string, ScriptedAnswer> = {}
    const questions = Array.isArray(body.questions)
      ? Object.fromEntries(body.questions.map(question => [question.id, {
        type: question.kind,
        criteria: question.kind === 'choice'
          ? Object.fromEntries((question.options ?? []).map(option => [option.option, option.description]))
          : question.levels,
      }]))
      : body.questions ?? {}
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'choice') {
        answers[id] = {
          type: 'choice',
          choice: script.choice,
          probabilities: script.choice === KEEP_CURRENT_OPTION_ID
            ? { [KEEP_CURRENT_OPTION_ID]: ROUTE_CONFIDENCE, [CANDIDATE_ID]: ROUTE_REMAINDER }
            : { [KEEP_CURRENT_OPTION_ID]: ROUTE_REMAINDER, [CANDIDATE_ID]: ROUTE_CONFIDENCE },
          confidence: ROUTE_CONFIDENCE,
        }
      } else if (question.type === 'score') {
        answers[id] = {
          type: 'score',
          score: script.score,
          probabilities: Object.fromEntries(Array.from({ length: 5 }, (_, level) => [String(level), level === script.score ? 1 : 0])),
          confidence: 1,
        }
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    const output = this.provider === 'typesafe'
      ? { model: 'jev-loopback', answers }
      : (() => {
        const result = {
          engine: 'shield', model: SHIELD_MODEL, latencyMs: 1,
          answers: Object.entries(answers).map(([id, answer]) => ({
            id, kind: answer.type, probabilities: answer.probabilities, confidence: answer.confidence,
            ...answer.type === 'choice' ? { option: answer.choice } : { score: answer.score },
          })),
        }
        if (path !== '/v1/judgments/fitted') {
          return result
        }
        const sequenceTokens = Object.keys(questions).map((_id, index) => 20 + index * 4)
        return {
          kind: 'answered',
          fit: {
            selectedIndex: 0,
            stateTokens: 8,
            sequenceTokens,
            paddedTokens: sequenceTokens.length === 0 ? 0 : Math.max(...sequenceTokens) * sequenceTokens.length,
            limits: {
              maxSequenceTokens: 128,
              maxHeadTokens: 64,
              maxBatchTokens: 256,
              manifestSha256: 'a'.repeat(64),
            },
          },
          result,
        }
      })()
    response.end(JSON.stringify(output))
  }
}

/** Test-only credentials service for the real TypeSafe provider. */
class MemoryCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  resolve(_ref: string): Promise<{ value: string; source: string }> {
    return Promise.resolve({ value: 'loader-key', source: 'memory' })
  }

  describe(_ref: string): Promise<{ configured: boolean; source: string; writable: boolean }> {
    return Promise.resolve({ configured: true, source: 'memory', writable: true })
  }

  set(_ref: string, _value: string): Promise<void> {
    return Promise.resolve()
  }

  unset(_ref: string): Promise<void> {
    return Promise.resolve()
  }
}

let root: string | undefined
let context: Context | undefined
let modelServer: MockLlmServer | undefined
let judgmentServer: LoopbackJudgmentServer | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousApiKey = process.env['DEEPSEEK_API_KEY']
  process.env['DEEPSEEK_API_KEY'] = 'model-router-provider-key'
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await judgmentServer?.close()
  judgmentServer = undefined
  await modelServer?.close()
  modelServer = undefined
  if (previousApiKey === undefined) delete process.env['DEEPSEEK_API_KEY']
  else process.env['DEEPSEEK_API_KEY'] = previousApiKey
  previousApiKey = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Where llm-retry sits relative to the router in the composition, when it is composed. */
type RetryPlacement = 'before-router' | 'after-router'

/** The llm-retry entry, which applies the DeepSeek route's normal-mode policy. */
const RETRY_ENTRY = [`- name: '${RETRY_SPECIFIER}'`]

/**
 * Boot the real agent spine, selected judgment provider, and model router through Loader.
 * @param endpoint - the loopback judgment endpoint.
 * @param provider - the judgment provider to compose.
 * @param retry - where to compose llm-retry, with a one-retry normal policy on the DeepSeek route.
 * @returns the loaded context.
 */
async function loadSpine(endpoint: string, provider: ProviderKind, retry?: RetryPlacement): Promise<Context> {
  return loadComposition({ engines: { [provider]: endpoint }, defaultEngine: provider, ...retry === undefined ? {} : { retry } })
}

/** What one Loader composition mounts. */
interface CompositionOptions {
  /** The loopback endpoint of each judgment provider to compose. */
  readonly engines: Partial<Record<ProviderKind, string>>
  /** The dispatcher's composition default. */
  readonly defaultEngine: ProviderKind
  /** Where to compose llm-retry. */
  readonly retry?: RetryPlacement
  /** Whether to compose the file settings provider, so settings writes reach the dispatcher. */
  readonly settings?: boolean
}

/**
 * Boot the real agent spine, the dispatcher with each listed provider, and the model router through Loader.
 * @param options - engines, default engine, retry placement, and settings provider.
 * @returns the loaded context.
 */
async function loadComposition(options: CompositionOptions): Promise<Context> {
  const { retry } = options
  const providers = Object.keys(options.engines) as ProviderKind[]
  root = await mkdtemp(join(tmpdir(), 'shres-model-router-provider-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...options.settings === true ? [
      `- name: '${SETTINGS_SPECIFIER}'`,
      '  config:',
      `    path: '${join(root, 'settings.yaml')}'`,
      '    watch: false',
    ] : [],
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-system-prompt'",
    "- name: '@shres-code/shres-code-tools'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-commands'",
    "- name: '@shres-code/shres-code-session-projection'",
    "- name: '@shres-code/shres-code-agent-default-model'",
    '  config:',
    `    provider: ${PROVIDER}`,
    `    model: ${MANUAL_MODEL}`,
    "- name: '@shres-code/shres-code-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@shres-code/shres-code-llm-deepseek'",
    '  config:',
    `    baseURL: '${modelServer?.baseURL}/v1'`,
    ...retry === undefined ? [] : [
      '    retryPolicy:',
      '      mode: normal',
      '      maxRetries: 1',
      '      backoff: { initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 }',
    ],
    ...retry === 'before-router' ? RETRY_ENTRY : [],
    `- name: '${CREDENTIALS_SPECIFIER}'`,
    '  config:',
    '    TYPESAFE_API_KEY: loader-key',
    "- name: '@shres-code/shres-code-judgment-dispatch'",
    '  config:',
    `    defaultEngine: ${options.defaultEngine}`,
    ...providers.flatMap(provider => [
      `- name: '@shres-code/shres-code-judgment-${provider}'`,
      '  config:',
      ...provider === 'typesafe' ? ['    apiKeyRef: TYPESAFE_API_KEY'] : [
        `    models: { fast: '${SHIELD_MODEL}', accurate: '${SHIELD_MODEL}' }`,
      ],
      `    endpoint: '${options.engines[provider]}'`,
    ]),
    `- name: '${ROUTER_SPECIFIER}'`,
    '  config:',
    '    initialMode: on',
    '    candidates:',
    `      - id: ${CANDIDATE_ID}`,
    `        provider: ${PROVIDER}`,
    `        model: ${CANDIDATE_MODEL}`,
    '        description: a small, well-scoped change in familiar code',
    '    routeFrom:',
    `      - { provider: ${PROVIDER}, model: ${MANUAL_MODEL}, objective: dollars }`,
    '    downgradeThreshold: 0.7',
    '    downgradeMargin: 0.5',
    '    hold: { minSteps: 0 }',
    '    routeInstructions: Choose a cheaper model only when it is suitable for this turn.',
    '    difficultyInstructions: Rate how much reasoning this turn needs.',
    ...retry === 'after-router' ? RETRY_ENTRY : [],
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-commands', CommandRuntime],
    ['@shres-code/shres-code-session-projection', SessionProjectionRegistry],
    ['@shres-code/shres-code-agent-default-model', AgentDefaultModel],
    ['@shres-code/shres-code-agent-loop', AgentLoop],
    ['@shres-code/shres-code-llm-deepseek', DeepSeekPlugin],
    [CREDENTIALS_SPECIFIER, MemoryCredentials],
    ['@shres-code/shres-code-judgment-dispatch', JudgmentDispatch],
    ['@shres-code/shres-code-judgment-typesafe', TypesafeJudgmentEngine],
    ['@shres-code/shres-code-judgment-shield', ShieldJudgmentEngine],
    [SETTINGS_SPECIFIER, FileSettingsProvider],
    [ROUTER_SPECIFIER, ModelRoutingController],
    [RETRY_SPECIFIER, LlmRetryPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Create one agent with the manual model selected for its session. */
function createAgent(loaded: Context, id: string): Agent {
  const agent = loaded.agentLoop.create(SessionId(id), { provider: PROVIDER, model: MANUAL_MODEL })
  loaded.agentDefaultModel.selectionFor(agent)
  return agent
}

/** Drive one user turn to whole-agent idle. */
async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Return one event family from a session log. */
function eventsOfType<T extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.flatMap(event => event.type === type ? [event as Extract<SessionEvent, { type: T }>] : [])
}

/** Read the model sent to the real chat-completions adapter. */
function requestedModel(index: number): unknown {
  const body = modelServer?.requests[index]?.body as { model?: unknown } | undefined
  return body?.model
}

/** Read the route criteria sent through either real judgment provider. */
function routeCriteria(index: number): Record<string, unknown> {
  const body = judgmentServer?.requests[index]?.body
  if (Array.isArray(body?.questions)) {
    const question = body.questions.find(entry => entry.id === ROUTE_QUESTION_ID)
    if (question?.kind !== 'choice') throw new Error('the Shield payload did not contain a route choice question')
    return Object.fromEntries((question.options ?? []).map(option => [option.option, option.description]))
  }
  const question = body?.questions?.[ROUTE_QUESTION_ID]
  if (question?.type !== 'choice' || question.criteria === undefined || typeof question.criteria !== 'object' || question.criteria === null || Array.isArray(question.criteria)) {
    throw new Error('the judgment payload did not contain a route choice question')
  }
  return question.criteria as Record<string, unknown>
}

describe.each<ProviderKind>(['typesafe', 'shield'])('real %s judgment and model-router composition', (provider) => {
  it('sends keep-current with one candidate and honors manual/high-difficulty decisions', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    modelServer = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: 'ROUTED_OK' })
    judgmentServer = new LoopbackJudgmentServer([
      { choice: KEEP_CURRENT_OPTION_ID, score: 1 },
      { choice: CANDIDATE_ID, score: 4 },
      { choice: CANDIDATE_ID, score: 1 },
    ], provider)
    const judgmentURL = await judgmentServer.start()
    const loaded = await loadSpine(judgmentURL, provider)

    expect(loaded.get('judgment')).toBeInstanceOf(JudgmentDispatch)
    expect(loaded.judgmentEngines.get(judgmentEngineId(provider))?.engine)
      .toBeInstanceOf(provider === 'typesafe' ? TypesafeJudgmentEngine : ShieldJudgmentEngine)
    const keepCurrentAgent = createAgent(loaded, 'provider-keep-current')
    await turn(keepCurrentAgent, 'Keep the manual route for this uncertain turn.')
    const keepCurrentDecision = eventsOfType(keepCurrentAgent.session.events, 'model-routing/decision')[0]
    expect(keepCurrentDecision?.data).toMatchObject({
      outcome: 'kept-strong',
      reason: 'current-preferred',
      route: { choice: KEEP_CURRENT_OPTION_ID, confidence: ROUTE_CONFIDENCE },
      engine: provider,
      model: provider === 'typesafe' ? 'jev-loopback' : SHIELD_MODEL,
    })
    expect(requestedModel(0)).toBe(MANUAL_MODEL)

    const hardAgent = createAgent(loaded, 'provider-hard')
    await turn(hardAgent, 'Use the manual route for this hard architecture turn.')
    const hardDecision = eventsOfType(hardAgent.session.events, 'model-routing/decision')[0]
    expect(hardDecision?.data).toMatchObject({
      outcome: 'kept-strong',
      reason: 'difficulty-too-high',
      route: { choice: CANDIDATE_ID, confidence: ROUTE_CONFIDENCE },
      difficulty: { score: 4 },
    })
    expect(requestedModel(1)).toBe(MANUAL_MODEL)

    const easyAgent = createAgent(loaded, 'provider-easy')
    await turn(easyAgent, 'Use the cheaper route for this small lookup.')
    const easyDecision = eventsOfType(easyAgent.session.events, 'model-routing/decision')[0]
    expect(easyDecision?.data).toMatchObject({
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: { candidateId: CANDIDATE_ID, model: CANDIDATE_MODEL },
      route: { choice: CANDIDATE_ID, confidence: ROUTE_CONFIDENCE },
      difficulty: { score: 1 },
    })
    expect(requestedModel(2)).toBe(CANDIDATE_MODEL)

    expect(judgmentServer.requests.map(request => request.path)).toEqual(
      Array.from({ length: 3 }, () => provider === 'typesafe' ? '/v1/systemone' : '/v1/judgments/fitted'),
    )
    expect(Object.keys(routeCriteria(0))).toEqual([KEEP_CURRENT_OPTION_ID, CANDIDATE_ID])
    expect(Object.keys(routeCriteria(1))).toEqual([KEEP_CURRENT_OPTION_ID, CANDIDATE_ID])
    expect(Object.keys(routeCriteria(2))).toEqual([KEEP_CURRENT_OPTION_ID, CANDIDATE_ID])
  })

  it('a 500 from the candidate completes the turn on the manual model', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    modelServer = await startMockLlmServer({ sequence: ['server_error', 'success'], repeatLast: true, chunkSize: 4096, successText: 'ROUTED_OK' })
    judgmentServer = new LoopbackJudgmentServer([{ choice: CANDIDATE_ID, score: 1 }], provider)
    const loaded = await loadSpine(await judgmentServer.start(), provider)
    const agent = createAgent(loaded, 'provider-candidate-500')

    await turn(agent, 'Use the cheaper route for this small lookup.')

    // The candidate request failed; the same step was retried on the manual model.
    expect([requestedModel(0), requestedModel(1)]).toEqual([CANDIDATE_MODEL, MANUAL_MODEL])
    expect(modelServer.requests).toHaveLength(2)
    const log = agent.session.events
    const decisions = eventsOfType(log, 'model-routing/decision').map(event => event.data)
    expect(decisions.map(decision => decision.reason)).toEqual(['gate-passed', 'route-failed'])
    expect(decisions[1]).toMatchObject({
      outcome: 'kept-strong',
      failure: { provider: PROVIDER, model: CANDIDATE_MODEL },
      failedChunkSeq: expect.any(Number) as unknown,
      sticky: { active: false, brokenBy: 'route-failed', entryBase: { provider: PROVIDER, model: MANUAL_MODEL } },
    })
    const headers = eventsOfType(log, 'request/header').map(event => event.data.header.config.model)
    expect(headers).toEqual([CANDIDATE_MODEL, MANUAL_MODEL])
    // The fallback decision precedes the retried request's header.
    const fallbackSeq = eventsOfType(log, 'model-routing/decision')[1]!.seq
    expect(fallbackSeq).toBeLessThan(eventsOfType(log, 'request/header')[1]!.seq)
    expect(eventsOfType(log, 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
    expect(eventsOfType(log, 'assistant/message').at(-1)?.data.message.source).toMatchObject({ model: MANUAL_MODEL })
    // The judgment was asked once; the retry reused the step's manual pin.
    expect(judgmentServer.requests).toHaveLength(1)
  })
})

/*
 * The llm-retry entry's position in the YAML does not reverse the
 * agent/request-error waterfall: in both placements the router's listener runs
 * first and reaches llm-retry through next(). These cases pin behaviour under
 * both composition orders; they do not test llm-retry running ahead of the
 * router. The router's order independence rests on calling next() before it
 * falls back, by construction.
 */
describe.each<RetryPlacement>(['before-router', 'after-router'])('real llm-retry and model-router composition (llm-retry entry %s; same waterfall order)', (placement) => {
  /** One routed turn against the scripted model endpoint; returns the durable log. */
  async function routedTurn(sequence: ('server_error' | 'auth_error' | 'success')[], id: string): Promise<readonly SessionEvent[]> {
    modelServer = await startMockLlmServer({ sequence, repeatLast: true, chunkSize: 4096, successText: 'ROUTED_OK' })
    judgmentServer = new LoopbackJudgmentServer([{ choice: CANDIDATE_ID, score: 1 }], 'typesafe')
    const loaded = await loadSpine(await judgmentServer.start(), 'typesafe', placement)
    const agent = createAgent(loaded, id)
    await turn(agent, 'Use the cheaper route for this small lookup.')
    return agent.session.events
  }

  it('llm-retry retries a transient candidate failure on the candidate, and the router passes it through', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const events = await routedTurn(['server_error', 'success'], `retry-transient-${placement}`)

    expect([requestedModel(0), requestedModel(1)]).toEqual([CANDIDATE_MODEL, CANDIDATE_MODEL])
    expect(modelServer?.requests).toHaveLength(2)
    const retries = eventsOfType(events, 'llm/retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]?.data).toMatchObject({ provider: PROVIDER, retry: 1, failure: { code: 'SERVER' } })
    // The retry reused the step's downgraded decision: one judgment, no fallback.
    expect(eventsOfType(events, 'model-routing/decision').map(event => event.data.reason)).toEqual(['gate-passed'])
    expect(judgmentServer?.requests).toHaveLength(1)
    expect(eventsOfType(events, 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
  })

  it('a non-transient candidate failure falls back to the manual route through route-failed', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const events = await routedTurn(['auth_error', 'success'], `retry-permanent-${placement}`)

    expect([requestedModel(0), requestedModel(1)]).toEqual([CANDIDATE_MODEL, MANUAL_MODEL])
    expect(eventsOfType(events, 'llm/retry')).toHaveLength(0)
    const decisions = eventsOfType(events, 'model-routing/decision').map(event => event.data)
    expect(decisions.map(decision => decision.reason)).toEqual(['gate-passed', 'route-failed'])
    expect(decisions[1]).toMatchObject({ failure: { code: 'AUTH', provider: PROVIDER, model: CANDIDATE_MODEL } })
    expect(eventsOfType(events, 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
  })

  it('a transient failure that exhausts its retries falls back to the manual route', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    const events = await routedTurn(['server_error', 'server_error', 'success'], `retry-exhausted-${placement}`)

    expect([requestedModel(0), requestedModel(1), requestedModel(2)]).toEqual([CANDIDATE_MODEL, CANDIDATE_MODEL, MANUAL_MODEL])
    expect(eventsOfType(events, 'llm/retry')).toHaveLength(1)
    const decisions = eventsOfType(events, 'model-routing/decision').map(event => event.data)
    expect(decisions.map(decision => decision.reason)).toEqual(['gate-passed', 'route-failed'])
    expect(decisions[1]).toMatchObject({ failure: { code: 'SERVER', model: CANDIDATE_MODEL } })
    expect(eventsOfType(events, 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
  })
})

describe('real judgment engine switch through the settings seam', () => {
  it('a judgment.engine write changes the engine of the next decision, and the engine Remote reports the registry', { timeout: COMPOSITION_TIMEOUT_MS }, async () => {
    modelServer = await startMockLlmServer({ sequence: ['success'], repeatLast: true, chunkSize: 4096, successText: 'ROUTED_OK' })
    judgmentServer = new LoopbackJudgmentServer([{ choice: KEEP_CURRENT_OPTION_ID, score: 1 }], 'typesafe')
    const shieldServer = new LoopbackJudgmentServer([{ choice: KEEP_CURRENT_OPTION_ID, score: 1 }], 'shield')
    try {
      const loaded = await loadComposition({
        engines: { typesafe: await judgmentServer.start(), shield: await shieldServer.start() },
        defaultEngine: 'typesafe',
        settings: true,
      })
      let announced = 0
      loaded.on('judgment/engines-updated', () => { announced += 1 })
      const gateway: unknown = loaded.get('judgmentEnginesRemote')
      if (!(gateway instanceof JudgmentEnginesGateway)) throw new Error('the judgmentEngines Remote is not mounted')

      const before = gateway.snapshot()
      expect(before.engines.map(engine => [engine.id, engine.state]))
        .toEqual(loaded.judgmentEngines.entryList().map(entry => [entry.descriptor.id, entry.status().state]))
      expect(before.engines.map(engine => [engine.id, engine.egress, engine.state])).toEqual([
        ['typesafe', 'remote', 'ready'],
        ['shield', 'local', 'ready'],
      ])
      expect(before.selection.engine).toBe('typesafe')
      expect(before.consumers).toContain('model-router')

      const first = createAgent(loaded, 'switch-before')
      await turn(first, 'Keep the manual route for this uncertain turn.')
      expect(eventsOfType(first.session.events, 'model-routing/decision')[0]?.data).toMatchObject({ engine: 'typesafe' })

      await loaded.settings.mutate(JUDGMENT_SETTINGS_NAMESPACE, [{ op: 'set', path: ['engine'], value: 'shield' }])
      expect(announced).toBeGreaterThan(0)
      expect(gateway.snapshot().selection.engine).toBe('shield')

      const second = createAgent(loaded, 'switch-after')
      await turn(second, 'Keep the manual route for this uncertain turn.')
      expect(eventsOfType(second.session.events, 'model-routing/decision')[0]?.data).toMatchObject({ engine: 'shield', model: SHIELD_MODEL })
      expect(judgmentServer.requests).toHaveLength(1)
      expect(shieldServer.requests.map(request => request.path)).toEqual(['/v1/judgments/fitted'])
    } finally {
      await shieldServer.close()
    }
  })
})
