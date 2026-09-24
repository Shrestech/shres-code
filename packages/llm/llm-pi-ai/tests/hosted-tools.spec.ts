import { describe, expect, it } from 'vitest'
import { CallId, MAX_SERVER_TOOL_CALL_RESULTS } from '@shres-code/shres-code-llm'
import type { StreamChunk } from '@shres-code/shres-code-llm'
import {
  HOSTED_WEB_SEARCH_NAME,
  HOSTED_X_SEARCH_CALL_NAMES,
  HOSTED_X_SEARCH_NAME,
  LOCAL_WEB_SEARCH_NAME,
  applyHostedToolsPayload,
  hostedCallKind,
  hostedCustomToolCallToServerToolCall,
  hostedToolsDialectFor,
  mapHostedToolCalls,
  promotableCallNames,
  webSearchCallToServerToolCall,
  webSearchToolEntry,
  xSearchToolEntry,
} from '../src/hosted-tools/index.ts'
import { openaiCompletionsDialect } from '../src/hosted-tools/openai-completions.ts'

async function* streamOf(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('hosted tool entries', () => {
  it('builds the exact bare Responses tool entries grok-build emits', () => {
    expect(webSearchToolEntry()).toEqual({ type: 'web_search' })
    expect(xSearchToolEntry()).toEqual({ type: 'x_search' })
  })

  it('names the consts the way the wire spells them', () => {
    expect(HOSTED_WEB_SEARCH_NAME).toBe('web_search')
    expect(HOSTED_X_SEARCH_NAME).toBe('x_search')
    expect(LOCAL_WEB_SEARCH_NAME).toBe('web_search')
  })
})

describe('applyHostedToolsPayload', () => {
  const base = {
    model: 'grok-4.6',
    tools: [
      { type: 'function', name: 'web_search', description: 'local', parameters: {} },
      { type: 'function', name: 'echo', description: 'e', parameters: {} },
    ],
  }

  it('appends hosted entries and drops the superseded local web_search', () => {
    const merged = applyHostedToolsPayload(base, {
      entries: [webSearchToolEntry(), xSearchToolEntry()],
      dropLocalTools: [LOCAL_WEB_SEARCH_NAME],
    })
    expect(merged).toEqual({
      model: 'grok-4.6',
      tools: [
        { type: 'function', name: 'echo', description: 'e', parameters: {} },
        { type: 'web_search' },
        { type: 'x_search' },
      ],
    })
  })

  it('keeps the payload unchanged (undefined) when nothing changes', () => {
    const unchanged = applyHostedToolsPayload(base, { entries: [], dropLocalTools: [] })
    expect(unchanged).toBeUndefined()
  })

  it('adds a tools array when the request carried none but hosted entries exist', () => {
    const merged = applyHostedToolsPayload({ model: 'grok-4.6' }, {
      entries: [xSearchToolEntry()],
      dropLocalTools: [],
    })
    expect(merged).toEqual({ model: 'grok-4.6', tools: [{ type: 'x_search' }] })
  })

  it('leaves non-object payloads alone', () => {
    expect(applyHostedToolsPayload('nope', { entries: [], dropLocalTools: [] })).toBeUndefined()
    expect(applyHostedToolsPayload(null, { entries: [], dropLocalTools: [] })).toBeUndefined()
  })
})

describe('webSearchCallToServerToolCall', () => {
  it('maps a completed web_search_call with action.sources into a bounded block', () => {
    const block = webSearchCallToServerToolCall({
      type: 'web_search_call',
      id: 'ws_item_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'grok news',
        sources: [
          { title: 'Example', url: 'https://example.com', snippet: 'a snippet' },
          { title: 'Second', url: 'https://two.test' },
        ],
      },
    })
    expect(block).toEqual({
      type: 'server-tool-call',
      kind: 'web_search',
      id: 'ws_item_1',
      status: 'completed',
      results: [
        { title: 'Example', url: 'https://example.com', snippet: 'a snippet' },
        { title: 'Second', url: 'https://two.test' },
      ],
    })
  })

  it('marks failed status and omits results when no sources are reported', () => {
    const block = webSearchCallToServerToolCall({
      type: 'web_search_call',
      id: 'ws_item_1',
      status: 'failed',
    })
    expect(block).toMatchObject({ kind: 'web_search', id: 'ws_item_1', status: 'failed' })
    expect(block.results).toBeUndefined()
  })

  it('omits a status the item does not report', () => {
    const block = webSearchCallToServerToolCall({ type: 'web_search_call', id: 'ws_item_2' })
    expect(block).toEqual({ type: 'server-tool-call', kind: 'web_search', id: 'ws_item_2' })
  })

  it('bounds source entries at the shared cap and drops empty entries', () => {
    const sources = Array.from({ length: MAX_SERVER_TOOL_CALL_RESULTS + 5 }, (_, index) => ({
      title: `r${index}`,
      url: `https://${index}.test`,
    }))
    sources.push({ title: '', url: '', snippet: '   ' } as never)
    const block = webSearchCallToServerToolCall({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources },
    })
    expect(block.results).toHaveLength(MAX_SERVER_TOOL_CALL_RESULTS)
    expect(block.results![0]).toEqual({ title: 'r0', url: 'https://0.test' })
  })

  it('freezes the block, results array, and each result entry', () => {
    const block = webSearchCallToServerToolCall({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources: [{ title: 'R', url: 'https://r.test', snippet: 'c' }] },
    })
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.results)).toBe(true)
    expect(Object.isFrozen(block.results![0])).toBe(true)
  })
})

