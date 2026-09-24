import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  MAX_SERVER_TOOL_CALL_RESULTS,
  toServerToolCallBlock,
} from '@shres-code/shres-code-llm'

describe('toServerToolCallBlock', () => {
  it('projects the hosted tool identity and completion state', () => {
    const block = toServerToolCallBlock({
      kind: 'web_search',
      name: 'x_search',
      id: 'ctc_1',
      status: 'completed',
    })
    expect(block).toEqual({
      type: 'server-tool-call',
      kind: 'web_search',
      name: 'x_search',
      id: CallId('ctc_1'),
      status: 'completed',
    })
  })

  it('omits absent optional identity fields and trims whitespace', () => {
    const block = toServerToolCallBlock({
      kind: ' web_search ',
      name: '  ',
      id: '  ',
      status: 'failed',
    })
    expect(block.type).toBe('server-tool-call')
    expect(block.kind).toBe('web_search')
    expect('name' in block).toBe(false)
    expect('id' in block).toBe(false)
    expect(block.status).toBe('failed')
    expect('results' in block).toBe(false)
  })

  it('bounds the results array and drops empty entries', () => {
    const many = Array.from({ length: MAX_SERVER_TOOL_CALL_RESULTS + 5 }, (_, index) => ({
      title: `title-${index}`,
      url: `https://example.test/${index}`,
      snippet: `snippet-${index}`,
    }))
    const block = toServerToolCallBlock({
      kind: 'web_search',
      status: 'completed',
      results: [...many, { title: '  ', url: '', snippet: '' }],
    })
    expect(block.results).toHaveLength(MAX_SERVER_TOOL_CALL_RESULTS)
    expect(block.results?.[0]).toEqual({ title: 'title-0', url: 'https://example.test/0', snippet: 'snippet-0' })
    // the trailing empty entry is dropped, not counted past the bound
    expect(block.results?.[MAX_SERVER_TOOL_CALL_RESULTS - 1]?.title).toBe(`title-${MAX_SERVER_TOOL_CALL_RESULTS - 1}`)
  })

  it('returns a frozen block so durable content stays immutable', () => {
    const block = toServerToolCallBlock({ kind: 'x_search', status: 'completed', results: [{ title: 'a' }] })
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.results)).toBe(true)
  })

  it('omits an unreported status instead of inferring completion', () => {
    const block = toServerToolCallBlock({ kind: 'x_search', name: 'x_user_search', id: 'call-1' })
    expect(block).toEqual({ type: 'server-tool-call', kind: 'x_search', name: 'x_user_search', id: 'call-1' })
    expect('status' in block).toBe(false)
  })

  it('rejects a missing or blank hosted tool kind', () => {
    expect(() => toServerToolCallBlock({ kind: '', status: 'completed' })).toThrow(TypeError)
  })
})

describe('server-tool-call round-trip through a message', () => {
  it('survives JSON serialization inside assistant content', () => {
    const block = toServerToolCallBlock({
      kind: 'web_search',
      id: 'ctc_9',
      status: 'completed',
      results: [{ title: 'T', url: 'https://u.test', snippet: 'S' }],
    })
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'found it' }, block],
      source: { provider: 'test', model: 'test' },
    })
    const revived = JSON.parse(JSON.stringify(message.content)) as typeof message.content
    expect(revived).toEqual([
      { type: 'text', text: 'found it' },
      {
        type: 'server-tool-call',
        kind: 'web_search',
        id: 'ctc_9',
        status: 'completed',
        results: [{ title: 'T', url: 'https://u.test', snippet: 'S' }],
      },
    ])
  })
})
