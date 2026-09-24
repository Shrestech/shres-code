/**
 * Gate, discovery, and execution of the Grok X search tools through a real
 * agent loop on a non-Grok model, the real llm-grok-session route, and a
 * local stand-in for the Grok subscription proxy.
 */

import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { assembleContextFor } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { CodeRuntime } from '@shres-code/shres-code-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@shres-code/shres-code-code-runtime'
import { WorkerThreadCodeRuntime } from '@shres-code/shres-code-code-runtime-worker-thread'
import { CallId, createUserMessage } from '@shres-code/shres-code-llm'
import * as LlmGrokSession from '@shres-code/shres-code-llm-grok-session'
import { GROK_SESSION_SETTINGS_NAMESPACE } from '@shres-code/shres-code-llm-grok-session'
import type { Config as GrokSessionConfig } from '@shres-code/shres-code-llm-grok-session'
import { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import z from '@shres-code/schemastery'
import { SettingsProvider, settingsNamespace } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import { renderPrompt } from '@shres-code/shres-code-system-prompt'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ENTRY_KEY, entryRaw, farFuture, mockUpstream, textTurn, writeAuthDocument } from '../../llm-grok-session/tests/helpers.ts'
import type { MockUpstream } from '../../llm-grok-session/tests/helpers.ts'
import * as ToolGrokXSearch from '../src/index.ts'
import {
  boundGrokXResult,
  GROK_X_SEARCH_SYSTEM,
  GROK_X_TOOL_SPECS,
  grokXToolsEnabled,
  renderGrokXResult,
  runGrokXSearch,
  xPostId,
} from '../src/index.ts'
import type { ResolvedConfig } from '../src/index.ts'

const TOOL_NAMES = ['x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']

/** A settings provider over an in-memory document. */
class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** A TypeScript code runtime that never runs; only its SDK prompt is read. */
class IdleRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
}

/** One Responses stream in which Grok runs the given X operations, then answers. */
function grokTurn(operations: readonly string[], text: string): string[] {
  const calls = operations.flatMap((name, index) => {
    const item = { id: `ctc_item_${index}`, call_id: `call_ctc_${index}`, type: 'custom_tool_call', name, input: 'q', status: 'completed' }
    return [
      JSON.stringify({ type: 'response.output_item.added', output_index: index, item }),
      JSON.stringify({ type: 'response.output_item.done', output_index: index, item }),
    ]
  })
  const [created, ...rest] = textTurn(text).map((event) => {
    const parsed = JSON.parse(event) as Record<string, unknown>
    if (typeof parsed['output_index'] === 'number') parsed['output_index'] = operations.length
    return JSON.stringify(parsed)
  })
  return [created!, ...calls, ...rest]
}

/** A Responses stream whose only output is a function call to a name the request never offered. */
function functionCallTurn(): string[] {
  const item = { type: 'function_call', id: 'fc_item_1', call_id: 'call_fc_1', name: 'web_fetch', arguments: '{}' }
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed' } }),
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }),
  ]
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

interface Booted {
  ctx: Context
  upstream: MockUpstream
  main: MockAdapter
  grok: ReturnType<Context['plugin']>
}

/** Boot the real loop, settings, grok-session route, and tools plugin. */
async function boot(options: {
  section?: Record<string, unknown>
  grokEvents?: string[]
  mainScript?: ConstructorParameters<typeof MockAdapter>[0]
  toolsFirst?: boolean
  mode?: 'native' | 'code' | 'code-worker'
  baseURL?: string
} = {}): Promise<Booted> {
  const authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
  const upstream = await mockUpstream(options.grokEvents ?? grokTurn(['x_keyword_search'], 'Found https://x.com/xai/status/1'))
  closers.push(() => upstream.close())
  const ctx = new Context()
  closers.push(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: options.mode === undefined || options.mode === 'native' ? 'native' : 'code' } })
  if (options.mode === 'code') await ctx.plugin(IdleRuntime)
  if (options.mode === 'code-worker') await ctx.plugin(WorkerThreadCodeRuntime, {})
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentLoop, { agents: [] })
  const main = new MockAdapter(options.mainScript ?? [])
  ctx.llm.registerAdapter(['mock'], main)
  const grokConfig = {
    authPath,
    baseURL: options.baseURL ?? `${upstream.url}/v1`,
    agentXTools: true,
    ...options.section,
  } as GrokSessionConfig
  let grok: ReturnType<Context['plugin']>
  if (options.toolsFirst === true) {
    await ctx.plugin(ToolGrokXSearch)
    grok = ctx.plugin(LlmGrokSession, grokConfig)
    await grok
  } else {
    grok = ctx.plugin(LlmGrokSession, grokConfig)
    await grok
    await ctx.plugin(ToolGrokXSearch)
  }
  return { ctx, upstream, main, grok }
}