describe('hostedCustomToolCallToServerToolCall', () => {
  it('projects a hosted x_search custom tool call into a server-tool-call block', () => {
    const block = hostedCustomToolCallToServerToolCall({
      type: 'custom_tool_call',
      id: 'ctc_item_1',
      call_id: 'call_ctc_1',
      name: 'x_search',
      status: 'completed',
    }, HOSTED_X_SEARCH_NAME)
    expect(block).toEqual({
      type: 'server-tool-call',
      kind: 'x_search',
      name: 'x_search',
      id: 'call_ctc_1',
      status: 'completed',
    })
  })

  it('keeps the X subtype as the name under the canonical x_search kind and forges no status', () => {
    const block = hostedCustomToolCallToServerToolCall({
      type: 'custom_tool_call',
      id: 'ctc_item_2',
      name: 'x_keyword_search',
    }, 'x_keyword_search')
    expect(block).toEqual({ type: 'server-tool-call', kind: 'x_search', name: 'x_keyword_search', id: 'ctc_item_2' })
    expect(hostedCustomToolCallToServerToolCall({ type: 'custom_tool_call', status: 'failed' }, 'x_thread_fetch'))
      .toEqual({ type: 'server-tool-call', kind: 'x_search', name: 'x_thread_fetch', status: 'failed' })
  })

  it('maps only the X call family to the x_search kind', () => {
    expect(hostedCallKind('x_semantic_search')).toBe('x_search')
    expect(hostedCallKind('web_search')).toBe('web_search')
  })
})

describe('openai-responses X search plan', () => {
  it('hosts the whole X call family and drops colliding client function tools only while hosting', () => {
    expect(HOSTED_X_SEARCH_CALL_NAMES).toEqual([
      'x_search', 'x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch',
    ])
    const dialect = hostedToolsDialectFor('openai-responses')!
    const plan = dialect.spliceFor(['x_search'])
    expect(plan.callNames).toEqual(HOSTED_X_SEARCH_CALL_NAMES)
    expect(plan.dropLocalTools).toEqual(HOSTED_X_SEARCH_CALL_NAMES)
    const request = {
      tools: [
        { type: 'function', name: 'x_keyword_search' },
        { type: 'function', name: 'echo' },
      ],
    }
    expect(applyHostedToolsPayload(request, plan)).toEqual({
      tools: [{ type: 'function', name: 'echo' }, { type: 'x_search' }],
    })
    const off = dialect.spliceFor([])
    expect(off).toEqual({ entries: [], dropLocalTools: [], callNames: [] })
    expect(applyHostedToolsPayload(request, off)).toBeUndefined()
  })

  it('promotes only hosted call names the sent request does not declare as client tools', () => {
    const sent = { tools: [{ type: 'function', name: 'x_user_search' }, { type: 'x_search' }] }
    expect([...promotableCallNames(HOSTED_X_SEARCH_CALL_NAMES, sent)])
      .toEqual(['x_search', 'x_keyword_search', 'x_semantic_search', 'x_thread_fetch'])
    expect([...promotableCallNames(['x_search'], 'not an object')]).toEqual(['x_search'])
    expect([...promotableCallNames(['x_search'], { tools: [null, 'x'] })]).toEqual(['x_search'])
  })
})

