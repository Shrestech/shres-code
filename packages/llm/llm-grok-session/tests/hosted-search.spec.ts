/**
 * Hosted search on the grok-session route: the request carries the hosted
 * tool declarations and drops the colliding local web_search while enabled,
 * a hosted x_search surfaces as a server-tool-call block (never a local
 * dispatch), and the configuration switches default on and fail loud on a
 * non-boolean value.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@shres-code/shres-code-llm'
import { isLocalToolCall } from '@shres-code/shres-code-agent-loop'
import * as LlmGrokSession from '../src/index.ts'
import type { Config as GrokSessionConfig } from '../src/config.ts'
import { resolveHostedTools } from '../src/config.ts'
import { ENTRY_KEY, entryRaw, farFuture, mockUpstream, textTurn, writeAuthDocument } from './helpers.ts'
import type { MockUpstream } from './helpers.ts'

let authPath: string | undefined
let upstream: MockUpstream | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  authPath = undefined
})

type BootConfig = GrokSessionConfig & { hostedWebSearch?: boolean; hostedXSearch?: boolean }

async function boot(config: BootConfig = {}): Promise<{ context: Context; body: () => Record<string, unknown> }> {
  authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
  upstream = await mockUpstream(textTurn('hello'))
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  const pluginConfig: GrokSessionConfig = {
    authPath,
    baseURL: `${upstream.url}/v1`,
    ...(config.hostedWebSearch === undefined ? {} : { hostedWebSearch: config.hostedWebSearch }),
    ...(config.hostedXSearch === undefined ? {} : { hostedXSearch: config.hostedXSearch }),
  }
  await context.plugin(LlmGrokSession, pluginConfig)
  return { context, body: () => upstream!.bodies[0] as Record<string, unknown> }
}

/**
 * A Responses stream whose assistant turn makes one server-side custom tool
 * call per name, then answers.
 */
function xSearchTurn(names: readonly string[] = ['x_search']): string[] {
  const calls = names.flatMap((name, index) => {
    const custom: Record<string, unknown> = {
      id: `ctc_item_${index}`, call_id: `call_ctc_${index}`, type: 'custom_tool_call',
      name, input: 'grok news', status: 'completed',
    }
    return [
      JSON.stringify({ type: 'response.output_item.added', output_index: index, item: custom }),
      JSON.stringify({ type: 'response.output_item.done', output_index: index, item: custom }),
    ]
  })
  const text = names.length
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
    ...calls,
    JSON.stringify({ type: 'response.output_item.added', output_index: text, item: { type: 'message', role: 'assistant' } }),
    JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: text, content_index: 0, delta: 'grok is an xai assistant' }),
    JSON.stringify({
      type: 'response.output_item.done',
      output_index: text,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'grok is an xai assistant', annotations: [] }] },
    }),
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }),
  ]
}

const localWebSearchTool = { name: 'web_search', description: 'local search', parameters: { type: 'object', properties: {} } }
const echoTool = { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }

describe('resolveHostedTools', () => {
  it('defaults both hosted switches on', () => {
    expect(resolveHostedTools({})).toEqual({ webSearch: true, xSearch: true })
  })

  it('resolves each switch independently', () => {
    expect(resolveHostedTools({ hostedWebSearch: false })).toEqual({ webSearch: false, xSearch: true })
    expect(resolveHostedTools({ hostedXSearch: false })).toEqual({ webSearch: true, xSearch: false })
    expect(resolveHostedTools({ hostedWebSearch: false, hostedXSearch: false })).toEqual({ webSearch: false, xSearch: false })
  })

  it('fails loud on a non-boolean switch value', () => {
    expect(() => resolveHostedTools({ hostedWebSearch: 'yes' } as unknown as GrokSessionConfig))
      .toThrow(/hostedWebSearch must be a boolean/)
    expect(() => resolveHostedTools({ hostedXSearch: 1 } as unknown as GrokSessionConfig))
      .toThrow(/hostedXSearch must be a boolean/)
    expect(() => resolveHostedTools({ agentXTools: 'on' } as unknown as GrokSessionConfig))
      .toThrow(/agentXTools must be a boolean/)
  })
})

describe('hosted search request splice', () => {
  it('offers only the local web_search when hosted is off', async () => {
    await boot({ hostedWebSearch: false, hostedXSearch: false })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({
      provider: 'grok-session', model: 'grok-4.6', messages: [],
      tools: [localWebSearchTool, echoTool],
    })) assembler.push(chunk)
    const tools = (upstream!.bodies[0] as Record<string, unknown>)['tools'] as Record<string, unknown>[]
    const names = tools.map(tool => tool['name'])
    expect(names).toContain('web_search')
    expect(names).toContain('echo')
  })

  it('splices hosted web_search and x_search entries and drops the local web_search when enabled', async () => {
    await boot()
    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({
      provider: 'grok-session', model: 'grok-4.6', messages: [],
      tools: [localWebSearchTool, echoTool],
    })) assembler.push(chunk)
    const tools = (upstream!.bodies[0] as Record<string, unknown>)['tools'] as Record<string, unknown>[]
    const localWebSearch = tools.find(tool => tool['type'] === 'function' && tool['name'] === 'web_search')
    const hostedWeb = tools.find(tool => tool['type'] === 'web_search')
    const hostedX = tools.find(tool => tool['type'] === 'x_search')
    // hosted wins: the local function tool named web_search is dropped
    expect(localWebSearch).toBeUndefined()
    expect(tools.some(tool => tool['name'] === 'echo')).toBe(true)
    expect(hostedWeb).toEqual({ type: 'web_search' })
    expect(hostedX).toEqual({ type: 'x_search' })
  })

  it('splices x_search only when only X search is enabled', async () => {
    await boot({ hostedWebSearch: false })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({
      provider: 'grok-session', model: 'grok-4.6', messages: [],
      tools: [localWebSearchTool],
    })) assembler.push(chunk)
    const tools = (upstream!.bodies[0] as Record<string, unknown>)['tools'] as Record<string, unknown>[]
    expect(tools.some(tool => tool['name'] === 'web_search')).toBe(true)
    expect(tools.some(tool => tool['type'] === 'x_search')).toBe(true)
    expect(tools.some(tool => tool['type'] === 'web_search')).toBe(false)
  })
})

