import { describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
} from '@shres-code/shres-code-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import { SettingsProvider, settingsNamespace } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@shres-code/shres-code-subprocess'
import { CliLlmAdapter } from '../src/adapter.ts'
import { buildCliArgv, effortFlags } from '../src/argv.ts'
import { Config, resolveRoutes, SHIPPED_ROUTES } from '../src/config.ts'
import {
  answerFromObject,
  isCliErrorPayload,
  parseCliOutput,
  usageFromObject,
} from '../src/parse.ts'
import { serializePrompt } from '../src/serialize.ts'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

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

function fakeChild(options: {
  stdout?: string
  outcome?: SubprocessOutcome
  pid?: number
  done?: Promise<SubprocessOutcome>
  collected?: SubprocessHandle['collected']
} = {}): SubprocessHandle {
  const stdout = options.stdout ?? JSON.stringify({ result: 'hello', usage: { input_tokens: 3, output_tokens: 2 } })
  const done = options.done ?? Promise.resolve(options.outcome ?? { exitCode: 0, signal: null })
  return {
    pid: options.pid ?? 99,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: options.collected ?? {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
    },
    done,
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'grok-cli',
    model: 'grok-4',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
    ...overrides,
  }
}

describe('argv and serialize', () => {
  it('forwards selected model and effort onto grok argv', () => {
    expect(buildCliArgv(SHIPPED_ROUTES['grok-cli'], {
      model: 'grok-4.6',
      effort: 'high',
      prompt: 'do it',
    })).toEqual([
      'grok',
      '--output-format', 'json',
      '--always-approve',
      '--no-auto-update',
      '--model', 'grok-4.6',
      '--effort', 'high',
      '-p', 'do it',
    ])
  })

  it('maps kimi thinking-bool and Codex config effort flags', () => {
    expect(buildCliArgv(SHIPPED_ROUTES['kimi-cli'], {
      model: 'kimi-code/k3',
      effort: 'high',
      prompt: 'q',
    })).toEqual([
      'kimi',
      '--output-format', 'stream-json',
      '--model', 'kimi-code/k3',
      '--thinking',
      '-p', 'q',
    ])
    expect(buildCliArgv(SHIPPED_ROUTES['kimi-cli'], {
      model: 'kimi-code/k3',
      effort: 'off',
      prompt: 'q',
    })).toContain('--no-thinking')
    expect(buildCliArgv(SHIPPED_ROUTES['codex-cli'], {
      model: 'gpt-5.4',
      effort: 'xhigh',
      prompt: 'q',
    })).toEqual([
      'codex', 'exec', '--json',
      '-m', 'gpt-5.4',
      '-c', 'model_reasoning_effort=xhigh',
      'q',
    ])
  })

  it('rejects an effort the route does not advertise', () => {
    expect(() => buildCliArgv(SHIPPED_ROUTES['kimi-cli'], {
      model: 'kimi-code/k3',
      effort: 'xhigh',
      prompt: 'q',
    })).toThrow(LlmError)
    try {
      buildCliArgv(SHIPPED_ROUTES['kimi-cli'], { model: 'kimi-code/k3', effort: 'xhigh', prompt: 'q' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    }
  })

  it('serializes system plus messages', () => {
    expect(serializePrompt({
      system: 'be brief',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).toBe('be brief\n\nuser\nhi')
  })
})

describe('CliLlmAdapter', () => {
  it('emits block-start, text-delta, block-end, usage, finish and captures argv', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const adapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const chunks = await collect(adapter.stream(options({
      model: 'grok-4.5',
      reasoningEffort: ReasoningEffortId('high'),
    })))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const spec = spawn.mock.calls[0]![0]
    expect(spec.argv).toEqual(buildCliArgv(SHIPPED_ROUTES['grok-cli'], {
      model: 'grok-4.5',
      effort: 'high',
      prompt: serializePrompt(options()),
    }))
    expect(spec.cwd).toBe('/tmp/ws')
  })

  it('injects a resolved credential into spawn env', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const adapter = new CliLlmAdapter({
      routes: () => resolveRoutes({ 'grok-cli': { apiKeyEnv: 'XAI_API_KEY' } }),
      spawn,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
      resolveEnv: async route => ({ ...route.env, XAI_API_KEY: 'from-seam' }),
    })
    await collect(adapter.stream(options()))
    expect(spawn.mock.calls[0]![0].env).toEqual({ XAI_API_KEY: 'from-seam' })
  })

  it('throws UNSUPPORTED_OPTION when tools are present without allowDelegatedTools', async () => {
    const routes = resolveRoutes({
      'grok-cli': { allowDelegatedTools: false },
    })
    const adapter = new CliLlmAdapter({
      routes: () => routes,
      spawn: () => fakeChild(),
      cwd: () => process.cwd(),
      disposeGraceMs: () => 3000,
    })
    await expect(collect(adapter.stream(options({
      tools: [{ name: 'bash', description: 'run', parameters: {} }],
    })))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  })

  it('honors abort by terminating the process tree', async () => {
    const controller = new AbortController()
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const child = fakeChild({
      done: new Promise((resolve) => { resolveDone = resolve }),
    })
    const adapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => child,
      cwd: () => process.cwd(),
      disposeGraceMs: () => 3000,
    })
    const iterating = collect(adapter.stream(options({ signal: controller.signal })))
    controller.abort()
    resolveDone({ exitCode: 0, signal: null })
    await expect(iterating).rejects.toMatchObject({ code: 'ABORTED' })
    // oxlint-disable-next-line typescript/unbound-method -- terminate is a vi.fn on the fake handle
    expect(child.terminate).toHaveBeenCalled()
  })

  it('advertises conservative context and per-route efforts', async () => {
    const adapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => fakeChild(),
      cwd: () => process.cwd(),
      disposeGraceMs: () => 3000,
    })
    expect(adapter.providerInfo('grok-cli')).toEqual({
      id: 'grok-cli',
      name: 'Grok Build CLI (delegated)',
      kind: 'delegated',
    })
    const resolved = await adapter.resolveModel('grok-cli', 'grok-4.6')
    expect(resolved.context).toEqual({ contextWindow: 128_000 })
    expect(resolved.defaultMaxTokens).toBe(8_192)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ])
    expect(await adapter.listModels('grok-cli')).toEqual([
      { provider: 'grok-cli', id: 'grok-4.6', name: 'Grok 4.6' },
      { provider: 'grok-cli', id: 'grok-4.5', name: 'Grok 4.5' },
    ])
    const kimi = await adapter.resolveModel('kimi-cli', 'kimi-code/k3')
    expect(kimi.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high'])
    expect(await adapter.listModels('kimi-cli')).toEqual([
      { provider: 'kimi-cli', id: 'kimi-code/k3-256k', name: 'K3-256k' },
      { provider: 'kimi-cli', id: 'kimi-code/k3', name: 'K3' },
      { provider: 'kimi-cli', id: 'kimi-code/kimi-for-coding', name: 'K2.7 Coding' },
      { provider: 'kimi-cli', id: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Coding Highspeed' },
    ])
    const nameless = new CliLlmAdapter({
      routes: () => resolveRoutes({ 'grok-cli': { models: [{ id: 'bare' }] } }),
      spawn: () => fakeChild(),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    expect(await nameless.listModels('grok-cli')).toEqual([
      { provider: 'grok-cli', id: 'bare', name: 'bare' },
    ])
    expect((await nameless.resolveModel('grok-cli', 'unlisted')).name).toBe('unlisted')
    expect(adapter.providerInfo('missing')).toEqual({ id: 'missing', name: 'missing', kind: 'delegated' })
    expect(() => { void adapter.listModels('missing') }).toThrow(LlmError)
  })

  it('rejects temperature, stop, missing route, parse failure, and CLI_EXIT', async () => {
    const adapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => fakeChild(),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(adapter.stream(options({ temperature: 0.2 }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(collect(adapter.stream(options({ stop: ['END'] }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(collect(adapter.stream(options({ provider: 'missing' }))))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })

    const exitAdapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => fakeChild({ outcome: { exitCode: 2, signal: null } }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(exitAdapter.stream(options()))).rejects.toMatchObject({ code: 'CLI_EXIT' })

    const parseAdapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => fakeChild({ stdout: 'not-json' }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(parseAdapter.stream(options()))).rejects.toThrow('not JSON')
  })

  it('omits usage, tears down a pid-less child, and parses stream-json', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ result: 'plain' }), pid: 0 })
    const adapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => child,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const chunks = await collect(adapter.stream(options()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'plain' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'plain' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // oxlint-disable-next-line typescript/unbound-method -- terminate is a vi.fn on the fake handle
    expect(child.terminate).not.toHaveBeenCalled()

    const streamAdapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => fakeChild({
        stdout: '{"type":"assistant","text":"one"}\n{"result":"two","usage":{"input_tokens":1,"output_tokens":2,"reasoning_tokens":3}}\n',
      }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const streamed = await collect(streamAdapter.stream(options({ provider: 'kimi-cli', model: 'kimi-code/k3' })))
    expect(streamed).toEqual(expect.arrayContaining([
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 } },
    ]))

    const empty = fakeChild({
      stdout: '',
      collected: {},
      done: Promise.reject(new Error('already gone')),
    })
    void empty.done.catch(() => undefined)
    empty.waitForExit = vi.fn(async () => {
      throw new Error('already gone')
    })
    const emptyAdapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => empty,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(emptyAdapter.stream(options()))).rejects.toThrow('already gone')

    const noStdout = fakeChild({ collected: {} })
    const noStdoutAdapter = new CliLlmAdapter({
      routes: () => resolveRoutes(undefined),
      spawn: () => noStdout,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(noStdoutAdapter.stream(options()))).rejects.toThrow('no output')
  })
})

describe('parse, serialize, and resolveRoutes', () => {
  it('shares error predicates and extracts answers from common fields', () => {
    expect(isCliErrorPayload({ type: 'error', message: 'auth' })).toBe(true)
    expect(isCliErrorPayload({ subtype: 'error' })).toBe(true)
    expect(isCliErrorPayload({ is_error: true })).toBe(true)
    expect(isCliErrorPayload({ error: true })).toBe(true)
    expect(answerFromObject({ type: 'error', message: 'auth' })).toBeUndefined()
    expect(answerFromObject({ text: 'from text' })).toBe('from text')
    expect(answerFromObject({ message: 'from message' })).toBe('from message')
    expect(answerFromObject({ content: [{ text: 'a' }, { text: 'b' }] })).toBe('ab')
    expect(answerFromObject({ output: ['x', 'y'] })).toBe('xy')
    expect(answerFromObject({ content: [{}, 1, null] })).toBeUndefined()
    expect(answerFromObject(null)).toBeUndefined()
    expect(answerFromObject({})).toBeUndefined()
    expect(usageFromObject({ usage: { input_tokens: 1, output_tokens: 2 } }))
      .toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(usageFromObject({ usage: { prompt_tokens: 1 } })).toBeUndefined()
    expect(usageFromObject('x')).toBeUndefined()
  })

  it('parses json and stream-json, including failures', () => {
    const grok = SHIPPED_ROUTES['grok-cli']
    const kimi = SHIPPED_ROUTES['kimi-cli']
    expect(parseCliOutput(grok, '{"result":"ok","usage":{"inputTokens":1,"outputTokens":2}}'))
      .toEqual({ text: 'ok', usage: { inputTokens: 1, outputTokens: 2 } })
    expect(() => parseCliOutput(grok, '')).toThrow('no output')
    expect(() => parseCliOutput(grok, 'nope')).toThrow('not JSON')
    expect(() => parseCliOutput(grok, '{"type":"error","message":"auth"}')).toThrow('no answer')
    expect(parseCliOutput(kimi, '{"type":"assistant","text":"one"}\nnot-json\n{"result":"two"}'))
      .toEqual({ text: 'two' })
    expect(parseCliOutput(kimi, '{"result":"ok"}')).toEqual({ text: 'ok' })
    expect(parseCliOutput(kimi, '{"foo":1}\n\n{"result":"ok"}')).toEqual({ text: 'ok' })
    expect(() => parseCliOutput(kimi, 'not-json\nstill-not')).toThrow('no answer')
    expect(parseCliOutput(kimi, '"commentary"\n{"result":"ok"}')).toEqual({ text: 'ok' })
  })

  it('ignores kimi meta stream events so the resume hint cannot win over the reply', () => {
    const kimi = SHIPPED_ROUTES['kimi-cli']
    // kimi >= 0.36 stream-json shape: version meta, the assistant reply, then
    // a session.resume_hint meta whose own `content` used to clobber the text.
    const stream = [
      '{"role":"meta","type":"system.version","version":"0.36.1"}',
      '{"role":"assistant","content":"Hi! What can I do for you?"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"kimi -r s1","content":"To resume this session: kimi -r s1"}',
    ].join('\n')
    expect(parseCliOutput(kimi, stream)).toEqual({ text: 'Hi! What can I do for you?' })
    // A meta-only stream is no answer at all.
    expect(() => parseCliOutput(kimi, '{"role":"meta","type":"system.version","version":"0.36.1"}'))
      .toThrow('no answer')
  })

  it('serializes system, roles, and non-text blocks', () => {
    expect(serializePrompt({
      system: 'sys',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        createAssistantMessage({
          content: [
            { type: 'text', text: 'a' },
            { type: 'reasoning', text: 'think' },
            { type: 'image', attachment: { id: 'img' } as never },
            { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
            { type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'out' }] },
            { type: 'unknown' } as unknown as ContentBlock,
          ],
          source: { provider: 'test', model: 'test' },
        }),
        {
          role: 'user',
          content: [{ type: 'text', text: 'tool out' }],
          source: { kind: 'tool', callId: 'c1' as never },
        } as never,
        { role: 'system' as never, content: [{ type: 'text', text: 'fallback' }] } as never,
      ],
    })).toContain('sys')
    expect(serializePrompt({
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).toBe('user\nhi')
  })

  it('starts custom extra routes conservative and rejects empty ids', () => {
    const routes = resolveRoutes({
      extra: { displayName: 'Extra', binary: 'extra' },
    })
    const extra = routes.get('extra')
    expect(extra).toMatchObject({
      extraArgs: [],
      allowDelegatedTools: false,
      displayName: 'Extra',
      binary: 'extra',
    })
    expect(resolveRoutes({ 'codex-cli': { displayName: 'Codex' } }).get('codex-cli')?.promptArg)
      .toBeUndefined()
    expect(resolveRoutes({ 'grok-cli': { models: [{ id: 'only-id' }] } }).get('grok-cli')?.models)
      .toEqual([{ id: 'only-id' }])
    expect(resolveRoutes({ 'grok-cli': { displayName: 'Grok' } }).get('grok-cli')?.apiKeyEnv)
      .toBe('XAI_API_KEY')
    expect(resolveRoutes({ 'grok-cli': { enabled: false } }).get('grok-cli')?.enabled).toBe(false)
    expect(resolveRoutes({}).get('grok-cli')?.enabled).toBe(true)
    expect(resolveRoutes({ extra: { displayName: 'E', binary: 'e', apiKeyEnv: 'CUSTOM_KEY' } })
      .get('extra')?.apiKeyEnv).toBe('CUSTOM_KEY')
    expect(() => resolveRoutes({ extra: { displayName: 'X' } })).toThrow('displayName and binary')
    expect(() => resolveRoutes({ 'grok-cli': { efforts: [''] } })).toThrow('effort ids')
    expect(() => resolveRoutes({ 'grok-cli': { models: [{ id: '' }] } })).toThrow('model ids')
  })

  it('preserves shipped route defaults when settings override only enabled', () => {
    // The settings layer coerces a partial route (just `enabled`) through the
    // Config schema before resolveRoutes merges it. Array/dict fields must stay
    // absent so the shipped base models/efforts/env survive the merge.
    const section = Config({ routes: { 'grok-cli': { enabled: true } } })
    const routes = resolveRoutes(section.routes)
    const grok = routes.get('grok-cli')
    expect(grok?.enabled).toBe(true)
    expect(grok?.models.map(model => model.id)).toEqual(['grok-4.6', 'grok-4.5'])
    expect(grok?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('keeps an explicit empty models list as a clearing override', () => {
    const routes = resolveRoutes(Config({ routes: { 'grok-cli': { enabled: true, models: [] } } }).routes)
    expect(routes.get('grok-cli')?.models).toEqual([])
  })

  it('rejects empty model ids, missing promptArg, missing effortArg, and unknown effortStyle', () => {
    expect(() => buildCliArgv(SHIPPED_ROUTES['grok-cli'], { model: '', prompt: 'q' }))
      .toThrow(LlmError)
    const grokFlag = { ...SHIPPED_ROUTES['grok-cli'], promptStyle: 'flag' as const }
    delete grokFlag.promptArg
    expect(() => buildCliArgv(grokFlag, { model: 'grok-4', prompt: 'q' })).toThrow('promptArg')
    const grokEffort = { ...SHIPPED_ROUTES['grok-cli'], effortStyle: 'flag' as const }
    delete grokEffort.effortArg
    expect(() => effortFlags(grokEffort, 'high')).toThrow('effortArg')
    const codexEffort = { ...SHIPPED_ROUTES['codex-cli'] }
    delete codexEffort.effortArg
    expect(effortFlags(codexEffort, 'high')).toEqual(['-c', 'model_reasoning_effort=high'])
    expect(() => effortFlags({
      ...SHIPPED_ROUTES['grok-cli'],
      effortStyle: 'nope' as never,
    }, 'high')).toThrow()
  })
})

describe('plugin registration', () => {
  it('registers no adapter when every shipped route is disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(plugin, {
      routes: {
        'claude-cli': { enabled: false },
        'codex-cli': { enabled: false },
        'grok-cli': { enabled: false },
        'kimi-cli': { enabled: false },
      },
    })
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(
      expect.arrayContaining(['claude-cli', 'codex-cli', 'grok-cli', 'kimi-cli']),
    )
    await ctx.fiber.dispose()
  })

  it('withdraws a disabled route from the live registry', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    expect(ctx.llm.listProviders().some(provider => provider.id === 'grok-cli')).toBe(true)
    await ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: { 'grok-cli': { enabled: false } },
    })
    expect(ctx.llm.listProviders().some(provider => provider.id === 'grok-cli')).toBe(false)
    expect(ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'grok-cli')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('registers the four shipped delegated routes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(plugin, {})
    const ids = ctx.llm.listProviders().map(provider => provider.id)
    expect(ids).toEqual(expect.arrayContaining(['claude-cli', 'codex-cli', 'grok-cli', 'kimi-cli']))
    expect(ctx.llm.listProviders().every(provider => provider.kind === 'delegated')).toBe(true)
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'grok-cli')).toMatchObject({
      kind: 'delegated',
      settingsNs: 'llm-cli-bridge',
      binary: 'grok',
    })
    expect(typeof directory.find(entry => entry.provider === 'grok-cli')?.binaryFound).toBe('boolean')
    const resolved = await ctx.llm.resolveCallConfig({
      provider: 'grok-cli',
      model: 'grok-4',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(resolved.reasoningEffort).toBe('high')
    await expect(ctx.llm.resolveCallConfig({
      provider: 'grok-cli',
      model: 'grok-4',
      reasoningEffort: ReasoningEffortId('nope'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    await ctx.fiber.dispose()
  })

  it('rejects an invalid composition disposeGraceMs at load', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(plugin, { disposeGraceMs: 0 })).rejects.toThrow('disposeGraceMs')
    await ctx.fiber.dispose()
  })

  it('resolves spawn cwd from the session workspace and re-reads disposeGraceMs', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    ctx.provide('subprocess', { spawn })
    ctx.provide('sessions', {
      get: (id: SessionId) => id === SessionId('sess-1')
        ? { header: { cwd: '/ws/project' } }
        : { header: {} },
    })
    await ctx.plugin(plugin, {})
    await collect(ctx.llm.stream(options({ sessionId: SessionId('sess-1') })))
    expect(spawn.mock.calls[0]![0].cwd).toBe('/ws/project')
    expect(spawn.mock.calls[0]![0].graceMs).toBe(3_000)

    await ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: {
        'grok-cli': { ...SHIPPED_ROUTES['grok-cli'], displayName: 'Renamed Grok' },
      },
      disposeGraceMs: 4_500,
    })
    await collect(ctx.llm.stream(options({ sessionId: SessionId('sess-1') })))
    expect(spawn.mock.calls[1]![0].graceMs).toBe(4_500)
    expect(ctx.llm.listProviders().find(provider => provider.id === 'grok-cli')?.name)
      .toBe('Renamed Grok')

    const missingSession = await collect(ctx.llm.stream(options()))
    const missingLast = missingSession.at(-1)
    expect(missingLast?.type).toBe('finish')
    if (missingLast?.type === 'finish' && missingLast.reason.kind === 'error') {
      expect(missingLast.reason.failure.message).toContain('requires a session')
    }
    const noCwd = await collect(ctx.llm.stream(options({ sessionId: SessionId('ghost') })))
    const noCwdLast = noCwd.at(-1)
    expect(noCwdLast?.type).toBe('finish')
    if (noCwdLast?.type === 'finish' && noCwdLast.reason.kind === 'error') {
      expect(noCwdLast.reason.failure.message).toContain('no working directory')
    }
    await ctx.fiber.dispose()
  })

  it('uses the default disposeGraceMs when settings omit it', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('subprocess', { spawn })
    ctx.provide('sessions', {
      get: () => ({ header: { cwd: '/ws' } }),
    })
    plugin.apply(ctx, {})
    await collect(ctx.llm.stream(options({ sessionId: SessionId('s') })))
    expect(spawn.mock.calls[0]![0].graceMs).toBe(3_000)
    await ctx.fiber.dispose()
  })

  it('fails loud when subprocess or sessions is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(plugin, {})
    const noSessions = await collect(ctx.llm.stream(options({ sessionId: SessionId('s') })))
    const noSessionsLast = noSessions.at(-1)
    expect(noSessionsLast?.type).toBe('finish')
    if (noSessionsLast?.type === 'finish' && noSessionsLast.reason.kind === 'error') {
      expect(noSessionsLast.reason.failure.message).toContain('requires ctx.sessions')
    }
    ctx.provide('sessions', { get: () => ({ header: { cwd: '/ws' } }) })
    const noSubprocess = await collect(ctx.llm.stream(options({ sessionId: SessionId('s') })))
    const noSubprocessLast = noSubprocess.at(-1)
    expect(noSubprocessLast?.type).toBe('finish')
    if (noSubprocessLast?.type === 'finish' && noSubprocessLast.reason.kind === 'error') {
      expect(noSubprocessLast.reason.failure.message).toContain('requires ctx.subprocess')
    }
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape and empty invariant', async () => {
    expect(plugin.name).toBe('llm-cli-bridge')
    expect(plugin.inject).toEqual(['llm'])
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@shres-code/shres-code-llm-cli-bridge',
      expect.any(Function),
    )
  })
})

