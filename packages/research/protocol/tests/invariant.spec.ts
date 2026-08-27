import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime, { defineTool } from '@shres-code/shres-code-tools'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentRegistry, { Inbox } from '@shres-code/shres-code-agent'
import * as ProtocolInvariant from '../src/invariant.ts'
import { DESIGN_DEFENSE_DENY_PREFIX, designDefenseDeny } from '../src/epoch.ts'

const signal = new AbortController().signal

const noopTool = defineTool({
  name: 'experiment_log_run',
  description: 'test double whose execution never matters behind policy listeners',
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    render: () => [{ type: 'text', text: 'logged' }],
  },
  async execute() {
    return { ok: true }
  },
  presentCall: () => ({ card: 'generic' as const, title: 'experiment_log_run', kind: 'other' as const, rawInput: {} }),
})

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ProtocolInvariant)
  ctx.tools.register(noopTool)
  const session = ctx.sessions.create(SessionId('ws-invariant-observer'))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() {
      return Promise.resolve()
    },
  }
  ctx.agents.register(agent)
  return { ctx, agent }
}

function denyListener(reason: string): (exec: { name: string }, next: () => Promise<{ kind: 'allow' }>) => Promise<{ kind: 'deny'; reason: string }> {
  return async (_exec, next) => {
    await next()
    return { kind: 'deny', reason }
  }
}

function appendCompletedAegis(agent: Agent): void {
  agent.session.append('tool/call', { turn: 1, step: 1, callId: CallId('a1'), name: 'aegis', arguments: '{}' })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId('a1'),
      content: [{ type: 'text', text: 'challenge' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

describe('research-protocol invariant observer', () => {
  it('passes unrelated denies through untouched', async () => {
    const { ctx, agent } = await harness()
    ctx.on('tools/pre-execute', denyListener('denied by policy'))
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('x1'),
      name: 'experiment_log_run',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text?: string }).text).toContain('denied by policy')
  })

  it('accepts a design-defense deny whose cited tool is genuinely missing', async () => {
    const { ctx, agent } = await harness()
    ctx.on('tools/pre-execute', denyListener(designDefenseDeny(['ward'])))
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('x2'),
      name: 'experiment_log_run',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text?: string }).text).toContain(DESIGN_DEFENSE_DENY_PREFIX)
  })

  it('rejects a deny citing a tool that holds a completed non-error call', async () => {
    const { ctx, agent } = await harness()
    appendCompletedAegis(agent)
    ctx.on('tools/pre-execute', denyListener(designDefenseDeny(['aegis'])))
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('x3'),
      name: 'experiment_log_run',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text?: string }).text)
      .toContain('design-defense deny cites aegis, which holds a completed non-error call')
  })

  it('rejects a protocol deny that ran without a session', async () => {
    const { ctx } = await harness()
    ctx.on('tools/pre-execute', denyListener(designDefenseDeny(['ward'])))
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('x4'),
      name: 'experiment_log_run',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text?: string }).text).toContain('without a session')
  })
})
