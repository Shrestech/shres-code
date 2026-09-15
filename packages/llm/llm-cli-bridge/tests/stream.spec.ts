/**
 * CliStreamMapper behavior: cursor-agent/claude-style stream-json events map
 * to live chunks — thinking deltas to reasoning blocks, assistant messages to
 * text blocks, tool_call lifecycles to server-tool-call blocks, and the result
 * object to usage plus a text fallback. Foreign shapes feed the caller's
 * whole-transcript fallback via `hadContent`.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@shres-code/shres-code-llm'
import { CliStreamMapper } from '../src/stream.ts'

/** Feed whole lines and flush, returning every chunk. */
function run(lines: readonly string[]): StreamChunk[] {
  const mapper = new CliStreamMapper()
  const chunks = lines.flatMap(line => mapper.feed(`${line}\n`))
  chunks.push(...mapper.flush())
  return chunks
}

describe('CliStreamMapper', () => {
  it('streams thinking deltas as one reasoning block', () => {
    const chunks = run([
      '{"type":"system","subtype":"init","model":"Cursor Grok 4.6 High"}',
      '{"type":"thinking","subtype":"delta","text":"Preparing to reply with"}',
      '{"type":"thinking","subtype":"delta","text":" exactly \\"hello\\"."}',
      '{"type":"thinking","subtype":"completed"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success","result":"hello","usage":{"inputTokens":100,"outputTokens":5}}',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Preparing to reply with' },
      { type: 'reasoning-delta', index: 0, text: ' exactly "hello".' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Preparing to reply with exactly "hello".' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hello' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } },
    ])
  })

  it('opens a new text block per distinct assistant message and extends same-call snapshots', () => {
    const chunks = run([
      '{"type":"assistant","model_call_id":"c1","message":{"role":"assistant","content":[{"type":"text","text":"I will run"}]}}',
      '{"type":"assistant","model_call_id":"c1","message":{"role":"assistant","content":[{"type":"text","text":"I will run it now."}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}',
      '{"type":"result","subtype":"success","result":"I will run it now.Done."}',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'I will run' },
      { type: 'text-delta', index: 0, text: ' it now.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'I will run it now.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Done.' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Done.' } },
    ])
  })

  it('maps a tool_call lifecycle to one server-tool-call block', () => {
    const callId = 'call-abc\nfc_def_0'
    const started = JSON.stringify({
      type: 'tool_call', subtype: 'started', call_id: callId,
      tool_call: { shellToolCall: { args: { command: 'echo shres-probe', description: 'Echo the probe string' } } },
    })
    const completed = JSON.stringify({
      type: 'tool_call', subtype: 'completed', call_id: callId,
      tool_call: { shellToolCall: { args: { command: 'echo shres-probe', description: 'Echo the probe string' }, result: { success: { stdout: 'shres-probe\n', exitCode: 0 } } } },
    })
    const chunks = run([started, completed, '{"type":"result","subtype":"success","result":"done"}'])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'server-tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'server-tool-call',
          kind: 'shell',
          name: 'Echo the probe string',
          id: 'call-abc',
          status: 'completed',
          results: [{ title: 'Echo the probe string', snippet: 'shres-probe' }],
        },
      },
      // No assistant event streamed, so the result text is the reply.
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'done' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
    ])
  })

  it('marks a failed tool_call and tolerates a completion without a start', () => {
    const chunks = run([
      '{"type":"tool_call","subtype":"completed","tool_call":{"readToolCall":{"args":{"path":"/x"},"result":{"failure":{"message":"denied"}}}}}',
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'server-tool-call' })
    expect(chunks[1]).toMatchObject({
      type: 'block-end',
      index: 0,
      block: { type: 'server-tool-call', kind: 'read', name: '/x', status: 'failed' },
    })
  })

  it('falls back to the result text when no assistant event streamed', () => {
    const chunks = run([
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","result":"only the result","usage":{"input_tokens":3,"output_tokens":2}}',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'only the result' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'only the result' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    ])
  })

  it('throws on an error result payload as soon as it arrives', () => {
    const mapper = new CliStreamMapper()
    expect(() => mapper.feed('{"type":"result","subtype":"error","is_error":true,"result":"login expired"}\n'))
      .toThrow('login expired')
  })

  it('buffers a partial line across feeds', () => {
    const mapper = new CliStreamMapper()
    expect(mapper.feed('{"type":"assistant","text":"he')).toEqual([])
    const chunks = mapper.feed('llo"}\n')
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta'])
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'hello' })
  })

  it('parses an unterminated tail line at flush', () => {
    const mapper = new CliStreamMapper()
    mapper.feed('{"type":"assistant","text":"tail"}')
    const chunks = mapper.flush()
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end'])
  })

  it('streams kimi role events and ignores meta, commentary, and unknown shapes', () => {
    const mapper = new CliStreamMapper()
    const chunks = [
      ...mapper.feed('{"role":"meta","type":"system.version","version":"0.36.1"}\n'),
      ...mapper.feed('not json commentary\n'),
      ...mapper.feed('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n'),
      ...mapper.feed('{"role":"assistant","content":"Hi! What can I do?"}\n'),
      ...mapper.feed('{"role":"meta","type":"session.resume_hint","content":"kimi -r s1"}\n'),
      ...mapper.flush(),
    ]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi! What can I do?' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi! What can I do?' } },
    ])
  })

  it('reports hadContent only after recognized content', () => {
    const empty = new CliStreamMapper()
    empty.feed('{"type":"system","subtype":"init"}\n{"foo":1}\n')
    expect(empty.hadContent).toBe(false)
    empty.flush()
    expect(empty.hadContent).toBe(false)

    const text = new CliStreamMapper()
    text.feed('{"type":"assistant","text":"hi"}\n')
    expect(text.hadContent).toBe(true)

    const result = new CliStreamMapper()
    result.feed('{"type":"result","subtype":"success","result":""}\n')
    expect(result.hadContent).toBe(true)
  })

  it('tolerates shape gaps: empty payloads, unknown subtypes, and missing fields', () => {
    const chunks = run([
      '{"type":"thinking","subtype":"delta","text":""}',
      '{"type":"thinking","subtype":"paused"}',
      '{"type":"tool_call","subtype":"started"}',
      '{"type":"tool_call","subtype":"delta","tool_call":{"shellToolCall":{"args":{}}}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"mcpToolCall":{}}}',
      '{"type":"result","subtype":"success"}',
    ])
    // Only the two completions produce blocks; everything else is ignored.
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'block-end',
      'block-start', 'block-end',
    ])
    expect(chunks[1]).toMatchObject({ block: { kind: 'tool', status: 'completed' } })
    expect(chunks[3]).toMatchObject({ block: { kind: 'mcp', name: 'mcp', status: 'completed' } })
  })

  it('stringifies an error payload that carries no text field', () => {
    const mapper = new CliStreamMapper()
    expect(() => mapper.feed('{"type":"error","detail":42}\n')).toThrow('"detail":42')
  })

  it('ignores an identical snapshot re-send', () => {
    const chunks = run([
      '{"type":"assistant","model_call_id":"c1","message":{"role":"assistant","content":[{"type":"text","text":"same"}]}}',
      '{"type":"assistant","model_call_id":"c1","message":{"role":"assistant","content":[{"type":"text","text":"same"}]}}',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'same' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'same' } },
    ])
  })

  it('uses the claude-style message id for snapshot continuation', () => {
    const chunks = run([
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"he"}]}}',
      '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello"}]}}',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'llo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    ])
  })

  it('bounds long tool output and skips an empty one', () => {
    const long = 'x'.repeat(400)
    const chunks = run([
      JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: { args: { command: 'big' }, result: { success: { stdout: long } } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: { args: { command: 'empty' }, result: { success: { stdout: '  ' } } } } }),
    ])
    const first = chunks[1]
    const second = chunks[3]
    if (first?.type !== 'block-end' || first.block.type !== 'server-tool-call') throw new Error('shape')
    if (second?.type !== 'block-end' || second.block.type !== 'server-tool-call') throw new Error('shape')
    expect(first.block.results?.[0]?.snippet).toBe(`${'x'.repeat(300)}…`)
    expect(second.block.results).toEqual([{ title: 'empty' }])
  })

  it('drops a non-string call id and a bare ToolCall key', () => {
    const chunks = run([
      '{"type":"tool_call","subtype":"completed","call_id":42,"tool_call":{"ToolCall":{"args":{}}}}',
    ])
    expect(chunks[1]).toMatchObject({
      type: 'block-end',
      block: { kind: 'tool', status: 'completed', results: [{ title: 'tool' }] },
    })
    const block = chunks[1]
    if (block?.type !== 'block-end' || block.block.type !== 'server-tool-call') throw new Error('shape')
    expect(block.block.id).toBeUndefined()
  })

  it('tracks a started call without a call id and drops a blank call id', () => {
    const chunks = run([
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}',
      '{"type":"tool_call","subtype":"started","tool_call":{}}',
      '{"type":"tool_call","subtype":"completed","call_id":"\\nfc_x","tool_call":{"shellToolCall":{"args":{"command":"ls"},"result":{"success":{"stdout":"ok"}}}}}',
    ])
    // Completions cannot join anonymous starts, so each opens its own block.
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'block-start', 'block-start', 'block-end'])
    const block = chunks[3]
    if (block?.type !== 'block-end' || block.block.type !== 'server-tool-call') throw new Error('shape')
    expect(block.block.kind).toBe('shell')
    expect(block.block.id).toBeUndefined()
  })

  it('closes an uncompleted tool call silently and ignores a commentary tail', () => {
    const mapper = new CliStreamMapper()
    const chunks = [
      ...mapper.feed('{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}\n'),
      ...mapper.feed('trailing commentary without newline'),
      ...mapper.flush(),
    ]
    expect(chunks).toEqual([{ type: 'block-start', index: 0, blockType: 'server-tool-call' }])
  })

  it('ignores blank lines and non-object JSON lines', () => {
    const mapper = new CliStreamMapper()
    const chunks = mapper.feed('\n"just a string"\n[1,2]\n')
    expect(chunks).toEqual([])
    expect(mapper.hadContent).toBe(false)
  })
})