function visibleNames(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).filter(name => TOOL_NAMES.includes(name))
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function runAgent(ctx: Context, prompt: string): Promise<SessionEvent[]> {
  const agent = ctx.agentLoop.create(SessionId('caller'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return [...agent.session.events]
}

describe('tool descriptions', () => {
  it('pin the model-facing descriptions verbatim', () => {
    const suffix = 'Grok (your Grok subscription) runs this on its servers. Shres Code sends your request to Grok and Grok chooses which X search operations to run, so it may use a different operation than this tool\'s name. The result lists the X operations Grok ran and cites post URLs. Each call uses Grok plan quota; it fails if Grok sign-in or plan does not allow it.'
    expect(GROK_X_TOOL_SPECS.map(spec => [spec.name, `${spec.lead} ${suffix}`])).toEqual([
      ['x_keyword_search', `Ask Grok to search X posts by keywords. X search operators such as from:handle, since:YYYY-MM-DD and quoted phrases are passed through as written. ${suffix}`],
      ['x_semantic_search', `Ask Grok to find X posts matching a natural-language description. ${suffix}`],
      ['x_user_search', `Ask Grok to find X accounts by name, handle or topic. ${suffix}`],
      ['x_thread_fetch', `Ask Grok to fetch an X post (URL or numeric id) with its thread context. ${suffix}`],
    ])
  })
})

describe('settings gate', () => {
  it('opens only when enabled, hostedXSearch, and agentXTools are all on', () => {
    expect(grokXToolsEnabled({ enabled: true, hostedXSearch: true, agentXTools: true })).toBe(true)
    expect(grokXToolsEnabled({ enabled: true, hostedXSearch: true, agentXTools: false })).toBe(false)
    expect(grokXToolsEnabled({ enabled: true, hostedXSearch: false, agentXTools: true })).toBe(false)
    expect(grokXToolsEnabled({ enabled: false, hostedXSearch: true, agentXTools: true })).toBe(false)
    expect(grokXToolsEnabled(undefined)).toBe(false)
  })

  it('registers and withdraws the tools live as the grok-session section changes', async () => {
    const { ctx, grok } = await boot({ section: { agentXTools: false } })
    expect(visibleNames(ctx)).toEqual([])
    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { agentXTools: true })
    await settle()
    expect(visibleNames(ctx)).toEqual(TOOL_NAMES)
    // Another namespace attaching leaves the tools as they are.
    await ctx.plugin({
      inject: ['settings'],
      apply: (child: Context) => { child.settings.register(settingsNamespace('stride-unrelated'), z.object({ on: z.boolean().default(true) })) },
    })
    expect(visibleNames(ctx)).toEqual(TOOL_NAMES)
    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { hostedXSearch: false })
    await settle()
    expect(visibleNames(ctx)).toEqual([])
    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { hostedXSearch: true, enabled: false })
    await settle()
    expect(visibleNames(ctx)).toEqual([])
    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { enabled: true })
    await settle()
    expect(visibleNames(ctx)).toEqual(TOOL_NAMES)
    await grok.dispose()
    expect(visibleNames(ctx)).toEqual([])
  })

  it('follows a grok-session plugin that loads after the tools plugin', async () => {
    const { ctx } = await boot({ toolsFirst: true })
    expect(visibleNames(ctx)).toEqual(TOOL_NAMES)
  })

  it('shows the tools in an existing agent\'s code-mode SDK only while enabled', async () => {
    const { ctx } = await boot({ mode: 'code', section: { agentXTools: false } })
    const agent = ctx.agentLoop.create(SessionId('existing'), { provider: 'mock', model: 'mock' })
    const sdk = async (): Promise<string> => renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent)))
    expect(await sdk()).not.toContain('x_keyword_search')
    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { agentXTools: true })
    await settle()
    const enabled = await sdk()
    for (const name of TOOL_NAMES) expect(enabled).toContain(name)
    expect(visibleNames(ctx, agent)).toEqual(TOOL_NAMES)
    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { agentXTools: false })
    await settle()
    expect(await sdk()).not.toContain('x_keyword_search')
  })
})

