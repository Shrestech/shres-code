/** `/model` parsing, listing, and session-local switch. */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { agentEvents, modelSelectionInstalled, provideModelSelection } from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection } from '@shres-code/shres-code-agent'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import CommandRuntime from '@shres-code/shres-code-commands'
import { LlmError, ReasoningEffortId, type LlmCallConfig } from '@shres-code/shres-code-llm'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import { createScope } from '@shres-code/shres-code-scope'
import AgentDefaultModelConfig, {
  MODEL_COMMAND_USAGE,
  parseModelCommand,
} from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function mockLlm(options: {
  providers?: { id: string }[]
  models?: Record<string, { id: string; name: string; provider: string }[]>
  efforts?: Record<string, { id: string; name: string }[]>
  hostedTools?: Record<string, readonly string[]>
  defaultEffort?: string
  materializeDefault?: string
  remapEffort?: string
  resolveError?: Error
  infoError?: Error
} = {}) {
  const providers = options.providers ?? [{ id: 'deepseek-official' }]
  const models = options.models ?? {
    'deepseek-official': [{ id: 'deepseek-v4-flash', name: 'Flash', provider: 'deepseek-official' }],
  }
  return {
    listProviders: () => providers,
    listModels: (provider: string) => Promise.resolve(models[provider] ?? []),
    resolveModelInfo: (provider: string, model: string) => {
      if (options.infoError !== undefined) return Promise.reject(options.infoError)
      const efforts = options.efforts?.[`${provider}/${model}`]
      const hostedTools = options.hostedTools?.[`${provider}/${model}`]
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        ...efforts === undefined
          ? {}
          : {
            reasoning: {
              efforts,
              ...options.defaultEffort === undefined || model !== 'deepseek-v4-flash'
                ? {}
                : { defaultEffort: options.defaultEffort },
            },
          },
        ...hostedTools === undefined ? {} : { hostedTools },
      })
    },
    resolveCallConfig: (config: LlmCallConfig) => {
      if (options.resolveError !== undefined) return Promise.reject(options.resolveError)
      const efforts = options.efforts?.[`${config.provider}/${config.model}`]
      if (config.reasoningEffort !== undefined && efforts !== undefined
        && !efforts.some(effort => effort.id === config.reasoningEffort)) {
        return Promise.reject(new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${config.reasoningEffort}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        ))
      }
      if (config.reasoningEffort === undefined && options.materializeDefault !== undefined) {
        return Promise.resolve({ ...config, reasoningEffort: options.materializeDefault })
      }
      if (config.reasoningEffort !== undefined && options.remapEffort !== undefined) {
        return Promise.resolve({ ...config, reasoningEffort: options.remapEffort })
      }
      return Promise.resolve(config)
    },
  }
}

async function boot(options: { llm?: ReturnType<typeof mockLlm> | false } = {}) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  if (options.llm !== false) ctx.provide('llm', options.llm ?? mockLlm())
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  const session = ctx.sessions.create(SessionId('model-cmd'))
  const agent = { id: session.id, session, ctx } as unknown as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return { ctx, session, agent }
}

describe('parseModelCommand()', () => {
  it('parses show, set, effort-only, and rejects malformed lines', () => {
    expect(parseModelCommand('')).toEqual({ kind: 'show' })
    expect(parseModelCommand('   ')).toEqual({ kind: 'show' })
    expect(parseModelCommand(' ollama-local  llama3.2 ')).toEqual({
      kind: 'set', provider: 'ollama-local', model: 'llama3.2',
    })
    expect(parseModelCommand('ollama-local llama3.2 --effort high')).toEqual({
      kind: 'set', provider: 'ollama-local', model: 'llama3.2', effort: 'high',
    })
    expect(parseModelCommand('--effort max')).toEqual({ kind: 'set', effort: 'max' })
    expect(parseModelCommand('--effort')).toEqual({ error: MODEL_COMMAND_USAGE })
    expect(parseModelCommand('--effort --high')).toEqual({ error: MODEL_COMMAND_USAGE })
    expect(parseModelCommand('--effort a --effort b')).toEqual({ error: MODEL_COMMAND_USAGE })
    expect(parseModelCommand('--unknown x')).toEqual({ error: MODEL_COMMAND_USAGE })
    expect(parseModelCommand('only-one')).toEqual({ error: MODEL_COMMAND_USAGE })
    expect(parseModelCommand('a b c')).toEqual({ error: MODEL_COMMAND_USAGE })
  })
})

