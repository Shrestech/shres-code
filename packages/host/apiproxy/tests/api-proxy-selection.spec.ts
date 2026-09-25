/** The Web front end's model selection: one provider per root agent, and forks routed like any root agent. */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import AgentRegistry, { agentEvents, modelSelectionInstalled, provideModelSelection } from '@shres-code/shres-code-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ModelSelection } from '@shres-code/shres-code-agent'
import AgentDefaultModel from '@shres-code/shres-code-agent-default-model'
import { createUserMessage } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { SessionId } from '@shres-code/shres-code-session'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import UserQuestionService from '@shres-code/shres-code-user-questions'
import type { RpcRequest } from '@shres-code/shres-code-host-apiproxy/api/rpc'
import { RpcId } from '@shres-code/shres-code-host-apiproxy/api/rpc'
import { createApiProxy } from '@shres-code/shres-code-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`selection-${String(nextRpc++)}`), payload }
}

/** TEST DOUBLE: the smallest `ctx.modelRouting`, which records each consult and routes to one candidate. */
class RoutingDouble extends Service {
  readonly bases: { agent: string; base: ModelSelection }[] = []

  constructor(ctx: Context) {
    super(ctx, 'modelRouting')
  }

  stickySelection(): ModelSelection | undefined {
    return undefined
  }

  resolveRequest(agent: Agent, _turn: number, _step: number, base: ModelSelection): Promise<ModelSelection | undefined> {
    this.bases.push({ agent: agent.id, base })
    return Promise.resolve({ provider: 'cheap-provider', model: 'cheap-model' })
  }
}

/** The Host API over the real registry and a factory that publishes through it. */
async function composed(options: { defaultModel?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  if (options.defaultModel === true) await ctx.plugin(AgentDefaultModel, { provider: 'default-provider', model: 'default-model' })
  await ctx.plugin(RoutingDouble)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, created: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(created.sessionId, {
        ...created.seed === undefined ? {} : { seed: [...created.seed] },
        ...created.meta === undefined ? {} : { meta: created.meta },
      })
      const agent = {} as Agent
      // The agent and its model-selection hook live on the root, so a proxy's
      // fiber owns only the selection it provided.
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await created.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('these sessions are live')),
  })
  return ctx
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

/** Assemble the prompt, which snapshots the selection, and run one request through the agent's own waterfall. */
async function requestFor(agent: Agent): Promise<unknown> {
  await agent.ctx.systemPrompt.assemble()
  return agentEvents(agent.ctx, agent).waterfall(
    'agent/request',
    { turn: 1, step: 0, content: { messages: [], system: '', tools: [] }, signal: new AbortController().signal },
    () => Promise.resolve({ provider: 'default-provider', model: 'default-model' }),
  )
}