describe('code mode with the worker-thread runtime', () => {
  it('lets an existing agent call the tool from run_code once enabled, and denies it again once disabled', async () => {
    const program = "const r = await tools.x_keyword_search({ query: 'from:xai grok' }); return r.operations.map(o => o.name).join(',') + ' ' + r.answer"
    const { ctx, upstream, main } = await boot({
      mode: 'code-worker',
      section: { agentXTools: false },
      grokEvents: grokTurn(['x_keyword_search'], 'xAI posted https://x.com/xai/status/9'),
      mainScript: [
        toolCallResponse('run-1', 'run_code', { code: program, description: 'Search X' }),
        textResponse('first done'),
        toolCallResponse('run-2', 'run_code', { code: program, description: 'Search X again' }),
        textResponse('second done'),
      ],
    })
    const agent = ctx.agentLoop.create(SessionId('code-caller'), { provider: 'mock', model: 'mock' })
    const turn = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    const results = (): string[] => agent.session.events
      .filter(event => event.type === 'tool/result')
      .map(event => JSON.stringify(event.data))

    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { agentXTools: true })
    await settle()
    await turn('search X')
    expect(main.requests[0]?.system).toContain('x_keyword_search')
    expect(results()[0]).toContain('x_keyword_search xAI posted https://x.com/xai/status/9')
    const request = agent.session.events.find(event => event.type === 'grok-x-search/request')
    expect(request?.data).toMatchObject({ tool: 'x_keyword_search', route: { provider: 'grok-session' }, hostedTools: ['x_search'] })
    expect(request?.data.callId).not.toBe('run-1')
    expect(upstream.bodies).toHaveLength(1)
    // The nested SDK call carries the calling agent: its session id reaches the Grok request.
    expect((upstream.bodies[0] as Record<string, unknown>)['prompt_cache_key']).toBe('code-caller')

    await ctx.settings.update(GROK_SESSION_SETTINGS_NAMESPACE, { agentXTools: false })
    await settle()
    await turn('search X again')
    expect(main.requests[2]?.system).not.toContain('x_keyword_search')
    // The rendered SDK no longer binds the tool, so the program fails before any Grok request.
    expect(results()[1]).toContain('"isError":true')
    expect(results()[1]).toContain('tools.x_keyword_search is not a function')
    expect(upstream.bodies).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'grok-x-search/request')).toHaveLength(1)
  }, 30_000)
})

