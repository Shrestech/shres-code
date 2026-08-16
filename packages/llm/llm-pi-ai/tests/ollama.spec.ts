/** Ollama local (keyless) and cloud (`:cloud` ids) wire shapes. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import LlmRuntime, { createUserMessage } from '@roos-code/roos-code-llm'
import * as LlmPiAi from '@roos-code/roos-code-llm-pi-ai'
import { discoverModels } from '../src/discovery.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

describe('Ollama wire shapes', () => {
  it('reads an OpenAI-compatible GET /v1/models listing', async () => {
    const server = await mockServer([{
      json: {
        data: [
          { id: 'llama3.2', name: 'Llama 3.2' },
          { id: 'deepseek-v4-flash:cloud', context_length: 1_048_576 },
        ],
      },
    }])

    const models = await discoverModels({
      baseURL: `${server.url}/v1`,
      api: 'openai-completions',
    })

    expect(server.paths).toEqual(['/v1/models'])
    expect(models).toEqual([
      { id: 'llama3.2', name: 'Llama 3.2' },
      { id: 'deepseek-v4-flash:cloud', contextWindow: 1_048_576 },
    ])
  })

  it('sends a dummy Bearer token on the keyless local route', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'ollama-local': {
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          headers: { Authorization: 'Bearer ollama' },
          models: [{ id: 'llama3.2', contextWindow: 131_072, maxTokens: 8192 }],
        },
      },
    })

    const result = await assemble(ctx, {
      provider: 'ollama-local',
      model: 'llama3.2',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer ollama')
    await ctx.fiber.dispose()
  })

  it('chats with an Ollama cloud :cloud model id', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'ollama-cloud': {
          apiKeyEnv: 'OLLAMA_API_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'deepseek-v4-flash:cloud',
            contextWindow: 1_048_576,
            maxTokens: 32_768,
          }],
        },
      },
    })

    const result = await assemble(ctx, {
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:cloud',
      messages: [],
    })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(server.requests).toHaveLength(0)

    process.env.OLLAMA_API_KEY = 'ollama-cloud-key'
    try {
      const keyed = await assemble(ctx, {
        provider: 'ollama-cloud',
        model: 'deepseek-v4-flash:cloud',
        messages: [],
      })
      expect(keyed.finish).toEqual({ kind: 'stop' })
      expect((server.requests[0] as { model?: string }).model).toBe('deepseek-v4-flash:cloud')
      expect(server.headers[0]?.authorization).toBe('Bearer ollama-cloud-key')
    } finally {
      delete process.env.OLLAMA_API_KEY
    }
    await ctx.fiber.dispose()
  })
})
