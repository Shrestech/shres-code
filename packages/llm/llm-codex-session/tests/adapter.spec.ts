/**
 * The mounted route: registry facts, model advertisement, one stream through
 * the shared pi-ai adapter against a local backend stand-in, the
 * not-logged-in failure, and registry disposal.
 */

import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import type { FinishReason, GenerateOptions, TokenUsage } from '@shres-code/shres-code-llm'
import * as LlmCodexSession from '../src/index.ts'
import type { Config as CodexSessionConfig } from '../src/config.ts'
import { farFuture, mockUpstream, textTurn, tokensRaw, writeAuthDocument } from './helpers.ts'

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

/** Boot the real plugin over a temp document and a local backend stand-in. */
async function boot(config: CodexSessionConfig = {}): Promise<Context> {
  authPath = await writeAuthDocument(tokensRaw(farFuture()))
  upstream = await mockUpstream(textTurn('hello'))
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  const pluginConfig: CodexSessionConfig = {
    authPath: config.authPath ?? authPath,
    // The backend serves unversioned paths; the mock records what arrives.
    baseURL: config.baseURL ?? upstream.url,
  }
  if (config.enabled !== undefined) pluginConfig.enabled = config.enabled
  await context.plugin(LlmCodexSession, pluginConfig)
  return context
}

/** Drive ctx.llm.stream through the production assembler. */
async function assemble(context: Context, request: Omit<GenerateOptions, 'provider'>): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'codex-session', ...request })) assembler.push(chunk)
  const message = assembler.message({ kind: 'model', provider: 'codex-session', model: request.model })
  return {
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    finish: assembler.finish,
  }
}

describe('llm-codex-session route', () => {
  it('registers one route advertising the shipped catalog and efforts', async () => {
    const context = await boot()
    expect(context.llm.listProviders().map(provider => provider.id)).toEqual(['codex-session'])
    const models = await context.llm.listModels('codex-session')
    expect(models.map(model => model.id)).toEqual(['gpt-6-astra', 'gpt-5.6-luna'])
    const resolved = await context.llm.resolveModelInfo('codex-session', 'gpt-6-astra')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // The shipped lower bound, not the adapter's fallback, is what pressure policy reads.
    expect(resolved.context).toEqual({ contextWindow: 311_000 })
  })

  it('keeps an unbounded shipped model on the adapter fallback window', async () => {
    const context = await boot()
    const resolved = await context.llm.resolveModelInfo('codex-session', 'gpt-5.6-luna')
    expect(resolved.context).toEqual({ contextWindow: 262_144 })
  })

  it('streams one text turn with the document token as bearer and the account header', async () => {
    const context = await boot()
    const result = await assemble(context, { model: 'gpt-6-astra', messages: [] })
    expect(result.text).toBe('hello')
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 })
    const document = JSON.parse(await readFile(authPath!, 'utf8')) as { tokens: { access_token: string; account_id: string } }
    expect(upstream!.paths[0]).toBe('/responses')
    expect(upstream!.authHeaders[0]).toBe(`Bearer ${document.tokens.access_token}`)
    expect(upstream!.accountHeaders[0]).toBe(document.tokens.account_id)
  })

  it('keeps a completed turn whose input exceeds the declared window', async () => {
    const context = await boot()
    // The ChatGPT backend fails an oversized request rather than truncating it,
    // so a completed response is authoritative even when the input it counted
    // exceeds the harness's declared capacity (the production wedge: a
    // 311,781-token prompt answered and then discarded as an overflow).
    upstream!.respondStream(textTurn('hello', { input: 311_781, cached: 302_976, output: 87 }))

    const result = await assemble(context, { model: 'gpt-6-astra', messages: [] })

    expect(result.text).toBe('hello')
    // The backend reports the whole prompt and breaks out the cached subset;
    // pi-ai keeps the uncached remainder as inputTokens.
    expect(result.usage).toMatchObject({ inputTokens: 8_805, cacheReadTokens: 302_976 })
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('strips max_output_tokens from the outgoing body the backend rejects', async () => {
    const context = await boot()
    await assemble(context, { model: 'gpt-6-astra', messages: [] })
    const body = upstream!.bodies[0] as Record<string, unknown>
    expect('max_output_tokens' in body).toBe(false)
  })

  it('fails the stream with the login posture when no session document exists', async () => {
    const context = await boot({ authPath: '/nonexistent/codex/auth.json' })
    // The llm runtime normalizes an adapter throw into a terminal finish, so
    // the code is what consumers see.
    const result = await assemble(context, { model: 'gpt-6-astra', messages: [] })
    const finish = result.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/codex login/)
  })

  it('enabled: false keeps the directory entry but withdraws the live route', async () => {
    const context = await boot({ enabled: false })
    expect(context.llm.listProviders()).toEqual([])
    expect(context.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['codex-session'])
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