describe('hosted x_search response mapping', () => {
  it('promotes a server-side x_search call to a server-tool-call block the loop never dispatches', async () => {
    authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    upstream = await mockUpstream(xSearchTurn())
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(LlmGrokSession, { authPath, baseURL: `${upstream.url}/v1`, hostedXSearch: true })

    const assembler = new BlockAssembler()
    for await (const chunk of context.llm.stream({ provider: 'grok-session', model: 'grok-4.6', messages: [] })) {
      assembler.push(chunk)
    }
    const message = assembler.message({ kind: 'model', provider: 'grok-session', model: 'grok-4.6' })
    const hosted = message.content.find(block => block.type === 'server-tool-call')
    expect(hosted).toMatchObject({
      type: 'server-tool-call',
      kind: 'x_search',
      name: 'x_search',
    })
    // pi-ai's tool call reports no completion state, so none is recorded.
    expect(hosted).not.toHaveProperty('status')
    expect(isLocalToolCall(hosted!)).toBe(false)
    expect(message.content.some(block => block.type === 'tool-call' && block.name === 'x_search')).toBe(false)
    expect(message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('xai')
  })

  it('promotes every X call subtype and replays the turn without function calls or outputs', async () => {
    const names = ['x_search', 'x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']
    authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    upstream = await mockUpstream(xSearchTurn(names))
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(LlmGrokSession, { authPath, baseURL: `${upstream.url}/v1`, hostedXSearch: true })

    const user = createUserMessage({ content: [{ type: 'text', text: 'what is new on X?' }], source: { kind: 'user' } })
    const first = new BlockAssembler()
    for await (const chunk of context.llm.stream({
      provider: 'grok-session', model: 'grok-4.6', messages: [user],
      tools: [echoTool, { ...echoTool, name: 'x_keyword_search' }],
    })) first.push(chunk)
    const sentTools = (upstream.bodies[0] as Record<string, unknown>)['tools'] as Record<string, unknown>[]
    expect(sentTools.some(tool => tool['name'] === 'x_keyword_search')).toBe(false)
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const assistant = first.message({
      kind: 'model', provider: 'grok-session', model: 'grok-4.6', replayState: first.replayState,
    })
    expect(assistant.content.filter(block => block.type === 'server-tool-call')).toEqual(names.map((name, index) => ({
      type: 'server-tool-call', kind: 'x_search', name, id: `call_ctc_${index}|ctc_item_${index}`,
    })))
    expect(assistant.content.some(isLocalToolCall)).toBe(false)

    for await (const _chunk of context.llm.stream({
      provider: 'grok-session', model: 'grok-4.6',
      messages: [user, assistant, createUserMessage({ content: [{ type: 'text', text: 'thanks' }], source: { kind: 'user' } })],
    })) { /* drain */ }
    const input = (upstream.bodies[1] as Record<string, unknown>)['input'] as Record<string, unknown>[]
    const types = input.map(item => item['type'] ?? item['role'])
    expect(types).not.toContain('function_call')
    expect(types).not.toContain('function_call_output')
    expect(types).not.toContain('custom_tool_call')
    expect(types).not.toContain('custom_tool_call_output')
    expect(JSON.stringify(input)).toContain('grok is an xai assistant')
    // The native message id survives only when the replay state was usable,
    // so the promoted blocks did not degrade the message to foreign history.
    expect(input.some(item => item['type'] === 'message' && item['id'] === 'msg_1')).toBe(true)
  })

  it('keeps X call names local when hosted X search is off', async () => {
    authPath = await writeAuthDocument({ [ENTRY_KEY]: entryRaw(farFuture()) })
    upstream = await mockUpstream(xSearchTurn(['x_keyword_search']))
    const context = new Context()
    ctx = context
    await context.plugin(LlmRuntime)
    await context.plugin(LlmGrokSession, { authPath, baseURL: `${upstream.url}/v1`, hostedXSearch: false })
    const assembler = new BlockAssembler()
    for await (const chunk of context.llm.stream({ provider: 'grok-session', model: 'grok-4.6', messages: [] })) {
      assembler.push(chunk)
    }
    const message = assembler.message({ kind: 'model', provider: 'grok-session', model: 'grok-4.6' })
    expect(message.content.some(block => block.type === 'server-tool-call')).toBe(false)
    expect(message.content.some(block => block.type === 'tool-call' && block.name === 'x_keyword_search')).toBe(true)
  })
})
