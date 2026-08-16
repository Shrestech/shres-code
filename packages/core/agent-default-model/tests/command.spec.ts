/** `/model` parsing, listing, and session-local switch. */

import { describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import type { Agent, ModelSelection } from '@roos-code/roos-code-agent'
import CommandRuntime from '@roos-code/roos-code-commands'
import { LlmError, type LlmCallConfig } from '@roos-code/roos-code-llm'
import { SettingsProvider } from '@roos-code/roos-code-settings'
import type { SettingsNamespace } from '@roos-code/roos-code-settings'
import SessionStore, { SessionId } from '@roos-code/roos-code-session'
import { createScope } from '@roos-code/roos-code-scope'
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
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high',
    })
    const cleared = await ctx.commands.execute(agent, '/model openai gpt-4.1', new AbortController().signal)
    expect(cleared?.result.text).toBe('model: openai gpt-4.1')
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'openai', model: 'gpt-4.1' })
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
  it('prefers a process-local pick, then the logged header, then the live default', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    let header: { config: ModelSelection } | undefined
    const session = { requestHeader: () => header } as Agent['session']
    const agent = { id: 'sel', session, ctx } as unknown as Agent
    const first = ctx.agentDefaultModel.selectionFor(agent)
    expect(first.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(ctx.agentDefaultModel.selectionFor(agent)).toBe(first)

    header = { config: { provider: 'openai', model: 'gpt-4.1' } }
    expect(first.current).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    header = { config: { provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high' } }
    expect(first.current).toEqual({ provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high' })

    const next: ModelSelection = { provider: 'ollama-local', model: 'llama3.2' }
    first.current = next
    expect(first.current).toEqual(next)
    await ctx.fiber.dispose()
  })
})
