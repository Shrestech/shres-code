import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import AgentLoop from '@shres-code/shres-code-agent-loop'
import { mountAgentLoopTestDependencies } from '@shres-code/shres-code-agent-loop-testkit'
import { SessionId } from '@shres-code/shres-code-session'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'
import * as SubagentSpawn from '@shres-code/shres-code-subagent-spawn-in-process'
import * as SubagentFork from '@shres-code/shres-code-subagent-fork-in-process'
import type { LlmResolvedModelInfo } from '@shres-code/shres-code-llm'
import { LlmError } from '@shres-code/shres-code-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import InvariantRegistry, { InvariantError } from '@shres-code/shres-code-invariants'
import * as ScopeInvariant from '@shres-code/shres-code-scope/invariant'
import SubagentRuntime, { effectiveChildRoute, SubagentError } from '../src/index.ts'
import type { SubagentChildRouteInput, SubagentChildRouteRequest } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Registered on both the strong route and the cheap route a listener picks. */
const STRONG = { provider: 'mock', model: 'strong' }
const CHEAP = { provider: 'cheap', model: 'flash' }

/** Resolves only the models it was built with, so an unknown id fails resolution. */
class StrictAdapter extends MockAdapter {
  constructor(private readonly known: readonly string[], private readonly onResolve?: () => void) {
    super([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.onResolve?.()
    if (!this.known.includes(model)) return Promise.reject(new LlmError(`unknown model "${model}"`, 'UNKNOWN_MODEL'))
    return super.resolveModel(provider, model)
  }
}

/** Boot the real loop with the spawn and fork providers and one strong parent. */
async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'shres-subagent-child-route-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter([STRONG.provider, CHEAP.provider], new MockAdapter([textResponse('child answer')]))
  const parent = ctx.agentLoop.create(SessionId('parent'), { ...STRONG })
  return { ctx, parent }
}

function input(parent: Agent, over: Partial<SubagentChildRouteInput> = {}): SubagentChildRouteInput {
  return { parent, kind: 'subagent', prompt: 'summarise the diff', signal: new AbortController().signal, ...over }
}

/** Register a global listener that answers every dispatch with `route`. */
function routeTo(ctx: Context, route: { provider?: string; model?: string } | undefined) {
  const listener = vi.fn(async (_request: SubagentChildRouteRequest) => route)
  ctx.on('subagent/child-route', listener)
  return listener
}

describe('subagent/child-route', () => {
  it('no listener is byte-identical: the requested options return unchanged', async () => {
    const { ctx, parent } = await setup()
    const requested = { maxTokens: 64 }
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toBeUndefined()
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent, { requested }))).toBe(requested)
  })

  it('asks listeners the fresh child\'s route question', async () => {
    const { ctx, parent } = await setup()
    const listener = routeTo(ctx, undefined)
    const signal = new AbortController().signal
    await ctx.subagents.resolveChildRoute('spawn', input(parent, { agentType: 'explore', signal }))
    await ctx.subagents.resolveChildRoute('spawn', input(parent, { kind: 'workflow' }))

    const [first] = listener.mock.calls[0]!
    expect(first.parent).toBe(parent)
    expect(first).toMatchObject({
      kind: 'subagent',
      subagentProvider: 'spawn',
      inherited: STRONG,
      agentType: 'explore',
      prompt: 'summarise the diff',
    })
    expect(first.signal).toBe(signal)
    const [second] = listener.mock.calls[1]!
    expect(second.kind).toBe('workflow')
    expect('agentType' in second).toBe(false)
  })

  it('a listener route is applied to the spawned child', async () => {
    const { ctx, parent } = await setup()
    routeTo(ctx, CHEAP)
    const agentOptions = await ctx.subagents.resolveChildRoute('spawn', input(parent, { requested: { maxTokens: 64 } }))
    expect(agentOptions).toEqual({ ...CHEAP, maxTokens: 64 })
    // The reported route and the run route derive from the same options.
    expect(effectiveChildRoute(parent, agentOptions)).toEqual(CHEAP)

    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'summarise the diff' }],
      parent,
      signal: new AbortController().signal,
      ...agentOptions !== undefined ? { agentOptions } : {},
    })
    await run.result
    const header = run.localAgent?.session.requestHeader()?.config
    expect({ provider: header?.provider, model: header?.model }).toEqual(CHEAP)
    await run.dispose()
  })

  it('merges a partial listener route over the inherited route', async () => {
    const { ctx, parent } = await setup()
    routeTo(ctx, { model: 'flash' })
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toEqual({ provider: 'mock', model: 'flash' })
  })

  it('keeps the requested options when the listener answers with the inherited route', async () => {
    const { ctx, parent } = await setup()
    routeTo(ctx, { provider: 'cheap' })
    const requested = { maxTokens: 64 }
    // The provider-only answer changes the route, so it resolves; the inherited answer does not.
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toEqual({ provider: 'cheap', model: 'strong' })
    const sameRoute = await ctx.plugin(Object.assign((inner: Context) => {
      inner.on('subagent/child-route', async () => ({ ...STRONG }), { prepend: true })
    }, { inject: ['subagents'] }))
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent, { requested }))).toBe(requested)
    await sameRoute.dispose()
  })

  it('explicit request overrides child route', async () => {
    const { ctx, parent } = await setup()
    const listener = routeTo(ctx, CHEAP)
    for (const requested of [{ model: 'pinned' }, { provider: 'mock' }]) {
      expect(await ctx.subagents.resolveChildRoute('spawn', input(parent, { requested }))).toBe(requested)
    }
    expect(listener).not.toHaveBeenCalled()
  })

  it('fork children are never routed', async () => {
    const { ctx, parent } = await setup()
    const listener = routeTo(ctx, CHEAP)
    expect(await ctx.subagents.resolveChildRoute('fork', input(parent))).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })

  it('never consults for a provider whose child does not run requested routes', async () => {
    const { ctx, parent } = await setup()
    const listener = routeTo(ctx, CHEAP)
    ctx.subagents.registerProvider({
      name: 'remote',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('not started in this test')),
    })
    expect(await ctx.subagents.resolveChildRoute('remote', input(parent))).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })

  it('listener disposal restores inheritance (HMR safety)', async () => {
    const { ctx, parent } = await setup()
    const listener = vi.fn(async () => CHEAP)
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.on('subagent/child-route', listener)
    }, { inject: ['subagents'] }))
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toEqual(CHEAP)

    await fiber.dispose()
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a parent-scoped listener answers only for its own delegations', async () => {
    const { ctx, parent } = await setup()
    const other = ctx.agentLoop.create(SessionId('other-parent'), { ...STRONG })
    const listener = vi.fn(async () => CHEAP)
    parent.ctx.on('subagent/child-route', listener)

    expect(await ctx.subagents.resolveChildRoute('spawn', input(other))).toBeUndefined()
    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toEqual(CHEAP)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dispatches with a carrier keyed to the payload parent, which the scope invariant accepts', async () => {
    const { ctx, parent } = await setup()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ScopeInvariant)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    routeTo(ctx, CHEAP)

    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent))).toEqual(CHEAP)
    expect(warn).not.toHaveBeenCalled()
  })

  it('an invariant failure raised during the dispatch propagates instead of falling back', async () => {
    const { ctx, parent } = await setup()
    await ctx.plugin(InvariantRegistry)
    const registration = ctx.invariants.register('@test/child-route-invariant', (inner, fail) => {
      inner.on('internal/dispatch', (_mode, eventName) => {
        if (eventName === 'subagent/child-route') fail('child-route dispatch breaks the test invariant')
      }, { global: true })
    })
    // The returned disposer carries Cordis setup thenability: installation finishes asynchronously.
    await (registration as unknown as PromiseLike<void>)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    routeTo(ctx, CHEAP)

    const rejected = ctx.subagents.resolveChildRoute('spawn', input(parent))
    await expect(rejected).rejects.toBeInstanceOf(InvariantError)
    await expect(rejected).rejects.toThrow('child-route dispatch breaks the test invariant')
    expect(warn).not.toHaveBeenCalled()
  })

  it('a throwing listener falls back to inheritance and is logged', async () => {
    const { ctx, parent } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('subagent/child-route', () => { throw new Error('policy broke') })
    const requested = { maxTokens: 64 }

    expect(await ctx.subagents.resolveChildRoute('spawn', input(parent, { requested }))).toBe(requested)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(
      'subagent/child-route listener failed for a "subagent" child on "spawn"; the child keeps its inherited route: Error: policy broke',
    )
  })

  it('rejects with the cancellation reason instead of falling back', async () => {
    const { ctx, parent } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    const reason = new Error('delegation cancelled')
    ctx.on('subagent/child-route', () => {
      controller.abort(reason)
      throw new Error('judge aborted')
    })

    await expect(ctx.subagents.resolveChildRoute('spawn', input(parent, { signal: controller.signal }))).rejects.toBe(reason)
    expect(warn).not.toHaveBeenCalled()
  })

  it('rejects a route whose provider has no registered adapter, before any child exists', async () => {
    const { ctx, parent } = await setup()
    routeTo(ctx, { provider: 'nowhere', model: 'flash' })
    const children = ctx.agents.list().length

    const rejected = ctx.subagents.resolveChildRoute('spawn', input(parent))
    await expect(rejected).rejects.toBeInstanceOf(SubagentError)
    await expect(rejected).rejects.toMatchObject({ code: 'INVALID_CHILD_ROUTE' })
    await expect(rejected).rejects.toThrow('subagent/child-route chose "nowhere/flash", which is not a registered model')
    expect(ctx.agents.list()).toHaveLength(children)
  })

  it('rejects a model the registered adapter cannot resolve', async () => {
    const { ctx, parent } = await setup()
    ctx.llm.registerAdapter(['strict'], new StrictAdapter(['known']))
    routeTo(ctx, { provider: 'strict', model: 'unknown' })
    const rejected = ctx.subagents.resolveChildRoute('spawn', input(parent))
    await expect(rejected).rejects.toMatchObject({ code: 'INVALID_CHILD_ROUTE' })
    await expect(rejected).rejects.toThrow('unknown model "unknown"')
  })

  it('rejects with the cancellation reason when cancelled during model resolution', async () => {
    const { ctx, parent } = await setup()
    const controller = new AbortController()
    const reason = new Error('delegation cancelled')
    ctx.llm.registerAdapter(['strict'], new StrictAdapter([], () => { controller.abort(reason) }))
    routeTo(ctx, { provider: 'strict', model: 'flash' })
    await expect(ctx.subagents.resolveChildRoute('spawn', input(parent, { signal: controller.signal }))).rejects.toBe(reason)
  })

  it.each([
    ['no provider', {}, { model: 'flash' }, 'provider undefined, model "flash"'],
    ['no model', { provider: 'mock' }, { provider: 'cheap' }, 'provider "cheap", model undefined'],
  ])('rejects an incomplete route with %s', async (_name, parentRoute, answer, detail) => {
    const { ctx } = await setup()
    const parent = ctx.agentLoop.create(SessionId('partial-parent'), parentRoute)
    routeTo(ctx, answer)
    await expect(ctx.subagents.resolveChildRoute('spawn', input(parent))).rejects.toMatchObject({
      code: 'INVALID_CHILD_ROUTE',
      message: `subagent/child-route chose an incomplete route (${detail}); a routed child needs both`,
    })
  })

  it('rejects a route when no llm service is composed to resolve it', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'local',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      runsRequestedModel: true,
      start: () => Promise.reject(new Error('not started in this test')),
    })
    routeTo(ctx, CHEAP)
    const parent = {
      ctx: { get: () => undefined },
      options: { ...STRONG },
      session: { header: {}, events: [], requestHeader: () => undefined },
    } as unknown as Agent
    await expect(ctx.subagents.resolveChildRoute('local', input(parent))).rejects.toMatchObject({
      code: 'INVALID_CHILD_ROUTE',
      message: 'subagent/child-route chose "cheap/flash", but no llm service is composed to resolve it',
    })
  })

  it('rejects an unregistered subagent provider', async () => {
    const { ctx, parent } = await setup()
    await expect(ctx.subagents.resolveChildRoute('missing', input(parent))).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })
})