describe('the Host API model selection', () => {
  it('routes a Web fork, which is a root agent although it records a parent session', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    // The source runs in its own context: this test factory does not scope agent
    // events, so a source hook on the shared bus would also answer the fork's request.
    const sourceSession = ctx.sessions.create('session-source' as SessionId, { meta: { cwd: '/proj' } })
    const source = { id: sourceSession.id, session: sourceSession, status: 'idle', ctx: new Context() } as unknown as Agent
    ctx.agents.register(source)
    source.session.append('turn/start', { turn: 1 })
    source.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    source.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const forked = await proxy.sessions.fork(request({ sessionId: source.id }))
    if (!forked.result.ok) throw new Error('the fork failed')
    const child = ctx.agents.get(forked.result.value.sessionId)
    if (child === undefined) throw new Error('the fork has no agent')
    expect(child.session.header.parentSession).toBe(source.id)
    expect(child.session.header.delegationDepth).toBeUndefined()
    expect(modelSelectionInstalled(child)).toBe(true)
    await expect(requestFor(child)).resolves.toMatchObject({ provider: 'cheap-provider', model: 'cheap-model' })
    const routing = ctx.get('modelRouting') as unknown as RoutingDouble
    expect(routing.bases).toEqual([{ agent: child.id, base: { provider: 'default-provider', model: 'default-model' } }])
    await ctx.fiber.dispose()
  })

  it('withdraws a selection it provided when its fiber is disposed, so a reloaded proxy provides its own', async () => {
    const ctx = await composed()
    // The model catalog the second proxy reads; it lists no providers.
    ctx.provide('llm', { listProviders: () => [] } as never)
    const routing = ctx.get('modelRouting') as unknown as RoutingDouble
    const proxyIn = async (
      name: string,
      provider: string,
    ): Promise<{ proxy: ReturnType<typeof createApiProxy>; fiber: { dispose(): Promise<unknown> } }> => {
      let proxy: ReturnType<typeof createApiProxy> | undefined
      const fiber = await ctx.plugin({
        name,
        // The services this test's proxy reaches through its own context.
        inject: ['agents', 'llm', 'sessions', 'userQuestions', 'workspaceRegistry'],
        apply: (inner: Context) => {
          proxy = createApiProxy(inner, { defaultModelSelection: () => ({ provider, model: `${provider}-model` }), cwd: '/tmp' })
        },
      })
      if (proxy === undefined) throw new Error('the proxy did not mount')
      return { proxy, fiber }
    }
    const first = await proxyIn('proxy-first', 'old-provider')
    const created = await first.proxy.sessions.create(request({ sessionId: 'session-reloaded' as SessionId }))
    expect(created.result.ok).toBe(true)
    const agent = ctx.agents.get('session-reloaded' as SessionId)
    if (agent === undefined) throw new Error('the session has no agent')
    await requestFor(agent)
    expect(routing.bases.at(-1)?.base).toEqual({ provider: 'old-provider', model: 'old-provider-model' })

    // The proxy unloads: its selection is withdrawn, and the hook uses the
    // resolved route until a provider returns.
    await first.fiber.dispose()
    expect(modelSelectionInstalled(agent)).toBe(true)
    await requestFor(agent)
    expect(routing.bases.at(-1)?.base).toEqual({ provider: 'default-provider', model: 'default-model' })

    // The reloaded proxy provides its own selection on its first read, and each
    // request is still consulted once.
    const second = await proxyIn('proxy-second', 'new-provider')
    const models = await second.proxy.sessions.models(request({ sessionId: agent.id }))
    expect(models.result).toMatchObject({ ok: true, value: { current: { provider: 'new-provider', model: 'new-provider-model' } } })
    const before = routing.bases.length
    await requestFor(agent)
    expect(routing.bases).toHaveLength(before + 1)
    expect(routing.bases.at(-1)?.base).toEqual({ provider: 'new-provider', model: 'new-provider-model' })

    // Disposing the agent releases the withdrawal early; a later provider is free.
    ctx.emit('agent/disposed', { agent })
    ctx.emit('agent/disposed', { agent })
    provideModelSelection(agent, { current: undefined, assembled: undefined })()
    await ctx.fiber.dispose()
  })

  it('gives a Web session exactly one selection provider when the Host API delegates to agentDefaultModel', async () => {
    const ctx = await composed({ defaultModel: true })
    const created = await api(ctx).sessions.create(request({ sessionId: 'session-default' as SessionId }))
    expect(created.result.ok).toBe(true)
    const agent = ctx.agents.get('session-default' as SessionId)
    if (agent === undefined) throw new Error('the session has no agent')
    // The Host API asked agentDefaultModel, which provided its reference once; asking again returns it.
    const provided = ctx.agentDefaultModel.selectionFor(agent)
    expect(ctx.agentDefaultModel.selectionFor(agent)).toBe(provided)
    expect(() => { provideModelSelection(agent, { current: undefined, assembled: undefined }) })
      .toThrow(`agent "${agent.id}" already has a model selection provider`)
    await requestFor(agent)
    const routing = ctx.get('modelRouting') as unknown as RoutingDouble
    expect(routing.bases.filter(entry => entry.agent === agent.id)).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
