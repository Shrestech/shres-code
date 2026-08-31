/**
 * The mounted route: registry facts, model advertisement, one stream through
 * the shared pi-ai adapter against a local proxy stand-in, the not-logged-in
 * failure, and registry disposal.
 */

import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import type { FinishReason, GenerateOptions, TokenUsage } from '@shres-code/shres-code-llm'
import * as LlmGrokSession from '../src/index.ts'
import type { Config as GrokSessionConfig } from '../src/config.ts'
import { ENTRY_KEY, entryRaw, farFuture, mockUpstream, textTurn, writeAuthDocument } from './helpers.ts'

let authPath: string | undefined
let upstream: Awaited<ReturnType<typeof mockUpstream>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  authPath = undefined
})

/** Boot the real plugin over a temp document and a local proxy stand-in. */
async function boot(config: GrokSessionConfig = {}): Promise<Context> {
  authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
  upstream = await mockUpstream(textTurn('hello'))
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  const pluginConfig: GrokSessionConfig = {
    authPath: config.authPath ?? authPath,
    // The proxy serves versioned paths; the mock records what arrives.
    baseURL: config.baseURL ?? `${upstream.url}/v1`,
  }
  if (config.enabled !== undefined) pluginConfig.enabled = config.enabled
  await context.plugin(LlmGrokSession, pluginConfig)
  return context
}

/** Drive ctx.llm.stream through the production assembler. */
async function assemble(context: Context, request: Omit<GenerateOptions, 'provider'>): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'grok-session', ...request })) assembler.push(chunk)
  const message = assembler.message({ kind: 'model', provider: 'grok-session', model: request.model })
  return {
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    finish: assembler.finish,
  }
}

describe('llm-grok-session route', () => {
  it('registers one route advertising the shipped catalog and efforts', async () => {
    const context = await boot()
    expect(context.llm.listProviders().map(provider => provider.id)).toEqual(['grok-session'])
    const models = await context.llm.listModels('grok-session')
    expect(models.map(model => model.id)).toEqual(['grok-4.6', 'grok-4.5'])
    const resolved = await context.llm.resolveModelInfo('grok-session', 'grok-4.6')
    expect(resolved.context).toEqual({ contextWindow: 500_000 })
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('streams one text turn through the proxy with the document token as bearer', async () => {
    const context = await boot()
    const result = await assemble(context, { model: 'grok-4.6', messages: [] })
    expect(result.text).toBe('hello')
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 })
    const document = JSON.parse(await readFile(authPath!, 'utf8')) as Record<string, { key: string }>
    expect(upstream!.paths[0]).toBe('/v1/responses')
    expect(upstream!.authHeaders[0]).toBe(`Bearer ${document[ENTRY_KEY]!.key}`)
  })

  it('fails the stream with the login posture when no session document exists', async () => {
    const context = await boot({ authPath: '/nonexistent/grok/auth.json' })
    // The llm runtime normalizes an adapter throw into a terminal finish, so
    // the code is what consumers see.
    const result = await assemble(context, { model: 'grok-4.6', messages: [] })
    const finish = result.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/grok login/)
  })

  it('enabled: false keeps the directory entry but withdraws the live route', async () => {
    const context = await boot({ enabled: false })
    expect(context.llm.listProviders()).toEqual([])
    expect(context.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['grok-session'])
  })

  it('disposal withdraws both the route and the directory entry', async () => {
    const context = await boot()
    const llm = context.llm
    expect(llm.listProviders()).toHaveLength(1)
    await context.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual([])
    ctx = undefined
  })
})
