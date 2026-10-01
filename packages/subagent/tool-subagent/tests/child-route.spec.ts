import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import LlmRuntime from '@shres-code/shres-code-llm'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import type { Agent } from '@shres-code/shres-code-agent'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import type { SubagentChildRouteRequest, SubagentStartRequest } from '@shres-code/shres-code-subagent'
import { SessionId } from '@shres-code/shres-code-session'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

/** A parent with no logged route, default model, or creation route. */
function parentAgent(): Agent {
  return {
    id: SessionId('parent-1'),
    ctx: { get: () => undefined },
    options: {},
    session: { header: {}, events: [], requestHeader: () => undefined },
  } as unknown as Agent
}

/** Mount the tool on a capturing provider whose children run requested routes. */
async function setup(
  toolConfig: Partial<tool.Config> = {},
  listenerRoute: { provider?: string; model?: string } = { provider: 'cheap', model: 'flash' },
) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['cheap'], new MockAdapter([]))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  const starts: SubagentStartRequest[] = []
  ctx.subagents.registerProvider({
    name: 'capture',
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    runsRequestedModel: true,
    start: async (request) => {
      starts.push(request)
      return {
        id: SessionId('capture-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
        dispose: async () => {},
      }
    },
  })
  await ctx.plugin(tool, { provider: 'capture', maxDepth: 'provider-managed', ...toolConfig })
  const listener = vi.fn(async (_request: SubagentChildRouteRequest) => listenerRoute)
  ctx.on('subagent/child-route', listener)
  return { ctx, starts, listener }
}

let counter = 0
function call(ctx: Context, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`route-call-${++counter}`),
    name,
    arguments: args,
    agent: parentAgent(),
  })
}

describe('shres-tool-subagent child routing', () => {
  it('starts and reports the listener-routed child from one route resolution', async () => {
    const { ctx, starts, listener } = await setup({ toolName: 'explore' })
    const result = await call(ctx, 'explore', { description: 'scan', prompt: 'list the files' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]![0]).toMatchObject({
      kind: 'subagent',
      subagentProvider: 'capture',
      agentType: 'explore',
      prompt: 'list the files',
      inherited: {},
    })
    expect(starts[0]?.agentOptions).toMatchObject({
      provider: 'cheap',
      model: 'flash',
      subagentRouteRequestId: listener.mock.calls[0]?.[0].routeRequestId,
    })
    if (result.isError) throw new Error('expected a routed foreground delegation')
    expect(result.value).toMatchObject({ kind: 'foreground', provider: 'cheap', model: 'flash' })
  })

  it('does not attach a route request id when the listener keeps the inherited route', async () => {
    const { ctx, starts, listener } = await setup({ toolName: 'explore' }, {})
    const result = await call(ctx, 'explore', { description: 'scan', prompt: 'list the files' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(starts[0]?.agentOptions).toBeUndefined()
    if (result.isError) throw new Error('expected an inherited foreground delegation')
    expect(result.value).toMatchObject({ kind: 'foreground' })
  })

  it('never consults for a configured agentOptions route, so a seat binding stands', async () => {
    const { ctx, starts, listener } = await setup({ agentOptions: { provider: 'mock', model: 'seat-model' } })
    const result = await call(ctx, 'subagent', { description: 'review', prompt: 'review the diff' })

    expect(listener).not.toHaveBeenCalled()
    expect(starts[0]?.agentOptions).toEqual({ provider: 'mock', model: 'seat-model' })
    if (result.isError) throw new Error('expected a seat-bound foreground delegation')
    expect(result.value).toMatchObject({ provider: 'mock', model: 'seat-model' })
  })

  it('asks no route question for a call it refuses', async () => {
    const { ctx, starts, listener } = await setup({ enableRunInBackground: false })
    const refused = await call(ctx, 'subagent', { description: 'd', prompt: 'p', run_in_background: true })

    expect(refused.isError).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(starts).toHaveLength(0)
  })
})
