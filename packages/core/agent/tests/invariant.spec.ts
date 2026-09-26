import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import * as AgentInvariant from '@shres-code/shres-code-agent/invariant'
import { scopeTarget } from '@shres-code/shres-code-scope'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentInvariant)
  return ctx
}

function mockAgent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('agent status invariants', () => {
  it('accepts lifecycle transitions between idle and running', async () => {
    const ctx = await setup()
    const agent = mockAgent('a1')
    expect(() => {
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'idle' })
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'running' })
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'idle' })
    }).not.toThrow()
  })

  it('rejects a no-op transition', async () => {
    const ctx = await setup()
    const agent = mockAgent('a3')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'running' })
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'running' }) })
      .toThrow(/no-op transition/)
  })

  it('tracks agents independently', async () => {
    const ctx = await setup()
    const a = mockAgent('a5')
    const b = mockAgent('b5')
    ctx.emit(scopeTarget(a, a), 'agent/status', { agent: a, status: 'running' })
    expect(() => { ctx.emit(scopeTarget(b, b), 'agent/status', { agent: b, status: 'running' }) }).not.toThrow()
  })
})

describe('agent/route-base invariant', () => {
  async function sessionSetup(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AgentInvariant)
    return ctx
  }

  const manual = { provider: 'alpha', model: 'a1' }

  it('accepts a record naming two different complete routes, effort included', async () => {
    const ctx = await sessionSetup()
    const session = ctx.sessions.create()
    expect(() => { session.append('agent/route-base', { manual, routed: { provider: 'cheap', model: 'c1' } }) }).not.toThrow()
    expect(() => {
      session.append('agent/route-base', { manual, routed: { ...manual, reasoningEffort: ReasoningEffortId('low') } })
    }).not.toThrow()
  })

  it('rejects a record whose two routes are the same', async () => {
    const ctx = await sessionSetup()
    const session = ctx.sessions.create()
    expect(() => { session.append('agent/route-base', { manual, routed: { ...manual } }) })
      .toThrow(/agent\/route-base names the same route as manual and routed/)
    expect(session.events).toHaveLength(0)
  })

  it.each([
    ['blank manual provider', { manual: { provider: ' ', model: 'a1' }, routed: { provider: 'cheap', model: 'c1' } }, 'manual'],
    ['blank manual model', { manual: { provider: 'alpha', model: '' }, routed: { provider: 'cheap', model: 'c1' } }, 'manual'],
    ['blank routed provider', { manual, routed: { provider: '', model: 'c1' } }, 'routed'],
    ['blank routed model', { manual, routed: { provider: 'cheap', model: '  ' } }, 'routed'],
  ] as const)('rejects a record with an incomplete route: %s', async (_name, record, field) => {
    const ctx = await sessionSetup()
    const session = ctx.sessions.create()
    expect(() => { session.append('agent/route-base', record) })
      .toThrow(new RegExp(`agent/route-base ${field} needs a nonempty provider and model`))
  })
})