describe('agent loop on a non-Grok model', () => {
  it('asks Grok with only hosted x_search, records the request first, and returns operations and cited text', async () => {
    const { ctx, upstream, main } = await boot({
      grokEvents: grokTurn(['x_keyword_search', 'x_user_search', 'x_keyword_search'], 'xAI posted https://x.com/xai/status/42'),
      mainScript: [toolCallResponse('call-x', 'x_keyword_search', { query: '  from:xai grok  ' }), textResponse('done')],
    })
    const events = await runAgent(ctx, 'what did xai post?')
    // The calling model saw all four tools with their descriptions.
    const offered = (main.requests[0]?.tools ?? []).map(tool => tool.name)
    for (const name of TOOL_NAMES) expect(offered).toContain(name)
    // One Grok request: no function tools, only the hosted x_search entry.
    expect(upstream.bodies).toHaveLength(1)
    const body = upstream.bodies[0] as Record<string, unknown>
    expect(body['tools']).toEqual([{ type: 'x_search' }])
    expect(body['model']).toBe('grok-4.6')
    expect(JSON.stringify(body)).toContain(JSON.stringify(JSON.stringify({ operation: 'x_keyword_search', query: 'from:xai grok' })).slice(1, -1))
    const types = events.map(event => event.type)
    const request = events.find(event => event.type === 'grok-x-search/request')
    expect(request?.ignorable).toBe(true)
    expect(request?.data).toMatchObject({
      tool: 'x_keyword_search',
      callId: 'call-x',
      route: { provider: 'grok-session', model: 'grok-4.6' },
      system: GROK_X_SEARCH_SYSTEM,
      hostedTools: ['x_search'],
      maxTokens: 2048,
    })
    expect(types.indexOf('grok-x-search/request')).toBeLessThan(types.indexOf('tool/result'))
    const result = events.find(event => event.type === 'tool/result')
    const text = JSON.stringify(result?.data)
    expect(text).toContain('X operations Grok ran: x_keyword_search (2 calls), x_user_search.')
    expect(text).not.toContain('ctc_item')
    expect(text).toContain('https://x.com/xai/status/42')
    expect(text).not.toContain('UNKNOWN_TOOL')
  })

  it.each([
    ['no hosted X evidence', textTurn('I think xAI posted something.'), /without running an X search/],
    ['an unexpected local call', functionCallTurn(), /asked for a local tool/],
  ])('fails the tool call on %s', async (_label, grokEvents, message) => {
    const { ctx } = await boot({
      grokEvents,
      mainScript: [toolCallResponse('call-x', 'x_semantic_search', { query: 'grok news' }), textResponse('done')],
    })
    const events = await runAgent(ctx, 'search')
    const result = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(result?.data)).toMatch(message)
    expect(JSON.stringify(result?.data)).toContain('"isError":true')
  })
})

describe('runGrokXSearch', () => {
  const config: ResolvedConfig = { model: 'grok-4.6', timeoutMs: 180_000, maxOutputTokens: 2048, maxResultChars: 20_000 }
  const spec = GROK_X_TOOL_SPECS[0]!

  function exec(ctx: Context, signal = new AbortController().signal) {
    const agent = ctx.agentLoop.create(SessionId(`direct-${Math.random()}`), { provider: 'mock', model: 'mock' })
    return { agent, callId: CallId('call-direct'), signal }
  }

  it('reports that Grok returned no answer text when an X search ran without one', async () => {
    const { ctx } = await boot({ grokEvents: grokTurn(['x_user_search'], '') })
    const value = await runGrokXSearch(ctx, { config, lifetime: new AbortController().signal, isEnabled: () => true }, spec, 'q', exec(ctx))
    expect(value).toEqual({ answer: 'Grok returned no answer text.', operations: [{ name: 'x_user_search', count: 1 }], omittedOperations: 0, truncated: false })
  })

  it('fails a call that starts after the gate closed, or without a calling agent', async () => {
    const { ctx } = await boot()
    const lifetime = new AbortController().signal
    await expect(runGrokXSearch(ctx, { config, lifetime, isEnabled: () => false }, spec, 'q', exec(ctx)))
      .rejects.toThrow(/turned off/)
    await expect(runGrokXSearch(ctx, { config, lifetime, isEnabled: () => true }, spec, 'q', { callId: CallId('c'), signal: lifetime }))
      .rejects.toThrow(/needs a calling agent session/)
  })

  it('fails with UNSUPPORTED_OPTION when the route no longer hosts X search', async () => {
    const { ctx, upstream } = await boot({ section: { hostedXSearch: false } })
    await expect(runGrokXSearch(ctx, { config, lifetime: new AbortController().signal, isEnabled: () => true }, spec, 'q', exec(ctx)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(upstream.bodies).toHaveLength(0)
  })

  it('stops on caller cancellation, plugin unload, and the deadline', async () => {
    const sockets = new Set<import('node:net').Socket>()
    // Accepts connections and never answers; teardown destroys them so close() settles.
    const hanging = createServer((socket) => { sockets.add(socket) })
    await new Promise<void>(resolve => hanging.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      hanging.close(() => { resolve() })
    }))
    const address = hanging.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const { ctx } = await boot({ baseURL: `http://127.0.0.1:${address.port}/v1` })
    const caller = new AbortController()
    const cancelled = runGrokXSearch(ctx, { config, lifetime: new AbortController().signal, isEnabled: () => true }, spec, 'q', exec(ctx, caller.signal))
    caller.abort(new Error('caller stopped'))
    await expect(cancelled).rejects.toThrow()
    const lifetime = new AbortController()
    const unloaded = runGrokXSearch(ctx, { config, lifetime: lifetime.signal, isEnabled: () => true }, spec, 'q', exec(ctx))
    lifetime.abort(new Error('tool-grok-x-search unloaded'))
    await expect(unloaded).rejects.toThrow()
    await expect(runGrokXSearch(ctx, { config: { ...config, timeoutMs: 50 }, lifetime: new AbortController().signal, isEnabled: () => true }, spec, 'q', exec(ctx)))
      .rejects.toThrow(/timed out after 50ms/)
  })
})

