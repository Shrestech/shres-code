/**
 * The mounted route: registry facts, model advertisement, one stream through
 * the real pi-ai adapter against a loopback Anthropic Messages stand-in, the
 * not-logged-in failure, image admission, replay degradation, the enabled
 * toggle, and registry disposal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createMessage, createUserMessage } from '@shres-code/shres-code-llm'
import type { FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@shres-code/shres-code-llm'
import * as LlmClaudeSession from '../src/index.ts'
import type { Config as ClaudeSessionConfig } from '../src/config.ts'
import { accessToken, mockAnthropic, writeCredentialsDocument } from './helpers.ts'

let authPath: string | undefined
let upstream: Awaited<ReturnType<typeof mockAnthropic>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  authPath = undefined
})

/** Boot the real plugin over a temp credential document and a loopback stand-in. */
async function boot(config: ClaudeSessionConfig = {}): Promise<Context> {
  authPath = await writeCredentialsDocument()
  upstream = await mockAnthropic()
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  const pluginConfig: ClaudeSessionConfig = {
    authPath: config.authPath ?? authPath,
    useKeychain: config.useKeychain ?? false,
    baseURL: config.baseURL ?? upstream.url,
  }
  if (config.enabled !== undefined) pluginConfig.enabled = config.enabled
  await context.plugin(LlmClaudeSession, pluginConfig)
  return context
}

/** Drive ctx.llm.stream through the production assembler, keeping the raw chunks. */
async function assemble(
  context: Context,
  request: Omit<GenerateOptions, 'provider'>,
): Promise<{ text: string; reasoning: string; usage?: TokenUsage; finish: FinishReason; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'claude-session', ...request })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  const message = assembler.message({ kind: 'model', provider: 'claude-session', model: request.model })
  return {
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    reasoning: message.content.filter(block => block.type === 'reasoning').map(block => block.text).join(''),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    finish: assembler.finish,
    chunks,
  }
}

describe('llm-claude-session route', () => {
  it('registers one route advertising the shipped catalog and efforts', async () => {
    const context = await boot()
    expect(context.llm.listProviders()).toEqual([{ id: 'claude-session', name: 'Claude (subscription)' }])
    const models = await context.llm.listModels('claude-session')
    expect(models.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5'])
    const resolved = await context.llm.resolveModelInfo('claude-session', 'claude-opus-5-5')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('streams reasoning and text with cache usage over the OAuth bearer', async () => {
    const context = await boot()
    const result = await assemble(context, { model: 'claude-opus-5', messages: [] })
    expect(result.text).toBe('hello')
    expect(result.reasoning).toBe('mulling it over')
    expect(result.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'mulling it over' })
    expect(result.chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'hello' })
    // The pinned wire: path, verb, and the CLI's own bearer credential.
    expect(upstream!.requests[0]!.method).toBe('POST')
    expect(upstream!.requests[0]!.path).toBe('/v1/messages')
    expect(upstream!.requests[0]!.headers.authorization).toBe(`Bearer ${accessToken('default')}`)
  })

  it('fails the stream with the login posture when no credential document exists', async () => {
    const context = await boot({ authPath: '/nonexistent/claude/.credentials.json' })
    const result = await assemble(context, { model: 'claude-opus-5', messages: [] })
    const finish = result.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/\.credentials\.json/)
    expect(upstream!.requests).toHaveLength(0)
  })

  it('demands the durable attachment service for an admitted image block', async () => {
    const context = await boot()
    const message = createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'sha256-1',
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        } as never,
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const result = await assemble(context, { model: 'claude-opus-5', messages: [message] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } })
    expect(upstream!.requests).toHaveLength(0)
  })

  it('warns once per degraded history message across requests', async () => {
    const context = await boot()
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    // A session resumed from a log written before the replay version changed:
    // two assistant messages carry replay state this build cannot use.
    const degraded = (text: string) => createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: {
        kind: 'model',
        ...{
          provider: 'claude-session',
          model: 'claude-opus-5',
          replayState: { response: { kind: 'pi-ai', version: 2 }, blocks: [{ type: 'text' }] },
        },
      },
    })
    const history: Message[] = [degraded('first answer'), degraded('second answer')]
    for (const text of ['one', 'two', 'three']) {
      history.push(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } }))
      const assembler = new BlockAssembler()
      for await (const chunk of context.llm.stream({ provider: 'claude-session', model: 'claude-opus-5', messages: [...history] })) {
        assembler.push(chunk)
      }
      expect(assembler.finish).toEqual({ kind: 'stop' })
    }
    const warnings = warn.mock.calls.filter(([line]) => String(line).includes('unusable replay state'))
    expect(warnings).toHaveLength(2)
    expect(String(warnings[0]![0])).toContain('llm-claude-session:')
    warn.mockRestore()
  })

  it('enabled: false keeps the directory entry but withdraws the live route', async () => {
    const context = await boot({ enabled: false })
    expect(context.llm.listProviders()).toEqual([])
    expect(context.llm.listConfigurableProviders()).toEqual([
      {
        provider: 'claude-session',
        displayName: 'Claude (subscription)',
        settingsNs: 'llm-claude-session',
        settingsPath: [],
        declared: false,
      },
    ])
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
