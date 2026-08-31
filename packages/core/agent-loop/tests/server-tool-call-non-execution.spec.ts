/**
 * Proves the agent loop logs and renders a `server-tool-call` block but
 * structurally never dispatches it: no tool lookup, no execution, no
 * name-keyed collision. A real `tool-call` in the same assistant content
 * dispatches as usual, showing the exclusion is specific to the hosted tag.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { createUserMessage, CallId, toServerToolCallBlock, type StreamChunk } from '@shres-code/shres-code-llm'
import { isLocalToolCall } from '@shres-code/shres-code-agent-loop'
import type { SessionEvent } from '@shres-code/shres-code-session'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import LlmRuntime from '@shres-code/shres-code-llm'
import ToolRuntime, { defineContentToolFixture } from '@shres-code/shres-code-tools'
import AgentRegistry, { type Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** One streamed assistant response carrying only a `server-tool-call` block. */
function hostedOnlyResponse(): StreamChunk[] {
  const block = toServerToolCallBlock({
    kind: 'web_search',
    name: 'x_search',
    id: 'ctc_hosted_1',
    status: 'completed',
    results: [{ title: 'R', url: 'https://r.test', snippet: 'excerpt' }],
  })
  return [
    { type: 'block-start', index: 0, blockType: 'server-tool-call' },
    { type: 'block-end', index: 0, block: block },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A `server-tool-call` block followed by a real `tool-call` to `echo`. */
function hostedPlusLocalResponse(): StreamChunk[] {
  const hosted = toServerToolCallBlock({ kind: 'x_search', status: 'completed' })
  return [
    { type: 'block-start', index: 0, blockType: 'server-tool-call' },
    { type: 'block-end', index: 0, block: hosted },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: CallId('call_local'), name: 'echo', arguments: '{}' },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('isLocalToolCall dispatch predicate', () => {
  it('admits only a genuine tool-call block, never a server-tool-call block', () => {
    const local = { type: 'tool-call' as const, id: CallId('c1'), name: 'echo', arguments: '{}' }
    const hosted = toServerToolCallBlock({ kind: 'web_search', status: 'completed' })
    expect(isLocalToolCall(local)).toBe(true)
    expect(isLocalToolCall(hosted)).toBe(false)
    expect(isLocalToolCall({ type: 'text' as const, text: 'x' })).toBe(false)
  })
})

describe('server-tool-call loop non-execution', () => {
  it('logs a hosted-only response but dispatches nothing', async () => {
    const adapter = new MockAdapter([hostedOnlyResponse(), textResponse('done')])
    const ctx = await harness(adapter)
    // No tool is registered, so any dispatch attempt would fail the step.
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const all = [...agent.session.events] as SessionEvent[]
    const assistant = all.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    const content = (assistant!.data as { message: { content: unknown[] } }).message.content
    expect(content).toContainEqual({
      type: 'server-tool-call',
      kind: 'web_search',
      name: 'x_search',
      id: 'ctc_hosted_1',
      status: 'completed',
      results: [{ title: 'R', url: 'https://r.test', snippet: 'excerpt' }],
    })
    expect(all.some(event => event.type === 'tool/call')).toBe(false)
  })

  it('never dispatches a local tool under the hosted block name (name-keyed collision)', async () => {
    // A hosted block named exactly like a registered local tool: any name-keyed
    // dispatch path would fire the local tool. The loop must not.
    const hosted = toServerToolCallBlock({ kind: 'web_search', name: 'web_search', status: 'completed' })
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'server-tool-call' },
      { type: 'block-end', index: 0, block: hosted },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ], textResponse('done')])
    const ctx = await harness(adapter)
    let fired = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'web_search',
      description: 'local web_search that must never run',
      parameters: {},
      async execute() { fired += 1; return [{ type: 'text', text: 'ok' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(fired).toBe(0)
    const all = [...agent.session.events] as SessionEvent[]
    expect(all.some(event => event.type === 'tool/call')).toBe(false)
  })

  it('dispatches the adjacent real tool call and never the hosted block', async () => {
    const adapter = new MockAdapter([hostedPlusLocalResponse(), textResponse('done')])
    const ctx = await harness(adapter)
    const seen: string[] = []
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: {},
      async execute() { seen.push('echo'); return [{ type: 'text', text: 'ok' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(seen).toEqual(['echo'])
    const all = [...agent.session.events] as SessionEvent[]
    const calls = all.filter(event => event.type === 'tool/call')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.data as { name: string }).name).toBe('echo')
    const assistant = all.find(event => event.type === 'assistant/message')
    const content = (assistant!.data as { message: { content: unknown[] } }).message.content
    expect(content.some(block => (block as { type?: string }).type === 'server-tool-call')).toBe(true)
  })
})