describe('/model command', () => {
  it('lists the current selection, purpose overrides, and advertised efforts', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        providers: [{ id: 'deepseek-official' }, { id: 'empty-route' }],
        models: {
          'deepseek-official': [
            { id: 'deepseek-v4-flash', name: 'Flash', provider: 'deepseek-official' },
            { id: 'deepseek-v4-pro', name: 'Pro', provider: 'deepseek-official' },
          ],
          'empty-route': [],
        },
        efforts: {
          'deepseek-official/deepseek-v4-flash': [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
          ],
          'deepseek-official/deepseek-v4-pro': [{ id: 'max', name: 'Max' }],
        },
        defaultEffort: 'high',
      }),
    })
    await ctx.agentDefaultModel.saveSelection(
      { provider: 'ollama-local', model: 'qwen3' },
      { purpose: 'compaction' },
    )
    const execution = await ctx.commands.execute(agent, '/model', new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain('current: deepseek-official deepseek-v4-flash')
    expect(execution?.result.text).toContain('purpose compaction: ollama-local qwen3')
    expect(execution?.result.text).toContain('deepseek-v4-flash  efforts: off, high default=high')
    expect(execution?.result.text).toContain('deepseek-v4-pro  efforts: max')
    expect(execution?.result.text).toContain('(no advertised models)')
    expect(execution?.result.text).not.toContain('web search')
    const run = agent.session.events.find(event => event.type === 'command/run')
    expect(run?.data).toMatchObject({ name: 'model', source: { kind: 'user' } })
    await ctx.fiber.dispose()
  })

  it('sets a model without llm when no effort is requested', async () => {
    const { ctx, agent } = await boot({ llm: false })
    const execution = await ctx.commands.execute(
      agent, '/model ollama-local llama3.2', new AbortController().signal,
    )
    expect(execution?.result).toEqual({ kind: 'success', text: 'model: ollama-local llama3.2' })
    await ctx.fiber.dispose()
  })

  it('lists without llm and ignores resolveModelInfo failures', async () => {
    const bare = await boot({ llm: false })
    const listed = await bare.ctx.commands.execute(bare.agent, '/model', new AbortController().signal)
    expect(listed?.result.text).toBe('current: deepseek-official deepseek-v4-flash')
    await bare.ctx.fiber.dispose()

    const failing = await boot({
      llm: mockLlm({
        infoError: new Error('adapter down'),
        models: {
          'deepseek-official': [{ id: 'deepseek-v4-flash', name: 'Flash', provider: 'deepseek-official' }],
        },
      }),
    })
    const catalog = await failing.ctx.commands.execute(failing.agent, '/model', new AbortController().signal)
    expect(catalog?.result.text).toContain('    deepseek-v4-flash')
    expect(catalog?.result.text).not.toContain('efforts:')
    await failing.ctx.fiber.dispose()
  })

  it('appends a web search marker only when hostedTools includes web_search', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        providers: [{ id: 'openai' }, { id: 'grok-session' }],
        models: {
          openai: [
            { id: 'gpt-search', name: 'Search', provider: 'openai' },
            { id: 'gpt-plain', name: 'Plain', provider: 'openai' },
          ],
          'grok-session': [{ id: 'grok-4', name: 'Grok', provider: 'grok-session' }],
        },
        efforts: {
          'openai/gpt-search': [{ id: 'high', name: 'High' }],
        },
        hostedTools: {
          'openai/gpt-search': ['web_search'],
          'grok-session/grok-4': ['x_search'],
        },
      }),
    })
    const listed = await ctx.commands.execute(agent, '/model', new AbortController().signal)
    const lines = listed?.result.text?.split('\n') ?? []
    expect(lines).toContain('    gpt-search  efforts: high · web search')
    expect(lines).toContain('    gpt-plain')
    expect(lines).toContain('    grok-4')
    await ctx.fiber.dispose()
  })

  it('switches the session selection and the stored default, including effort', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        providers: [{ id: 'openai' }],
        models: { openai: [{ id: 'gpt-4.1', name: 'GPT', provider: 'openai' }] },
        efforts: { 'openai/gpt-4.1': [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
      }),
    })
    const execution = await ctx.commands.execute(
      agent, '/model openai gpt-4.1 --effort high', new AbortController().signal,
    )
    expect(execution?.result).toEqual({ kind: 'success', text: 'model: openai gpt-4.1 effort=high' })
    expect(ctx.agentDefaultModel.selectionFor(agent).current).toEqual({
      provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high',
    })
    expect(agent.session.events.filter(event => event.type === 'agent/model-selection').map(event => event.data))
      .toEqual([{ provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high' }])
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high',
    })
    const cleared = await ctx.commands.execute(agent, '/model openai gpt-4.1', new AbortController().signal)
    expect(cleared?.result.text).toBe('model: openai gpt-4.1')
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    expect(agent.session.events.filter(event => event.type === 'agent/model-selection').map(event => event.data))
      .toEqual([
        { provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high' },
        { provider: 'openai', model: 'gpt-4.1' },
      ])
    await ctx.fiber.dispose()
  })

  it('does not persist an adapter-materialized defaultEffort when --effort is omitted', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        providers: [{ id: 'openai' }],
        models: { openai: [{ id: 'gpt-4.1', name: 'GPT', provider: 'openai' }] },
        materializeDefault: 'high',
      }),
    })
    const execution = await ctx.commands.execute(agent, '/model openai gpt-4.1', new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'model: openai gpt-4.1' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    await ctx.fiber.dispose()
  })

  it('rejects an effort that resolveCallConfig remaps', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        efforts: { 'deepseek-official/deepseek-v4-flash': [{ id: 'high', name: 'High' }] },
        remapEffort: 'max',
      }),
    })
    const execution = await ctx.commands.execute(agent, '/model --effort high', new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toMatch(/did not survive validation/)
    await ctx.fiber.dispose()
  })

  it('refuses /model on a subagent session', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.provide('llm', mockLlm())
    await ctx.plugin(AgentDefaultModelConfig, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const metas = [
      { origin: 'subagent' as const },
      { delegationDepth: 1 },
    ]
    for (const [index, meta] of metas.entries()) {
      const session = ctx.sessions.create(SessionId(`child-${String(index)}`), { meta })
      const agent = { id: session.id, session, ctx } as unknown as Agent
      await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
      const listed = await ctx.commands.execute(agent, '/model', new AbortController().signal)
      expect(listed?.result).toEqual({
        kind: 'error', text: 'model: /model is not available on a subagent session',
      })
    }
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await ctx.fiber.dispose()
  })

  it('accepts /model on a forked user session that only has parentSession', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.provide('llm', mockLlm({
      providers: [{ id: 'openai' }],
      models: { openai: [{ id: 'gpt-4.1', name: 'GPT', provider: 'openai' }] },
    }))
    await ctx.plugin(AgentDefaultModelConfig, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const session = ctx.sessions.create(SessionId('fork'), { meta: { parentSession: SessionId('parent') } })
    const agent = { id: session.id, session, ctx } as unknown as Agent
    await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
    const execution = await ctx.commands.execute(agent, '/model openai gpt-4.1', new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'model: openai gpt-4.1' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    await ctx.fiber.dispose()
  })

  it('changes only effort when provider and model are omitted', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        efforts: {
          'deepseek-official/deepseek-v4-flash': [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }],
        },
      }),
    })
    const execution = await ctx.commands.execute(agent, '/model --effort max', new AbortController().signal)
    expect(execution?.result.text).toBe('model: deepseek-official deepseek-v4-flash effort=max')
    await ctx.fiber.dispose()
  })

  it('rejects unknown effort, a missing llm when effort is set, and malformed input', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({
        efforts: { 'deepseek-official/deepseek-v4-flash': [{ id: 'high', name: 'High' }] },
      }),
    })
    const unknown = await ctx.commands.execute(agent, '/model --effort nope', new AbortController().signal)
    expect(unknown?.result.kind).toBe('error')
    expect(unknown?.result.text).toMatch(/does not support reasoning effort "nope"/)
    const bad = await ctx.commands.execute(agent, '/model only-one', new AbortController().signal)
    expect(bad?.result).toEqual({ kind: 'error', text: MODEL_COMMAND_USAGE })
    await ctx.fiber.dispose()

    const bare = await boot({ llm: false })
    const noLlm = await bare.ctx.commands.execute(bare.agent, '/model --effort high', new AbortController().signal)
    expect(noLlm?.result.text).toMatch(/no llm service is mounted/)
    await bare.ctx.fiber.dispose()
  })

  it('surfaces a non-LlmError from resolveCallConfig as a command error', async () => {
    const { ctx, agent } = await boot({
      llm: mockLlm({ resolveError: new TypeError('boom') }),
    })
    const execution = await ctx.commands.execute(agent, '/model openai gpt-4.1', new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'error', text: 'boom' })
    await ctx.fiber.dispose()

    const thrown = await boot({
      llm: mockLlm({ resolveError: 'nope' as unknown as Error }),
    })
    const other = await thrown.ctx.commands.execute(thrown.agent, '/model openai gpt-4.1', new AbortController().signal)
    expect(other?.result).toEqual({ kind: 'error', text: 'nope' })
    await thrown.ctx.fiber.dispose()
  })

  it('does not register /model without a command registry', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    expect(ctx.get('commands')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('selectionFor()', () => {
  it('prefers an explicit event, then the logged header, then the live default', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const session = ctx.sessions.create(SessionId('sel'))
    const agent = { id: 'sel', session, ctx } as unknown as Agent
    const first = ctx.agentDefaultModel.selectionFor(agent)
    expect(first.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(ctx.agentDefaultModel.selectionFor(agent)).toBe(first)

    session.append('request/header', {
      header: { config: { provider: 'openai', model: 'gpt-4.1' } },
      reason: 'initial',
    })
    expect(first.current).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    session.append('request/header', {
      header: { config: { provider: 'openai', model: 'gpt-4.1', reasoningEffort: ReasoningEffortId('high') } },
      reason: 'change',
    })
    expect(first.current).toEqual({ provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high' })

    const next: ModelSelection = { provider: 'ollama-local', model: 'llama3.2' }
    first.current = next
    expect(first.current).toEqual(next)
    expect(session.events.filter(event => event.type === 'agent/model-selection')).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

/** TEST DOUBLE: the smallest `ctx.modelRouting`, which records each consult and keeps the route. */
class RecordingRouting extends Service {
  readonly bases: ModelSelection[] = []

  constructor(ctx: Context) {
    super(ctx, 'modelRouting')
  }

  stickySelection(): ModelSelection | undefined {
    return undefined
  }

  resolveRequest(_agent: Agent, _turn: number, _step: number, base: ModelSelection): Promise<ModelSelection | undefined> {
    this.bases.push(base)
    return Promise.resolve(undefined)
  }
}

/** Assemble the prompt and run one request through the agent's waterfall. */
async function request(ctx: Context, agent: Agent): Promise<LlmCallConfig> {
  await ctx.systemPrompt.assemble()
  return agentEvents(ctx, agent).waterfall(
    'agent/request',
    { turn: 1, step: 0, content: { messages: [], system: '', tools: [] }, signal: new AbortController().signal },
    () => Promise.resolve({ provider: 'resolved', model: 'resolved-model' }),
  )
}

describe('selectionFor() across a reload of the service', () => {
  it('withdraws the selection when its fiber is disposed, so a reloaded instance provides its own', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(RecordingRouting)
    const routing = ctx.get('modelRouting') as unknown as RecordingRouting
    const session = ctx.sessions.create(SessionId('reloaded'))
    const agent = { id: 'reloaded', session, ctx } as unknown as Agent

    const first = await ctx.plugin(AgentDefaultModelConfig, { provider: 'old-provider', model: 'old-model' })
    expect(ctx.agentDefaultModel.selectionFor(agent).current).toEqual({ provider: 'old-provider', model: 'old-model' })
    await request(ctx, agent)
    expect(routing.bases).toEqual([{ provider: 'old-provider', model: 'old-model' }])

    // The provider unloads: the slot empties and the hook stays, taking the
    // manual route of an agent with no provided selection.
    await first.dispose()
    expect(modelSelectionInstalled(agent)).toBe(true)
    await request(ctx, agent)
    expect(routing.bases.at(-1)).toEqual({ provider: 'resolved', model: 'resolved-model' })

    // The reloaded instance provides its own selection, and each request is consulted once.
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'new-provider', model: 'new-model' })
    expect(ctx.agentDefaultModel.selectionFor(agent).current).toEqual({ provider: 'new-provider', model: 'new-model' })
    await request(ctx, agent)
    expect(routing.bases).toHaveLength(3)
    expect(routing.bases.at(-1)).toEqual({ provider: 'new-provider', model: 'new-model' })
    await ctx.fiber.dispose()
  })

  it('releases the withdrawal when the agent is disposed, leaving a later provider free', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    const session = ctx.sessions.create(SessionId('released'))
    const agent = { id: 'released', session, ctx } as unknown as Agent
    ctx.agentDefaultModel.selectionFor(agent)
    expect(() => { provideModelSelection(agent, { current: undefined, assembled: undefined }) })
      .toThrow('already has a model selection provider')
    ctx.emit('agent/disposed', { agent })
    ctx.emit('agent/disposed', { agent })
    const withdraw = provideModelSelection(agent, { current: undefined, assembled: undefined })
    withdraw()
    await ctx.fiber.dispose()
  })
})