describe('x_thread_fetch post reference', () => {
  it('accepts a post URL or numeric id and refuses every other reference', () => {
    expect(xPostId('1234567890')).toBe('1234567890')
    expect(xPostId('https://x.com/xai/status/1234567890')).toBe('1234567890')
    expect(xPostId('https://twitter.com/xai/status/42/?s=20#top')).toBe('42')
    expect(xPostId('https://x.com/i/web/status/42')).toBe('42')
    for (const refused of [
      'https://x.com/xai',
      'https://x.com/search?q=grok',
      'http://x.com/xai/status/42',
      'https://example.com/xai/status/42',
      'https://x.com/xai/status/42/photo/1',
      'xai/status/42',
      '12ab',
    ]) expect(xPostId(refused)).toBeUndefined()
  })

  it('fails a malformed reference before recording or sending a Grok request', async () => {
    const { ctx, upstream } = await boot({
      mainScript: [toolCallResponse('call-t', 'x_thread_fetch', { post: 'https://x.com/xai' }), textResponse('done')],
    })
    const events = await runAgent(ctx, 'fetch the thread')
    const result = JSON.stringify(events.find(event => event.type === 'tool/result')?.data)
    expect(result).toContain('"isError":true')
    expect(result).toContain('post must be an https x.com or twitter.com post URL')
    expect(events.some(event => event.type === 'grok-x-search/request')).toBe(false)
    expect(upstream.bodies).toHaveLength(0)
  })
})

describe('result bound', () => {
  const frameIntact = (text: string): void => {
    expect(text.match(/<untrusted-grok-x-answer>/g)).toHaveLength(1)
    expect(text.match(/<\/untrusted-grok-x-answer>/g)).toHaveLength(1)
  }

  it('cuts the answer so the complete rendered result fits the cap', () => {
    const value = { answer: 'a<'.repeat(5000), operations: [{ name: 'x_keyword_search', count: 1 }], omittedOperations: 0, truncated: false }
    const bounded = boundGrokXResult(value, 1500)
    expect(bounded.truncated).toBe(true)
    expect(renderGrokXResult(bounded).length).toBeLessThanOrEqual(1500)
    frameIntact(renderGrokXResult(bounded))
    expect(boundGrokXResult({ ...value, answer: 'short' }, 1500)).toEqual({ ...value, answer: 'short' })
  })

  it('leaves out operation names with a counted marker when they alone exceed the minimum cap', () => {
    const operations = Array.from({ length: 200 }, (_, index) => ({ name: `x_keyword_search_${String(index).padStart(3, '0')}`, count: 2 }))
    const bounded = boundGrokXResult({ answer: 'found https://x.com/xai/status/1', operations, omittedOperations: 0, truncated: false }, 1000)
    const text = renderGrokXResult(bounded)
    expect(text.length).toBeLessThanOrEqual(1000)
    frameIntact(text)
    expect(bounded.operations.length).toBeLessThan(200)
    expect(bounded.omittedOperations).toBe((200 - bounded.operations.length) * 2)
    expect(text).toMatch(new RegExp(`, ${bounded.omittedOperations} more not listed\\.`))
    expect(text).toContain('x_keyword_search_000 (2 calls)')
  })
})
