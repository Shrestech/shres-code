/**
 * Key-gated e2e for the shipped any-API routes. Each describe self-skips
 * when its `*_API_KEY` is unset. Local Ollama skips when localhost:11434
 * does not answer GET /v1/models.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import * as LlmPiAi from '@shres-code/shres-code-llm-pi-ai'
import { discoverModels } from '../src/discovery.ts'
import { assemble, type AssembledResult } from './assemble.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

function ask(text: string) {
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

async function localOllamaReachable(): Promise<boolean> {
  try {
    const models = await discoverModels({
      baseURL: 'http://localhost:11434/v1',
      api: 'openai-completions',
      signal: AbortSignal.timeout(1500),
    })
    return models.length > 0
  } catch {
    return false
  }
}

const ollamaCloudKey = process.env.OLLAMA_API_KEY
const openrouterKey = process.env.OPENROUTER_API_KEY
const xaiKey = process.env.XAI_API_KEY
const moonshotKey = process.env.MOONSHOT_API_KEY
const anthropicKey = process.env.ANTHROPIC_API_KEY

describe.skipIf(!openrouterKey)('openrouter e2e', () => {
  it('discovers vision from the live listing, not the pinned catalog', async () => {
    const models = await discoverModels({
      provider: 'openrouter',
      api: 'openai-completions',
      apiKey: openrouterKey ?? '',
    })
    expect(models.find(model => model.id === 'meta/muse-spark-1.3')?.input)
      .toEqual(['text', 'image'])
    expect(models.find(model => model.id === 'meta/muse-spark-1.3')?.audioInput).toBe(true)
    expect(models.find(model => model.id === 'moonshotai/kimi-k2-thinking')?.input)
      .toEqual(['text'])
  })
})

describe.skipIf(!ollamaCloudKey)('ollama-cloud e2e', () => {
  it('discovers vision from /api/show, not from GET /models', async () => {
    const models = await discoverModels({
      provider: 'ollama-cloud',
      baseURL: 'https://ollama.com/v1',
      api: 'openai-completions',
      apiKey: ollamaCloudKey ?? '',
    })
    expect(models.find(model => model.id === 'kimi-k3' || model.id === 'kimi-k3:cloud')?.input)
      .toEqual(['text', 'image'])
    expect(models.find(model => model.id.startsWith('deepseek-v4-flash'))?.input)
      .toEqual(['text'])
    expect(models.find(model => model.id === 'kimi-k3' || model.id === 'kimi-k3:cloud')?.contextWindow)
      .toBe(1_048_576)
  })

  it('streams a :cloud model id', async () => {
    const ctx = await harness({
      providers: {
        'ollama-cloud': {
          apiKeyEnv: 'OLLAMA_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://ollama.com/v1',
          models: [{ id: 'deepseek-v4-flash:cloud', contextWindow: 1_048_576, maxTokens: 256 }],
        },
      },
    })
    const result = await assemble(ctx, {
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:cloud',
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 32,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })
})

describe.skipIf(!xaiKey)('xai e2e', () => {
  it('streams through the catalog route', async () => {
    const ctx = await harness({ providers: { xai: { apiKeyEnv: 'XAI_API_KEY' } } })
    const models = await ctx.llm.listModels('xai')
    const model = models[0]?.id
    if (model === undefined) throw new Error('xai catalog listed no models')
    const result = await assemble(ctx, {
      provider: 'xai',
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 32,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })
})

describe.skipIf(!moonshotKey)('moonshotai e2e', () => {
  it('streams through the catalog route', async () => {
    const ctx = await harness({ providers: { moonshotai: { apiKeyEnv: 'MOONSHOT_API_KEY' } } })
    const models = await ctx.llm.listModels('moonshotai')
    const model = models[0]?.id
    if (model === undefined) throw new Error('moonshotai catalog listed no models')
    const result = await assemble(ctx, {
      provider: 'moonshotai',
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 32,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })
})

describe.skipIf(!anthropicKey)('anthropic e2e', () => {
  it('streams through the catalog route', async () => {
    const ctx = await harness({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
    const models = await ctx.llm.listModels('anthropic')
    const model = models.find(entry => entry.id.includes('sonnet'))?.id ?? models[0]?.id
    if (model === undefined) throw new Error('anthropic catalog listed no models')
    const result = await assemble(ctx, {
      provider: 'anthropic',
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 32,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })
})

const localOllama = await localOllamaReachable()

describe.skipIf(!localOllama)('ollama-local e2e', () => {
  it('lists and chats with a local model', async () => {
    const listed = await discoverModels({
      baseURL: 'http://localhost:11434/v1',
      api: 'openai-completions',
    })
    const model = listed[0]?.id
    if (model === undefined) throw new Error('local Ollama listed no models')
    const ctx = await harness({
      providers: {
        'ollama-local': {
          api: 'openai-completions',
          baseURL: 'http://localhost:11434/v1',
          headers: { Authorization: 'Bearer ollama' },
          models: [{ id: model, contextWindow: 131_072, maxTokens: 256 }],
        },
      },
    })
    const result = await assemble(ctx, {
      provider: 'ollama-local',
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 32,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })
})
