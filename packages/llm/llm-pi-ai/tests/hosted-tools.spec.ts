import { describe, expect, it } from 'vitest'
import { CallId, MAX_SERVER_TOOL_CALL_RESULTS } from '@shres-code/shres-code-llm'
import type { StreamChunk } from '@shres-code/shres-code-llm'
import {
  HOSTED_WEB_SEARCH_NAME,
  HOSTED_X_SEARCH_NAME,
  LOCAL_WEB_SEARCH_NAME,
  applyHostedToolsPayload,
  hostedCustomToolCallToServerToolCall,
  mapHostedToolCalls,
  webSearchCallToServerToolCall,
  webSearchToolEntry,
  xSearchToolEntry,
} from '../src/hosted-tools.ts'

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
})

describe('mapHostedToolCalls', () => {
  const hosted = new Set([HOSTED_X_SEARCH_NAME])
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
        status: 'completed',
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
    const chunks = await collect(mapHostedToolCalls(streamOf([localBlock]), new Set(['web_search'])))
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
          status: 'completed',
        },
      },
    ])
  })

  it('passes a local tool-call start/delta/end through unchanged', async () => {
    const start: StreamChunk = { type: 'block-start', index: 0, blockType: 'tool-call' }
    const delta: StreamChunk = { type: 'tool-call-delta', index: 0, id: CallId('c2'), name: 'echo', argumentsDelta: '{}' }
    const chunks = await collect(mapHostedToolCalls(streamOf([start, delta, localBlock]), hosted))
    expect(chunks).toEqual([start, delta, localBlock])
  })
})
