import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import {
  JUDGMENT_SETTINGS_NAMESPACE,
  judgmentEngineId,
  judgmentQuestionId,
  registerJudgmentEngine,
} from '@shres-code/shres-code-judgment'
import type { JudgmentChoiceQuestion, JudgmentEngine, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import LlmRuntime from '@shres-code/shres-code-llm'
// Function plugin: the Loader reads its name/inject/Config/apply namespace.
import * as DeepSeekPlugin from '@shres-code/shres-code-llm-deepseek'
import { startMockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import type { MockLlmServer } from '@shres-code/shres-code-llm-mock-server'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import LlmJudgmentEngine from '../src/index.ts'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const LLM_ENGINE = `llm:${PROVIDER}/${MODEL}`

/** Cold-cache Loader resolution can exceed the default per-test budget. */
const COMPOSITION_TIMEOUT_MS = 60_000

const ROUTE: JudgmentChoiceQuestion = {
  kind: 'choice',
  id: judgmentQuestionId('route'),
  instructions: 'Which route should handle this turn?',
  options: [{ option: 'keep-current' }, { option: 'flash' }],
}

/** TEST DOUBLE: the deployment's default engine, answering without any request. */
class LocalEngine implements JudgmentEngine {
  static inject = ['judgmentEngines']
  static readonly asks: JudgmentInput[] = []

  constructor(ctx: Context) {
    registerJudgmentEngine(ctx, {
      engine: this,
      descriptor: { id: judgmentEngineId('local'), label: 'Local test engine', egress: 'none', calibration: 'calibrated', supportsFitting: false },
      status: () => ({ state: 'ready' }),
    })
  }

  ask(input: JudgmentInput): Promise<JudgmentResult> {
    LocalEngine.asks.push(input)
    return Promise.resolve({
      answers: [{ kind: 'choice', id: ROUTE.id, option: 'keep-current', probabilities: { 'keep-current': 1, flash: 0 }, confidence: 1 }],
      engine: 'local',
      model: 'local-1',
      latencyMs: 0,
    })
  }
}

let root: string | undefined
let context: Context | undefined
let server: MockLlmServer | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  LocalEngine.asks.length = 0
  previousApiKey = process.env['DEEPSEEK_API_KEY']
  process.env['DEEPSEEK_API_KEY'] = 'judgment-llm-composition-key'
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.close()
  server = undefined
  if (previousApiKey === undefined) delete process.env['DEEPSEEK_API_KEY']
  else process.env['DEEPSEEK_API_KEY'] = previousApiKey
  previousApiKey = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot one test-only cordis.yml through the real Loader and include builtin:
 * file settings, the dispatcher defaulting to the local engine, the llm
 * runtime with DeepSeek pointed at the mock server, and the LLM judge.
 */
async function boot(): Promise<Context> {
  server = await startMockLlmServer({
    sequence: ['tool_call_success'],
    repeatLast: true,
    chunkSize: 4096,
    toolName: 'judgment_answer',
    toolArguments: JSON.stringify({ answers: { route: { 'keep-current': 0.3, flash: 0.9 } } }),
  })
  root = await mkdtemp(join(tmpdir(), 'shres-judgment-llm-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@shres-code/shres-code-settings-file'",
    '  config:',
    `    path: '${join(root, 'settings.yaml')}'`,
    '    watch: false',
    "- name: '@shres-code/shres-code-judgment-dispatch'",
    '  config:',
    '    defaultEngine: local',
    "- name: '@test/local-judgment-engine'",
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@shres-code/shres-code-llm-deepseek'",
    '  config:',
    `    baseURL: '${server.baseURL}/v1'`,
    "- name: '@shres-code/shres-code-judgment-llm'",
    '  config:',
    `    provider: ${PROVIDER}`,
    `    model: ${MODEL}`,
    '    egress: remote',
    '    maxStateTokens: 4096',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-judgment-dispatch', JudgmentDispatch],
    ['@test/local-judgment-engine', LocalEngine],
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@shres-code/shres-code-llm-deepseek', DeepSeekPlugin],
    ['@shres-code/shres-code-judgment-llm', LlmJudgmentEngine],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('a settings write selects the LLM judge, which answers on the mock route with engineId stamped', async () => {
    const loaded = await boot()
    const llmId = judgmentEngineId(LLM_ENGINE)
    expect(loaded.judgmentEngines.list().find(descriptor => descriptor.id === llmId)).toEqual({
      id: LLM_ENGINE,
      label: `LLM judge (${PROVIDER}/${MODEL})`,
      egress: 'remote',
      calibration: 'verbalized',
      supportsFitting: false,
    })
    await vi.waitFor(() => { expect(loaded.judgmentEngines.get(llmId)?.status()).toEqual({ state: 'ready' }) })

    const before = await loaded.judgment.ask({ state: 'fix the typo in README', questions: [ROUTE] })
    expect(before.engineId).toBe('local')
    expect(server!.requests).toHaveLength(0)

    await loaded.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: LLM_ENGINE })
    const { answers, latencyMs, usage, ...identity } = await loaded.judgment.ask({ state: 'fix the typo in README', questions: [ROUTE] })

    expect(identity).toEqual({ engine: 'llm', model: MODEL, engineId: LLM_ENGINE })
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ kind: 'choice', id: 'route', option: 'flash', probabilities: { 'keep-current': 0.25, flash: 0.75 } })
    expect(latencyMs).toBeGreaterThanOrEqual(0)
    // The mock server reports usage on every completion; the DeepSeek adapter carries it through.
    expect(usage?.inputTokens).toBeGreaterThan(0)
    expect(usage?.outputTokens).toBeGreaterThan(0)
    expect(LocalEngine.asks).toHaveLength(1)
    expect(server!.requests).toHaveLength(1)
    const body = server!.requests[0]!.body as { model: string; tools: Array<{ function: { name: string } }>; messages: unknown[] }
    expect(body.model).toBe(MODEL)
    expect(body.tools.map(tool => tool.function.name)).toEqual(['judgment_answer'])
    expect(JSON.stringify(body.messages)).toContain('fix the typo in README')
  }, COMPOSITION_TIMEOUT_MS)
})