describe('mapHostedToolCalls', () => {
  const hostedNames = new Set(HOSTED_X_SEARCH_CALL_NAMES)
  const hosted = (name: string): boolean => hostedNames.has(name)
  const hostedBlock: StreamChunk = {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: CallId('ctc_1|ctc_item_1'), name: 'x_search', arguments: '{}' },
  }
  const localBlock: StreamChunk = {
    type: 'block-end',
    index: 1,
    block: { type: 'tool-call', id: CallId('c2'), name: 'echo', arguments: '{}' },
  }
  const textBlock: StreamChunk = { type: 'block-end', index: 2, block: { type: 'text', text: 'hi' } }

  it('promotes a hosted tool call to a server-tool-call block', async () => {
    const chunks = await collect(mapHostedToolCalls(streamOf([hostedBlock]), hosted))
    expect(chunks[0]).toEqual({
      type: 'block-end',
      index: 0,
      block: {
        type: 'server-tool-call',
        kind: 'x_search',
        name: 'x_search',
        id: 'ctc_1|ctc_item_1',
      },
    })
  })

  it('passes local tool calls and text through unchanged', async () => {
    const chunks = await collect(mapHostedToolCalls(streamOf([localBlock, textBlock, hostedBlock]), hosted))
    expect(chunks[0]).toBe(localBlock)
    expect(chunks[1]).toBe(textBlock)
    expect(chunks[2]).not.toBe(hostedBlock)
  })

  it('leaves every block untouched when no name matches', async () => {
    const chunks = await collect(mapHostedToolCalls(streamOf([localBlock]), name => name === 'web_search'))
    expect(chunks[0]).toBe(localBlock)
  })

  it('re-tags a hosted tool-call start and suppresses its streaming deltas', async () => {
    const chunks = await collect(mapHostedToolCalls(streamOf([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CallId('ctc_1|ctc_item_1'), name: 'x_search', argumentsDelta: '{"input"' },
      { type: 'tool-call-delta', index: 0, id: CallId('ctc_1|ctc_item_1'), name: 'x_search', argumentsDelta: ':"grok"}' },
      hostedBlock,
    ]), hosted))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'server-tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'server-tool-call',
          kind: 'x_search',
          name: 'x_search',
          id: 'ctc_1|ctc_item_1',
        },
      },
    ])
  })

  it('promotes every X subtype under the canonical kind and leaves an unknown name local', async () => {
    const calls = [...HOSTED_X_SEARCH_CALL_NAMES, 'x_future_search'].map((name, index): StreamChunk => ({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: CallId(`call-${index}`), name, arguments: '{}' },
    }))
    const chunks = await collect(mapHostedToolCalls(streamOf(calls), hosted))
    expect(chunks.slice(0, 5).map(chunk => chunk.type === 'block-end' ? chunk.block : undefined))
      .toEqual(HOSTED_X_SEARCH_CALL_NAMES.map((name, index) => ({
        type: 'server-tool-call', kind: 'x_search', name, id: `call-${index}`,
      })))
    expect(chunks[5]).toBe(calls[5])
  })

  it('decides a buffered start from its block-end, or passes it through before any other chunk', async () => {
    const start: StreamChunk = { type: 'block-start', index: 0, blockType: 'tool-call' }
    const promoted = await collect(mapHostedToolCalls(streamOf([start, hostedBlock]), hosted))
    expect(promoted.map(chunk => chunk.type === 'block-start' ? chunk.blockType : chunk.type))
      .toEqual(['server-tool-call', 'block-end'])
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    expect(await collect(mapHostedToolCalls(streamOf([start, usage]), hosted))).toEqual([start, usage])
  })

  it('tags promoted indexes server-tool-call in the finish replay envelope', async () => {
    const finish: StreamChunk = {
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        response: { kind: 'pi-ai', version: 3 },
        blocks: [{ type: 'tool-call' }, { type: 'tool-call', thoughtSignature: 's' }, { type: 'text' }],
      },
    }
    const chunks = await collect(mapHostedToolCalls(streamOf([hostedBlock, localBlock, textBlock, finish]), hosted))
    expect(chunks[3]).toEqual({
      ...finish,
      replayState: {
        response: { kind: 'pi-ai', version: 3 },
        blocks: [{ type: 'server-tool-call' }, { type: 'tool-call', thoughtSignature: 's' }, { type: 'text' }],
      },
    })
    const unpromoted = await collect(mapHostedToolCalls(streamOf([localBlock, finish]), hosted))
    expect(unpromoted[1]).toBe(finish)
    const responseOnly: StreamChunk = { ...finish, replayState: { response: { kind: 'pi-ai', version: 3 } } }
    const kept = await collect(mapHostedToolCalls(streamOf([hostedBlock, responseOnly]), hosted))
    expect(kept[1]).toEqual(responseOnly)
  })

  it('derives the z.ai openai-completions splice with no surfaced calls', () => {
    expect(openaiCompletionsDialect.served).toEqual(['web_search'])
    const plan = openaiCompletionsDialect.spliceFor(['web_search'])
    expect(plan.entries).toEqual([{ type: 'web_search', web_search: { search_engine: 'search-prime' } }])
    expect(plan.dropLocalTools).toEqual(['web_search'])
    expect(plan.callNames).toEqual([])
    // The splice drops the local web_search and appends the z.ai entry.
    const spliced = applyHostedToolsPayload(
      { tools: [{ type: 'function', name: 'web_search' }, { type: 'function', name: 'echo' }] },
      plan,
    )
    expect(spliced).toEqual({
      tools: [
        { type: 'function', name: 'echo' },
        { type: 'web_search', web_search: { search_engine: 'search-prime' } },
      ],
    })
  })

  it('passes a local tool-call start/delta/end through unchanged', async () => {
    const start: StreamChunk = { type: 'block-start', index: 0, blockType: 'tool-call' }
    const delta: StreamChunk = { type: 'tool-call-delta', index: 0, id: CallId('c2'), name: 'echo', argumentsDelta: '{}' }
    const chunks = await collect(mapHostedToolCalls(streamOf([start, delta, localBlock]), hosted))
    expect(chunks).toEqual([start, delta, localBlock])
  })
})