describe('resolveRouteEnv', () => {
  it('returns the route overlay when no credential is named', async () => {
    const ctx = new Context()
    const unnamed = { ...SHIPPED_ROUTES['grok-cli'] }
    delete unnamed.apiKeyEnv
    await expect(plugin.resolveRouteEnv(ctx, unnamed)).resolves.toEqual({})
    await expect(plugin.resolveRouteEnv(ctx, {
      ...SHIPPED_ROUTES['grok-cli'],
      apiKeyEnv: '',
      env: { FLAG: '1' },
    })).resolves.toEqual({ FLAG: '1' })
  })

  it('injects a credentials-seam secret and skips an empty named ref', async () => {
    const keyed = new Context()
    keyed.provide('credentials', {
      resolve: async () => ({ value: 'sk-live', source: 'file' }),
    })
    await expect(plugin.resolveRouteEnv(keyed, SHIPPED_ROUTES['grok-cli']))
      .resolves.toEqual({ XAI_API_KEY: 'sk-live' })

    const missing = new Context()
    missing.provide('credentials', {
      resolve: async () => undefined,
    })
    await expect(plugin.resolveRouteEnv(missing, SHIPPED_ROUTES['grok-cli']))
      .resolves.toEqual({})

    const blank = new Context()
    blank.provide('credentials', {
      resolve: async () => ({ value: '', source: 'file' }),
    })
    await expect(plugin.resolveRouteEnv(blank, SHIPPED_ROUTES['grok-cli']))
      .resolves.toEqual({})
  })

  it('reads the launch environment when the credentials seam is absent', async () => {
    const previous = process.env.XAI_API_KEY
    process.env.XAI_API_KEY = 'from-launch'
    try {
      const ctx = new Context()
      await expect(plugin.resolveRouteEnv(ctx, SHIPPED_ROUTES['grok-cli']))
        .resolves.toEqual({ XAI_API_KEY: 'from-launch' })
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previous
    }
  })
})
