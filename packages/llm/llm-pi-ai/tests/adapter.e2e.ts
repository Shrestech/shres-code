import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { createUserMessage, CallId, ReasoningEffortId  } from '@shres-code/shres-code-llm'
import type { Message, ToolSchema } from '@shres-code/shres-code-llm'
import * as LlmPiAi from '@shres-code/shres-code-llm-pi-ai'
import type { PiAiProviderProfile } from '@shres-code/shres-code-llm-pi-ai'
import * as LlmDeepSeek from '@shres-code/shres-code-llm-deepseek'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-API e2e for the pi-ai-backed adapter: V4 Flash + V4 Pro with provider
 * defaults and representative off/high/max reasoning. Mirrors the native
 * adapter's StreamChunk contract and exercises a replayed tool follow-up.
 * Key-gated.
 */

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const contexts: Context[] = []

async function harness(_model: string, config: Partial<PiAiProviderProfile> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      deepseek: {
        ...process.env.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: process.env.DEEPSEEK_API_KEY },
        ...process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseURL: process.env.DEEPSEEK_BASE_URL },
        ...config,
      },
    },
  })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function blockKinds(result: AssembledResult): string[] {
  return result.message.content.map(block => block.type)
}

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('llm-pi-ai e2e (real API)', () => {
  it.each([FLASH, PRO])('%s + provider-default reasoning: plain text generation', async (model) => {
    const ctx = await harness(model)
    const result = await assemble(ctx,{
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it('flash + reasoning off: plain text without reasoning blocks', async () => {
    const ctx = await harness(FLASH)
    const result = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it.each([FLASH, PRO])('%s + reasoning high: reasoning blocks present', async (model) => {
    const ctx = await harness(model)
    const result = await assemble(ctx,{
      model,
      reasoningEffort: ReasoningEffortId('high'),
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(result)).toContain('9.8')
  })

  it('pro + reasoning max: tool-call round trip', async () => {
    const ctx = await harness(PRO)

    const first = await assemble(ctx,{
      model: PRO,
      reasoningEffort: ReasoningEffortId('max'),
      messages: ask('What is the weather in Paris right now? Use the get_weather tool.'),
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(first.finish.kind).toBe('tool-calls')
    const call = first.message.content.find(block => block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call!.name).toBe('get_weather')
    expect(JSON.parse(call!.arguments)).toMatchObject({ city: expect.stringMatching(/paris/i) as string })

    const second = await assemble(ctx,{
      model: PRO,
      reasoningEffort: ReasoningEffortId('max'),
      messages: [
        ...ask('What is the weather in Paris right now? Use the get_weather tool.'),
        first.message,
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: CallId(call!.id),
            content: [{ type: 'text', text: 'Sunny, 22°C' }],
          }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(second.finish.kind).toBe('stop')
    expect(textOf(second).toLowerCase()).toMatch(/sunny|22/)
  })

  it('produces the same block structure as llm-deepseek for the same prompt', async () => {
    // Loose structural equivalence between the two independent adapters:
    // same block KINDS in the same order for a deterministic prompt — the
    // cross-implementation check that the StreamChunk design holds.
    const deepseekCtx = new Context()
    contexts.push(deepseekCtx)
    await deepseekCtx.plugin(LlmRuntime)
    await deepseekCtx.plugin(LlmDeepSeek, { thinking: 'disabled' })

    const piCtx = await harness(FLASH)

    const prompt = ask('Reply with exactly the word: pong')
    const [fromDeepSeek, fromPiAi] = await Promise.all([
      assemble(deepseekCtx, { provider: 'deepseek-official', model: FLASH, messages: prompt, maxTokens: 50 }),
      assemble(piCtx, { model: FLASH, messages: prompt, maxTokens: 50 }),
    ])
    expect(blockKinds(fromPiAi)).toEqual(blockKinds(fromDeepSeek))
    expect(fromPiAi.finish.kind).toBe(fromDeepSeek.finish.kind)
  })
})

describe('zai hosted web search', () => {
  // Key-gated: pins the live surface the dialect module encodes — the
  // web_search tool entry is accepted, the backend folds the search into the
  // answer silently, and nothing surfaces as a dispatchable tool call.
  it('serves the hosted web search as a silent fold with no tool-call blocks', async () => {
    if (process.env.ZAI_API_KEY === undefined) return
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        zai: {
          apiKeyEnv: 'ZAI_API_KEY',
          hostedTools: { webSearch: true },
          models: [{ id: 'glm-4.5-air' }],
        },
      },
    })
    const localWebSearch: ToolSchema = {
      name: 'web_search',
      description: 'local search that must be dropped for this route',
      parameters: { type: 'object', properties: {} },
    }
    const result = await assemble(ctx, {
      provider: 'zai',
      model: 'glm-4.5-air',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Search the web and answer in one line: the current stable Node.js LTS version.' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      tools: [localWebSearch],
    })
    expect(result.finish.kind).toBe('stop')
    const text = result.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text.trim().length).toBeGreaterThan(0)
    // The silent fold: no hosted call surfaced, and the dropped local
    // web_search was never dispatched.
    expect(result.message.content.some(block => block.type === 'tool-call' && block.name === 'web_search')).toBe(false)
  }, 120_000)
})
