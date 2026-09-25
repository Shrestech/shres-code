/**
 * The mounted route: registry facts, default-off behavior, model
 * advertisement, one stream through the shared pi-ai adapter against a local
 * proxy stand-in, the missing-key failure, the service-tier body splice,
 * once-per-message replay-degradation warnings, and registry disposal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createMessage, createUserMessage } from '@shres-code/shres-code-llm'
import type { FinishReason, GenerateOptions, Message, TokenUsage } from '@shres-code/shres-code-llm'
import * as LlmXaiApiKey from '../src/index.ts'
import type { Config as XaiConfig } from '../src/config.ts'
import { mockUpstream, textTurn } from './helpers.ts'
import type { MockUpstream } from './helpers.ts'

let upstream: MockUpstream | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
})

interface BootOptions {
  /** When true, mounts a credentials stub resolving XAI_API_KEY. */
  withKey?: boolean
  /** When true, mounts a credentials stub that resolves nothing. */
  withKeylessSeam?: boolean
  config?: XaiConfig
}

/** Boot the real plugin over a local xAI stand-in. */
async function boot(options: BootOptions = {}): Promise<Context> {
  upstream = await mockUpstream(textTurn('hello'))
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  if (options.withKey) {
    context.provide('credentials', {
      resolve: async () => ({ value: 'xai-test-key', source: 'test' }),
    })
  } else if (options.withKeylessSeam) {
    context.provide('credentials', {
      resolve: async () => undefined,
    })
  }
  const config: XaiConfig = options.config ?? {}
  if (config.baseURL === undefined) config.baseURL = upstream.url + '/v1'
  await context.plugin(LlmXaiApiKey, config)
  return context
}

/** Drive ctx.llm.stream through the production assembler. */
async function assemble(
  context: Context,
  request: Omit<GenerateOptions, 'provider'>,
): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'xai-apikey', ...request })) {
    assembler.push(chunk)
  }
  const message = assembler.message({ kind: 'model', provider: 'xai-apikey', model: request.model })
  return {
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    finish: assembler.finish,
  }
}

describe('llm-xai-apikey route', () => {
  it('ships off by default and keeps the route configurable', async () => {
    const context = await boot()
    expect(context.llm.listProviders()).toEqual([])
    expect(context.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['xai-apikey'])
  })

  it('enabled: false keeps the directory entry but withdraws the live route', async () => {
    const context = await boot({ config: { enabled: false } })
    expect(context.llm.listProviders()).toEqual([])
    expect(context.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['xai-apikey'])
  })

  it('registers one route advertising the shipped catalog when enabled', async () => {
    const context = await boot({ withKey: true, config: { enabled: true } })
    expect(context.llm.listProviders().map(provider => provider.id)).toEqual(['xai-apikey'])
    const models = await context.llm.listModels('xai-apikey')
    expect(models.map(model => model.id)).toEqual(['grok-4.6', 'grok-4.5', 'grok-4.5-mini', 'grok-4.5-vision'])
  })

  it('fails the stream with the missing-credential posture when enabled without a key', async () => {
    const context = await boot({ withKeylessSeam: true, config: { enabled: true } })
    const result = await assemble(context, { model: 'grok-4.6', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') return
    expect(result.finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(result.finish.failure.message).toMatch(/no API key/)
  })

  it('resolves the key through the credentials capability and splices service_tier on priority', async () => {
    const context = await boot({
      withKey: true,
      config: {
        enabled: true,
        models: [
          { id: 'grok-4.6', serviceTier: 'priority' },
          { id: 'grok-4.5', serviceTier: 'default' },
        ],
      },
    })
    await assemble(context, { model: 'grok-4.6', messages: [] })
    await assemble(context, { model: 'grok-4.5', messages: [] })
    expect(upstream!.authHeaders).toEqual(['Bearer xai-test-key', 'Bearer xai-test-key'])
    const priorityBody = upstream!.bodies[0] as Record<string, unknown>
    const defaultBody = upstream!.bodies[1] as Record<string, unknown>
    expect(priorityBody.service_tier).toBe('priority')
    expect('service_tier' in defaultBody).toBe(false)
  })

  it('warns once per degraded history message across requests', async () => {
    const context = await boot({ withKey: true, config: { enabled: true } })
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    // A session resumed from a log written before the replay version changed:
    // two assistant messages carry replay state this build cannot use.
    const degraded = (text: string) => createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: {
        kind: 'model',
        ...{
          provider: 'xai-apikey',
          model: 'grok-4.6',
          replayState: { response: { kind: 'pi-ai', version: 2 }, blocks: [{ type: 'text' }] },
        },
      },
    })
    const history: Message[] = [degraded('first answer'), degraded('second answer')]
    for (const text of ['one', 'two', 'three']) {
      history.push(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } }))
      const result = await assemble(context, { model: 'grok-4.6', messages: [...history] })
      expect(result.finish).toEqual({ kind: 'stop' })
    }
    const warnings = warn.mock.calls.filter(([line]) => String(line).includes('unusable replay state'))
    expect(warnings).toHaveLength(2)
    expect(String(warnings[0]![0])).toContain('llm-xai-apikey:')
    warn.mockRestore()
  })

  it('disposal withdraws both the route and the directory entry', async () => {
    const context = await boot({ withKey: true, config: { enabled: true } })
    const llm = context.llm
    expect(llm.listProviders()).toHaveLength(1)
    await context.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual([])
    ctx = undefined
  })
})
