/**
 * History messages whose stored replay state this build cannot use (a session
 * recorded before the replay version changed): each degrades to the same
 * provider-neutral bytes on every request, is reported once per message, and
 * is tracked weakly so the tracking leaves with the session's history.
 */

import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { CallId, createMessage, createToolResultMessage, createUserMessage } from '@shres-code/shres-code-llm'
import type { GenerateOptions, Message } from '@shres-code/shres-code-llm'
import * as LlmPiAi from '@shres-code/shres-code-llm-pi-ai'
import { PiAiAdapter } from '@shres-code/shres-code-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const USER = { kind: 'plugin' as const, plugin: 'test' }

/** A replay state this build no longer reads: the pi-ai envelope before version 3. */
function versionTwo(provider: string, api: string, blocks: unknown[], stopReason: string): unknown {
  return { response: { kind: 'pi-ai', version: 2, api, provider, model: 'm', responseId: 'resp_1', stopReason }, blocks }
}

/** A resumed session's history with two degraded assistant messages, one of them calling a tool. */
function resumedHistory(provider: string, api = 'openai-completions'): Message[] {
  const call = CallId('call_1')
  return [
    createUserMessage({ content: [{ type: 'text', text: 'list files' }], source: USER }),
    createMessage({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should list.' },
        { type: 'text', text: 'Listing.' },
        { type: 'tool-call', id: call, name: 'bash', arguments: '{"cmd":"ls","n":2}' },
      ],
      source: {
        kind: 'model', provider, model: 'm',
        replayState: versionTwo(provider, api, [{ type: 'reasoning', thinkingSignature: 'sig-1' }, { type: 'text' }, { type: 'tool-call' }], 'toolUse'),
      },
    }),
    createToolResultMessage({ callId: call, content: [{ type: 'text', text: 'a.txt b.txt' }], isError: false }),
    createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Two files.' }],
      source: { kind: 'model', provider, model: 'm', replayState: versionTwo(provider, api, [{ type: 'text' }], 'stop') },
    }),
  ]
}

/** One follow-up turn, as the loop appends before its next request. */
function followUp(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: USER })
}

async function drain(adapter: PiAiAdapter, options: GenerateOptions): Promise<void> {
  for await (const _chunk of adapter.stream(options)) { /* consume */ }
}

/** A direct adapter over one hand-declared route at the mock endpoint. */
function adapterAt(baseURL: string, api: string, onReplayDegrade?: PiAiAdapterOptions['onReplayDegrade']): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ 'route-mock': { api, baseURL, models: [{ id: 'm' }] } }),
    resolveApiKey: () => Promise.resolve('test-key'),
    ...onReplayDegrade === undefined ? {} : { onReplayDegrade },
  })
}
type PiAiAdapterOptions = ConstructorParameters<typeof PiAiAdapter>[0]

describe('replay degradation across requests', () => {
  it('reports each degraded history message once over three requests', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }, { events: textEvents }])
    const onReplayDegrade = vi.fn()
    const adapter = adapterAt(server.url, 'openai-completions', onReplayDegrade)
    // The loop derives each request from the session's shared durable messages.
    const history = resumedHistory('route-mock')
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
      history.push(followUp(text))
      await drain(adapter, { provider: 'route-mock', model: 'm', messages: [...history] })
      expect(server.requests).toHaveLength(index + 1)
    }
    const detail = { provider: 'route-mock', model: 'm', reason: 'invalid pi-ai replay state: unsupported version 2' }
    expect(onReplayDegrade.mock.calls).toEqual([[detail], [detail]])
  })

  it('reports a degraded message first seen on a later request when it appears', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const onReplayDegrade = vi.fn()
    const adapter = adapterAt(server.url, 'openai-completions', onReplayDegrade)
    const [prompt, first, result, second] = resumedHistory('route-mock')
    await drain(adapter, { provider: 'route-mock', model: 'm', messages: [prompt!, first!, result!, followUp('go on')] })
    expect(onReplayDegrade).toHaveBeenCalledTimes(1)
    await drain(adapter, { provider: 'route-mock', model: 'm', messages: [prompt!, first!, result!, second!, followUp('and now')] })
    expect(onReplayDegrade).toHaveBeenCalledTimes(2)
  })

  it('holds reported messages weakly, so a released session history is collectable', async () => {
    // The flag and the context's gc() apply to this process only.
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const server = await mockServer([{ events: textEvents }])
    const onReplayDegrade = vi.fn()
    const adapter = adapterAt(server.url, 'openai-completions', onReplayDegrade)
    let history: Message[] | undefined = resumedHistory('route-mock')
    const released = new WeakRef(history[1]!.source)
    await drain(adapter, { provider: 'route-mock', model: 'm', messages: [...history, followUp('go on')] })
    expect(onReplayDegrade).toHaveBeenCalledTimes(2)
    // Disposing a session drops its history; the adapter keeps no strong reference.
    history = undefined
    await new Promise(resolve => setImmediate(resolve))
    gc()
    expect(released.deref()).toBeUndefined()
  })

  it.each([['openai-completions'], ['openai-responses'], ['anthropic-messages']])(
    '%s: degraded history sends the same bytes on every request, so only the first request after resume misses the cache',
    async (api) => {
      const server = await mockServer([{ status: 400, body: '{}' }, { status: 400, body: '{}' }, { status: 400, body: '{}' }])
      const adapter = adapterAt(server.url, api)
      const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }]
      const request = (messages: Message[]): GenerateOptions => ({ provider: 'route-mock', model: 'm', system: 'sys', tools, messages })
      // Two conversions of equal history, from distinct message objects: the bytes depend on content alone.
      await drain(adapter, request([...resumedHistory('route-mock', api), followUp('thanks')]))
      await drain(adapter, request([...resumedHistory('route-mock', api), followUp('thanks')]))
      const answered = createMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'route-mock', model: 'm' } })
      await drain(adapter, request([...resumedHistory('route-mock', api), followUp('thanks'), answered, followUp('more')]))
      const [first, second, third] = server.requests
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      const history = (body: unknown): unknown[] => {
        const record = body as Record<string, unknown[]>
        return record['messages'] ?? record['input']!
      }
      // A later request extends the history without changing its earlier entries. The last
      // entry is excluded because Anthropic Messages moves its cache breakpoint to the newest turn.
      const sent = history(first)
      expect(JSON.stringify(history(third).slice(0, sent.length - 1))).toBe(JSON.stringify(sent.slice(0, -1)))
      // The degraded assistant turns are sent as provider-neutral content, not native replay.
      expect(JSON.stringify(history(first))).toContain('I should list.')
      expect(JSON.stringify(history(first))).not.toContain('sig-1')
    },
  )
})

describe('llm-pi-ai plugin replay warnings', () => {
  it('logs one warning per degraded history message across three requests', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }, { events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const history = resumedHistory('deepseek')
      for (const text of ['first', 'second', 'third']) {
        history.push(followUp(text))
        for await (const _chunk of ctx.llm.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [...history] })) { /* consume */ }
      }
      const degraded = warn.mock.calls.filter(([line]) => String(line).includes('unusable replay state'))
      expect(degraded).toHaveLength(2)
      expect(server.requests).toHaveLength(3)
    } finally {
      warn.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})
