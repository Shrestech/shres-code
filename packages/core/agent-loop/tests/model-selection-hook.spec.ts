import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import LlmRuntime, { createUserMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import AgentRegistry, { modelSelectionInstalled, provideModelSelection } from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@shres-code/shres-code-agent'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * The model-selection hook through the real agent factory: the agent registry
 * installs it on every root agent before announcing it, on create and on
 * resume, and never on a delegated child; a front end fills its manual
 * selection, and each request reaches a composed router exactly once.
 *
 * TEST DOUBLES: the scripted model adapter, and {@link CountingRouting}, the
 * smallest `ctx.modelRouting` that records each consult and keeps the route.
 */

const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })

/** Records each consult and keeps the manual route. */
class CountingRouting extends Service {
  readonly bases: { agent: string; base: ModelSelection }[] = []

  constructor(ctx: Context) {
    super(ctx, 'modelRouting')
  }

  stickySelection(): ModelSelection | undefined {
    return undefined
  }

  resolveRequest(agent: Agent, _turn: number, _step: number, base: ModelSelection): Promise<ModelSelection | undefined> {
    this.bases.push({ agent: agent.id, base })
    return Promise.resolve(undefined)
  }
}

/** Mount the factory, persistence, and the counting router over a fresh storage root. */
async function harness(adapter: MockAdapter, root?: string): Promise<{ ctx: Context; root: string }> {
  const dir = root ?? await mkdtemp(join(tmpdir(), 'shres-selection-hook-'))
  if (root === undefined) roots.push(dir)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(CountingRouting)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root: dir }
}

/** Run one user turn to idle. */
async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const ROUTE = { provider: 'mock', model: 'mock' }

describe('the model-selection hook through the agent factory', () => {
  it('is installed before agent/created on create and on resume, and not on a delegated child', async () => {
    const { ctx, root } = await harness(new MockAdapter([textResponse('one')]))
    const seen: [string, boolean][] = []
    ctx.on('agent/created', ({ agent }) => { seen.push([agent.id, modelSelectionInstalled(agent)]) })
    const sessionId = SessionId('hook-root')
    const handle = await ctx.agents.create({ sessionId, agentOptions: ROUTE })
    await turn(handle.agent, 'hello')
    const child = await ctx.agents.create({ sessionId: SessionId('hook-child'), agentOptions: ROUTE, meta: { delegationDepth: 1 } })
    expect(seen).toEqual([['hook-root', true], ['hook-child', false]])
    await ctx.sessions.flush(handle.agent.session)
    await ctx.fiber.dispose()

    const next = await harness(new MockAdapter([textResponse('two')]), root)
    const resumed: boolean[] = []
    next.ctx.on('agent/created', ({ agent }) => { resumed.push(modelSelectionInstalled(agent)) })
    const again = await next.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: ROUTE })
    expect(resumed).toEqual([true])
    await turn(again.agent, 'again')
    const routing = next.ctx.get('modelRouting') as unknown as CountingRouting
    expect(routing.bases).toEqual([{ agent: 'hook-root', base: ROUTE }])
    await next.ctx.fiber.dispose()
    expect(child.agent.id).toBe('hook-child')
  })

  it('never consults the router for a delegated child', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('child')]))
    const child = await ctx.agents.create({ sessionId: SessionId('hook-only-child'), agentOptions: ROUTE, meta: { delegationDepth: 1 } })
    await turn(child.agent, 'work')
    expect((ctx.get('modelRouting') as unknown as CountingRouting).bases).toEqual([])
    await ctx.fiber.dispose()
  })

  it('consults once per request whether the selection is provided in setup, later, or never', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('a'), textResponse('b'), textResponse('c'), textResponse('d')]))
    const routing = ctx.get('modelRouting') as unknown as CountingRouting
    const inSetup: ModelSelectionRef = { current: { provider: 'mock', model: 'picked' }, assembled: undefined }
    const early = await ctx.agents.create({
      sessionId: SessionId('hook-setup'),
      agentOptions: ROUTE,
      setup: (agentCtx) => { provideModelSelection(agentCtx.agent as Agent, inSetup) },
    })
    await turn(early.agent, 'one')
    expect(routing.bases).toEqual([{ agent: 'hook-setup', base: { provider: 'mock', model: 'picked' } }])
    expect(() => { provideModelSelection(early.agent, { current: undefined, assembled: undefined }) })
      .toThrow('agent "hook-setup" already has a model selection provider')

    // A front end that takes over later, as /model does, fills the installed hook.
    const late = await ctx.agents.create({ sessionId: SessionId('hook-late'), agentOptions: ROUTE })
    await turn(late.agent, 'two')
    provideModelSelection(late.agent, { current: { provider: 'mock', model: 'switched' }, assembled: undefined })
    await turn(late.agent, 'three')
    expect(routing.bases.slice(1)).toEqual([
      { agent: 'hook-late', base: ROUTE },
      { agent: 'hook-late', base: { provider: 'mock', model: 'switched' } },
    ])
    await ctx.fiber.dispose()
  })
})
