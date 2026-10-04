/**
 * Shared MCP resource tools: registration follows the visible provider set,
 * and each call names the server it reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId } from '@shres-code/shres-code-llm'
import { renderPrompt } from '@shres-code/shres-code-system-prompt'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime, { type JsonValue } from '@shres-code/shres-code-tools'
import type { McpResourceRequest } from '@shres-code/shres-code-mcp-resources'
import McpResourceRuntime from '@shres-code/shres-code-mcp-resources'
import { renderResourceResult } from '../src/render.ts'

const { scopeControl } = vi.hoisted(() => ({ scopeControl: { throwOnce: false } }))

vi.mock('@shres-code/shres-code-scope', async () => {
  const actual = await vi.importActual<typeof import('@shres-code/shres-code-scope')>('@shres-code/shres-code-scope')
  return {
    ...actual,
    createScope: (...args: Parameters<typeof actual.createScope>) => {
      if (scopeControl.throwOnce) {
        scopeControl.throwOnce = false
        throw new Error('scope failed')
      }
      return actual.createScope(...args)
    },
  }
})

const { createScope } = await import('@shres-code/shres-code-scope')

const testToolSignal = new AbortController().signal

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResourceRuntime)
  return ctx
}

function provider(request: (request: McpResourceRequest) => Promise<JsonValue> | JsonValue) {
  return { request: vi.fn(async (incoming: McpResourceRequest) => request(incoming)) }
}

async function scopeAgent(ctx: Context): Promise<{ ctx: Context }> {
  const agent = { ctx: undefined as Context | undefined }
  // The scope fiber inherits inject from its minting plugin. The root context
  // can read services without inject; a scoped context cannot.
  await ctx.plugin(Object.assign((inner: Context) => {
    const scope = createScope(inner, agent)
    agent.ctx = scope.ctx
  }, { inject: ['mcpResources'] }))
  if (agent.ctx === undefined) throw new Error('scope was not created')
  return agent as { ctx: Context }
}

async function call(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent?: object,
): Promise<Awaited<ReturnType<Context['tools']['execute']>>> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`${name}-${JSON.stringify(args)}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  } as never)
}

describe('mcp resource runtime', () => {
  it('redacts string blobs and leaves other blob values intact', () => {
    expect(renderResourceResult('demo', { blob: 12, nested: { blob: 'abcd' } })).toEqual([{
      type: 'text',
      text: 'MCP server: demo\n{"blob":12,"nested":{"blob":"[binary resource: 4 base64 characters; available to programmatic callers]"}}',
    }])
  })

  it('stays quiet until a provider exists, then lists sorted names without interpolating them', async () => {
    const ctx = await mount()
    expect(ctx.tools.get('list_mcp_resources')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'mcp-resource-servers'))
      .toMatchObject({ interpolate: false, text: '' })

    ctx.systemPrompt.variable('model', () => 'deepseek-v4')
    const seen: McpResourceRequest[] = []
    const servers = provider((request) => {
      seen.push(request)
      return { resources: [{ uri: 'file://a', blob: 'abcd' }] }
    })
    ctx.mcpResources.register('zeta', servers)
    ctx.mcpResources.register('{{model}}', servers)

    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered).toContain('["zeta","{{model}}"]')
    expect(ctx.tools.get('list_mcp_resources')).toBeDefined()
    expect(ctx.tools.get('list_mcp_resource_templates')).toBeDefined()
    expect(ctx.tools.get('read_mcp_resource')).toBeDefined()

    const listed = await call(ctx, 'list_mcp_resources', { server: 'zeta' })
    const continued = await call(ctx, 'list_mcp_resources', { server: 'zeta', cursor: 'page' })
    const templates = await call(ctx, 'list_mcp_resource_templates', { server: 'zeta' })
    const continuedTemplates = await call(ctx, 'list_mcp_resource_templates', { server: 'zeta', cursor: 'tpl' })
    const read = await call(ctx, 'read_mcp_resource', { server: 'zeta', uri: 'file://a' })
    expect(seen).toEqual([
      { method: 'resources/list' },
      { method: 'resources/list', cursor: 'page' },
      { method: 'resources/templates/list' },
      { method: 'resources/templates/list', cursor: 'tpl' },
      { method: 'resources/read', uri: 'file://a' },
    ])
    expect(listed.isError).toBe(false)
    if (listed.isError || read.isError) throw new Error('expected resource calls to succeed')
    expect(listed.value).toEqual({ resources: [{ uri: 'file://a', blob: 'abcd' }] })
    expect(read.content[0]).toEqual({
      type: 'text',
      text: 'MCP server: zeta\n{"resources":[{"uri":"file://a","blob":"[binary resource: 4 base64 characters; available to programmatic callers]"}]}',
    })
    expect(templates.isError).toBe(false)
    expect(continued.isError).toBe(false)
    expect(continuedTemplates.isError).toBe(false)

    const missing = await call(ctx, 'read_mcp_resource', { server: 'missing', uri: 'file://a' })
    expect(missing.isError).toBe(true)
    expect(missing.error?.message).toContain('MCP resource server "missing" is unavailable in this agent\'s scope')
  })

  it('removes the shared tools only when the last provider in the scope is gone', async () => {
    const ctx = await mount()
    const first = provider(() => ({ resources: [] }))
    const second = provider(() => ({ resources: [] }))
    const removeFirst = ctx.mcpResources.register('alpha', first)
    const removeSecond = ctx.mcpResources.register('beta', second)
    removeFirst()
    expect(ctx.tools.get('list_mcp_resources')).toBeDefined()
    const listed = await call(ctx, 'list_mcp_resources', { server: 'beta' })
    expect(listed.isError).toBe(false)
    removeSecond()
    expect(ctx.tools.get('list_mcp_resources')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'mcp-resource-servers')?.text).toBe('')
  })

  it('rejects a duplicate server name and allows that name in another scope', async () => {
    const ctx = await mount()
    const globalProvider = provider(() => ({ resources: ['global'] }))
    ctx.mcpResources.register('demo', globalProvider)
    expect(() => ctx.mcpResources.register('demo', globalProvider)).toThrow(/already registered in this scope/)

    const agentA = await scopeAgent(ctx)
    const agentB = await scopeAgent(ctx)
    const providerA = provider(() => ({ resources: ['a'] }))
    const providerB = provider(() => ({ resources: ['b'] }))
    agentA.ctx.mcpResources.register('demo', providerA)
    agentB.ctx.mcpResources.register('demo', providerB)

    const fromA = await call(ctx, 'list_mcp_resources', { server: 'demo' }, agentA)
    const fromB = await call(ctx, 'list_mcp_resources', { server: 'demo' }, agentB)
    const fromGlobal = await call(ctx, 'list_mcp_resources', { server: 'demo' })
    expect(providerA.request).toHaveBeenCalledOnce()
    expect(providerB.request).toHaveBeenCalledOnce()
    expect(globalProvider.request).toHaveBeenCalledOnce()
    if (fromA.isError || fromB.isError || fromGlobal.isError) throw new Error('expected each scope to see its own server')
    expect(fromA.value).toEqual({ resources: ['a'] })
    expect(fromB.value).toEqual({ resources: ['b'] })
    expect(fromGlobal.value).toEqual({ resources: ['global'] })
    expect(ctx.tools.get('list_mcp_resources', agentA)).toBeDefined()
    expect(ctx.tools.get('list_mcp_resources')).toBeDefined()
  })

  it('rolls the provider back when tool registration fails and accepts the next registration', async () => {
    const ctx = await mount()
    const agent = await scopeAgent(ctx)
    const servers = provider(() => ({ resources: [] }))
    scopeControl.throwOnce = true
    expect(() => agent.ctx.mcpResources.register('demo', servers)).toThrow(/scope failed/)
    expect(ctx.tools.get('list_mcp_resources', agent)).toBeUndefined()
    agent.ctx.mcpResources.register('demo', servers)
    expect(ctx.tools.get('list_mcp_resources', agent)).toBeDefined()
  })
})
