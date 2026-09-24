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
import { Config, CUSTOM_ROUTE_TEMPLATE, resolveRoutes } from '../src/config.ts'
import type { CliBridgeRoute } from '../src/config.ts'
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

// Flag dialect: model and effort are plain flags, the prompt sits behind -p,
// stdout is one JSON object, and harness tools are delegated to the CLI.
const FLAG_ROUTE: CliBridgeRoute = {
  displayName: 'Flag CLI (delegated)',
  binary: 'flag-cli',
  modelArg: '--model',
  effortArg: '--effort',
  effortStyle: 'flag',
  efforts: ['low', 'medium', 'high', 'xhigh'],
  extraArgs: [],
  promptStyle: 'flag',
  promptArg: '-p',
  parseMode: 'json',
  env: {},
  apiKeyEnv: 'TEST_API_KEY',
  allowDelegatedTools: true,
  contextWindow: 128_000,
  defaultMaxTokens: 8_192,
  models: [
    { id: 'flag-4', name: 'Flag 4' },
    { id: 'flag-3', name: 'Flag 3' },
  ],
  enabled: true,
}

// thinking-bool dialect: effort becomes --thinking / --no-thinking and stdout
// is a stream-json transcript.
const THINKING_ROUTE: CliBridgeRoute = {
  displayName: 'Thinking CLI (delegated)',
  binary: 'thinking-cli',
  modelArg: '--model',
  effortStyle: 'thinking-bool',
  efforts: ['off', 'high'],
  extraArgs: ['--output-format', 'stream-json'],
  promptStyle: 'flag',
  promptArg: '-p',
  parseMode: 'stream-json',
  env: {},
  allowDelegatedTools: false,
  contextWindow: 128_000,
  defaultMaxTokens: 8_192,
  models: [{ id: 'think-1', name: 'Think 1' }],
  enabled: true,
}

// codex-config dialect: effort rides -c <key>=<id> and the prompt is the
// trailing positional.
const CONFIG_ROUTE: CliBridgeRoute = {
  displayName: 'Config CLI (delegated)',
  binary: 'config-cli',
  modelArg: '-m',
  effortArg: 'model_reasoning_effort',
  effortStyle: 'codex-config',
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  extraArgs: ['exec', '--json'],
  promptStyle: 'trailing',
  parseMode: 'stream-json',
  env: {},
  allowDelegatedTools: false,
  contextWindow: 128_000,
  defaultMaxTokens: 8_192,
  models: [{ id: 'cfg-5' }],
  enabled: true,
}

// Trailing-prompt print-flag route: no effort flag at all, so no efforts are
// advertised and any effort request is rejected.
const TRAILING_ROUTE: CliBridgeRoute = {
  displayName: 'Trailing CLI (delegated)',
  binary: 'trailing-cli',
  modelArg: '--model',
  effortStyle: 'flag',
  efforts: [],
  extraArgs: ['-p', '--output-format', 'json', '--force'],
  promptStyle: 'trailing',
  parseMode: 'json',
  env: {},
  allowDelegatedTools: false,
  contextWindow: 128_000,
  defaultMaxTokens: 8_192,
  models: [{ id: 'tr-1', name: 'TR 1' }],
  enabled: true,
}

const ROUTES: ReadonlyMap<string, CliBridgeRoute> = new Map([
  ['flag-cli', FLAG_ROUTE],
  ['thinking-cli', THINKING_ROUTE],
  ['config-cli', CONFIG_ROUTE],
  ['trailing-cli', TRAILING_ROUTE],
])

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
    provider: 'flag-cli',
    model: 'flag-4',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
    ...overrides,
  }
}

describe('argv and serialize', () => {
  it('forwards selected model and effort onto flag-route argv', () => {
    expect(buildCliArgv(FLAG_ROUTE, {
      model: 'flag-4',
      effort: 'high',
      prompt: 'do it',
    })).toEqual([
      'flag-cli',
      '--model', 'flag-4',
      '--effort', 'high',
      '-p', 'do it',
    ])
  })

  it('maps thinking-bool flags and the codex -c config effort', () => {
    expect(buildCliArgv(THINKING_ROUTE, {
      model: 'think-1',
      effort: 'high',
      prompt: 'q',
    })).toEqual([
      'thinking-cli', '--output-format', 'stream-json',
      '--model', 'think-1',
      '--thinking',
      '-p', 'q',
    ])
    expect(buildCliArgv(THINKING_ROUTE, {
      model: 'think-1',
      effort: 'off',
      prompt: 'q',
    })).toContain('--no-thinking')
    expect(buildCliArgv(CONFIG_ROUTE, {
      model: 'cfg-5',
      effort: 'xhigh',
      prompt: 'q',
    })).toEqual([
      'config-cli', 'exec', '--json',
      '-m', 'cfg-5',
      '-c', 'model_reasoning_effort=xhigh',
      'q',
    ])
  })

  it('builds trailing-prompt argv and rejects effort on an effortless route', () => {
    // -p here is the CLI's print flag and the prompt rides as the trailing
    // positional; the route advertises no efforts, so none is forwarded.
    expect(buildCliArgv(TRAILING_ROUTE, {
      model: 'tr-1',
      prompt: 'do it',
    })).toEqual([
      'trailing-cli',
      '-p',
      '--output-format', 'json',
      '--force',
      '--model', 'tr-1',
      'do it',
    ])
    expect(() => buildCliArgv(TRAILING_ROUTE, {
      model: 'tr-1',
      effort: 'high',
      prompt: 'do it',
    })).toThrow(LlmError)
  })

  it('rejects an effort the route does not advertise', () => {
    expect(() => buildCliArgv(THINKING_ROUTE, {
      model: 'think-1',
      effort: 'xhigh',
      prompt: 'q',
    })).toThrow(LlmError)
    try {
      buildCliArgv(THINKING_ROUTE, { model: 'think-1', effort: 'xhigh', prompt: 'q' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    }
  })

  it('rejects an empty model id and a flag promptStyle without promptArg', () => {
    expect(() => buildCliArgv(FLAG_ROUTE, { model: '', prompt: 'q' }))
      .toThrow(LlmError)
    const noPromptArg = { ...FLAG_ROUTE, promptStyle: 'flag' as const }
    delete noPromptArg.promptArg
    expect(() => buildCliArgv(noPromptArg, { model: 'flag-4', prompt: 'q' })).toThrow('promptArg')
  })

  it('rejects a missing flag effortArg, defaults the codex key, and rejects an unknown effortStyle', () => {
    const noEffortArg = { ...FLAG_ROUTE, effortStyle: 'flag' as const }
    delete noEffortArg.effortArg
    expect(() => effortFlags(noEffortArg, 'high')).toThrow('effortArg')
    const defaultKey = { ...CONFIG_ROUTE }
    delete defaultKey.effortArg
    expect(effortFlags(defaultKey, 'high')).toEqual(['-c', 'model_reasoning_effort=high'])
    expect(() => effortFlags({
      ...FLAG_ROUTE,
      effortStyle: 'nope' as never,
    }, 'high')).toThrow()
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
      routes: () => ROUTES,
      spawn,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const chunks = await collect(adapter.stream(options({
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
    expect(spec.argv).toEqual(buildCliArgv(FLAG_ROUTE, {
      model: 'flag-4',
      effort: 'high',
      prompt: serializePrompt(options()),
    }))
    expect(spec.cwd).toBe('/tmp/ws')

    await collect(adapter.stream(options({ provider: 'config-cli', model: 'cfg-5' })))
    expect(spawn.mock.calls[1]![0].argv).toEqual(buildCliArgv(CONFIG_ROUTE, {
      model: 'cfg-5',
      prompt: serializePrompt(options({ provider: 'config-cli', model: 'cfg-5' })),
    }))
  })

  it('injects a resolved credential into spawn env', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const routes = resolveRoutes({
      keyed: {
        displayName: 'Keyed CLI',
        binary: 'keyed-cli',
        apiKeyEnv: 'TEST_API_KEY',
        env: { ROUTE_FLAG: '1' },
      },
    })
    const adapter = new CliLlmAdapter({
      routes: () => routes,
      spawn,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
      resolveEnv: async route => ({ ...route.env, TEST_API_KEY: 'from-seam' }),
    })
    await collect(adapter.stream(options({ provider: 'keyed', model: 'm' })))
    expect(spawn.mock.calls[0]![0].env).toEqual({ ROUTE_FLAG: '1', TEST_API_KEY: 'from-seam' })

    // Without resolveEnv the route env passes to spawn verbatim.
    const plain = new CliLlmAdapter({
      routes: () => routes,
      spawn,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await collect(plain.stream(options({ provider: 'keyed', model: 'm' })))
    expect(spawn.mock.calls[1]![0].env).toEqual({ ROUTE_FLAG: '1' })
  })

  it('gates tools behind allowDelegatedTools', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(adapter.stream(options({
      provider: 'thinking-cli',
      model: 'think-1',
      tools: [{ name: 'bash', description: 'run', parameters: {} }],
    })))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })

    const chunks = await collect(adapter.stream(options({
      tools: [{ name: 'bash', description: 'run', parameters: {} }],
    })))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('honors abort by terminating the process tree', async () => {
    const controller = new AbortController()
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const child = fakeChild({
      done: new Promise((resolve) => { resolveDone = resolve }),
    })
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
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

  it('streams stream-json chunks while the CLI is still running', async () => {
    const transcript = [
      '{"type":"thinking","subtype":"delta","text":"working"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success","result":"hello","usage":{"inputTokens":10,"outputTokens":2}}',
      '',
    ].join('\n')
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const child = fakeChild({
      stdout: transcript,
      done: new Promise((resolve) => { resolveDone = resolve }),
    })
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => child,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const iterator = adapter.stream(options({ provider: 'thinking-cli', model: 'think-1' }))[Symbol.asyncIterator]()
    const early: StreamChunk[] = []
    // Every event chunk arrives before the process exits; the closing
    // block-end, usage, and finish wait for settlement.
    for (let i = 0; i < 5; i += 1) {
      const step = await iterator.next()
      expect(step.done).toBe(false)
      if (step.done === true) throw new Error('stream ended early')
      early.push(step.value)
    }
    expect(early).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'working' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'working' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hello' },
    ])
    resolveDone({ exitCode: 0, signal: null })
    const rest: StreamChunk[] = []
    for (;;) {
      const step = await iterator.next()
      if (step.done === true) break
      rest.push(step.value)
    }
    expect(rest).toEqual([
      { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('falls back to whole-transcript parsing for unrecognized stream-json shapes', async () => {
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => fakeChild({
        stdout: '{"type":"item.completed","item":{"text":"codex style"}}\n{"text":"codex style"}\n',
      }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const chunks = await collect(adapter.stream(options({ provider: 'config-cli', model: 'cfg-5' })))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'codex style' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'codex style' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps abort, exit code, and a missing stdout reader on stream-json routes', async () => {
    const controller = new AbortController()
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const pending = fakeChild({ done: new Promise((resolve) => { resolveDone = resolve }) })
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => pending,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const iterating = collect(adapter.stream(options({
      provider: 'thinking-cli', model: 'think-1', signal: controller.signal,
    })))
    controller.abort()
    resolveDone({ exitCode: 0, signal: null })
    await expect(iterating).rejects.toMatchObject({ code: 'ABORTED' })

    const exitAdapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => fakeChild({ outcome: { exitCode: 3, signal: null } }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(exitAdapter.stream(options({ provider: 'thinking-cli', model: 'think-1' }))))
      .rejects.toMatchObject({ code: 'CLI_EXIT' })

    const noReader = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => fakeChild({ collected: {} }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(noReader.stream(options({ provider: 'thinking-cli', model: 'think-1' }))))
      .rejects.toThrow('no output')
  })

  it('propagates a settled rejection on a stream-json route', async () => {
    const gone = fakeChild({
      stdout: '',
      collected: {},
      done: Promise.reject(new Error('already gone')),
    })
    void gone.done.catch(() => undefined)
    gone.waitForExit = vi.fn(async () => {
      throw new Error('already gone')
    })
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => gone,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(adapter.stream(options({ provider: 'thinking-cli', model: 'think-1' }))))
      .rejects.toThrow('already gone')
  })

  it('drains bytes that arrive exactly at settlement and forwards fallback usage', async () => {
    const transcript = '{"text":"late answer","usage":{"input_tokens":7,"output_tokens":8}}\n'
    let calls = 0
    const draining = fakeChild({
      collected: {
        stdout: {
          readFrom: (from: number) => {
            calls += 1
            // Nothing during the poll loop; the transcript lands on the drain.
            const text = calls === 1 ? '' : transcript.slice(from)
            return { text, nextOffset: from + text.length, lossy: false }
          },
        },
      },
    })
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => draining,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const chunks = await collect(adapter.stream(options({ provider: 'thinking-cli', model: 'think-1' })))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'late answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'late answer' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 8 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('advertises conservative context and per-route efforts', async () => {
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => fakeChild(),
      cwd: () => process.cwd(),
      disposeGraceMs: () => 3000,
    })
    expect(adapter.providerInfo('flag-cli')).toEqual({
      id: 'flag-cli',
      name: 'Flag CLI (delegated)',
      kind: 'delegated',
    })
    const resolved = await adapter.resolveModel('flag-cli', 'flag-4')
    expect(resolved.context).toEqual({ contextWindow: 128_000 })
    expect(resolved.defaultMaxTokens).toBe(8_192)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ])
    expect(await adapter.listModels('flag-cli')).toEqual([
      { provider: 'flag-cli', id: 'flag-4', name: 'Flag 4' },
      { provider: 'flag-cli', id: 'flag-3', name: 'Flag 3' },
    ])
    const thinking = await adapter.resolveModel('thinking-cli', 'think-1')
    expect(thinking.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high'])
    const effortless = await adapter.resolveModel('trailing-cli', 'tr-1')
    expect(effortless.reasoning).toBeUndefined()
    const nameless = new CliLlmAdapter({
      routes: () => resolveRoutes({ bare: { displayName: 'Bare', binary: 'bare-cli', models: [{ id: 'bare' }] } }),
      spawn: () => fakeChild(),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    expect(await nameless.listModels('bare')).toEqual([
      { provider: 'bare', id: 'bare', name: 'bare' },
    ])
    expect((await nameless.resolveModel('bare', 'unlisted')).name).toBe('unlisted')
    expect(adapter.providerInfo('missing')).toEqual({ id: 'missing', name: 'missing', kind: 'delegated' })
    expect(() => { void adapter.listModels('missing') }).toThrow(LlmError)
  })

  it('declares the temperature refusal its stream enforces, for listed and unlisted models', async () => {
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => fakeChild(),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    expect((await adapter.resolveModel('flag-cli', 'flag-4')).acceptsTemperature).toBe(false)
    expect((await adapter.resolveModel('flag-cli', 'unlisted')).acceptsTemperature).toBe(false)
    await expect(collect(adapter.stream(options({ temperature: 0.2 }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  })

  it('rejects temperature, stop, missing route, CLI_EXIT, and parse failure', async () => {
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
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
      routes: () => ROUTES,
      spawn: () => fakeChild({ outcome: { exitCode: 2, signal: null } }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(exitAdapter.stream(options()))).rejects.toMatchObject({ code: 'CLI_EXIT' })

    const parseAdapter = new CliLlmAdapter({
      routes: () => ROUTES,
      spawn: () => fakeChild({ stdout: 'not-json' }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(parseAdapter.stream(options()))).rejects.toThrow('not JSON')
  })

  it('omits usage, tears down a pid-less child, and parses stream-json', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ result: 'plain' }), pid: 0 })
    const adapter = new CliLlmAdapter({
      routes: () => ROUTES,
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
      routes: () => ROUTES,
      spawn: () => fakeChild({
        stdout: '{"type":"assistant","text":"one"}\n{"result":"two","usage":{"input_tokens":1,"output_tokens":2,"reasoning_tokens":3}}\n',
      }),
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    const streamed = await collect(streamAdapter.stream(options({ provider: 'thinking-cli', model: 'think-1' })))
    // The assistant event streams live; the result object supplies usage, and
    // its text is only a fallback when no assistant event streamed.
    expect(streamed).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'one' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'one' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

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
      routes: () => ROUTES,
      spawn: () => empty,
      cwd: () => '/tmp/ws',
      disposeGraceMs: () => 3000,
    })
    await expect(collect(emptyAdapter.stream(options()))).rejects.toThrow('already gone')

    const noStdout = fakeChild({ collected: {} })
    const noStdoutAdapter = new CliLlmAdapter({
      routes: () => ROUTES,
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

  it('parses json and stream-json, including failure payloads', () => {
    expect(parseCliOutput(FLAG_ROUTE, '{"result":"ok","usage":{"inputTokens":1,"outputTokens":2}}'))
      .toEqual({ text: 'ok', usage: { inputTokens: 1, outputTokens: 2 } })
    expect(() => parseCliOutput(FLAG_ROUTE, '')).toThrow('no output')
    expect(() => parseCliOutput(FLAG_ROUTE, 'nope')).toThrow('not JSON')
    expect(() => parseCliOutput(FLAG_ROUTE, '{"type":"error","message":"auth"}')).toThrow('no answer')
    // A print-flag CLI emits exactly this result object.
    expect(parseCliOutput(TRAILING_ROUTE, JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 12, result: 'ok', session_id: 's', request_id: 'r',
    }))).toEqual({ text: 'ok' })
    expect(() => parseCliOutput(TRAILING_ROUTE, JSON.stringify({
      type: 'result', subtype: 'error', is_error: true, duration_ms: 12, result: '', session_id: 's',
    }))).toThrow('no answer')
    expect(parseCliOutput(THINKING_ROUTE, '{"type":"assistant","text":"one"}\nnot-json\n{"result":"two"}'))
      .toEqual({ text: 'two' })
    expect(parseCliOutput(THINKING_ROUTE, '{"result":"ok"}')).toEqual({ text: 'ok' })
    expect(parseCliOutput(THINKING_ROUTE, '{"foo":1}\n\n{"result":"ok"}')).toEqual({ text: 'ok' })
    expect(() => parseCliOutput(THINKING_ROUTE, 'not-json\nstill-not')).toThrow('no answer')
    expect(parseCliOutput(THINKING_ROUTE, '"commentary"\n{"result":"ok"}')).toEqual({ text: 'ok' })
  })

  it('ignores role meta stream events so a resume hint cannot win over the reply', () => {
    // kimi >= 0.36 stream-json shape: version meta, the assistant reply, then
    // a session.resume_hint meta whose own `content` would clobber the text.
    const stream = [
      '{"role":"meta","type":"system.version","version":"0.36.1"}',
      '{"role":"assistant","content":"Hi! What can I do for you?"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"kimi -r s1","content":"To resume this session: kimi -r s1"}',
    ].join('\n')
    expect(parseCliOutput(THINKING_ROUTE, stream)).toEqual({ text: 'Hi! What can I do for you?' })
    // A meta-only stream is no answer at all.
    expect(() => parseCliOutput(THINKING_ROUTE, '{"role":"meta","type":"system.version","version":"0.36.1"}'))
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

  it('starts custom routes conservative and rejects missing or empty ids', () => {
    const routes = resolveRoutes({
      extra: { displayName: 'Extra (custom)', binary: 'extra-cli' },
    })
    expect(routes.get('extra')).toEqual({
      ...CUSTOM_ROUTE_TEMPLATE,
      displayName: 'Extra (custom)',
      binary: 'extra-cli',
      enabled: true,
    })
    expect(() => resolveRoutes({ extra: { displayName: 'X' } })).toThrow('displayName and binary')
    expect(() => resolveRoutes({ extra: { binary: 'x' } })).toThrow('displayName and binary')
    expect(() => resolveRoutes({ extra: { displayName: 'E', binary: 'e', efforts: [''] } }))
      .toThrow('effort ids')
    expect(() => resolveRoutes({ extra: { displayName: 'E', binary: 'e', models: [{ id: '' }] } }))
      .toThrow('model ids')
  })

  it('resolves a disabled bare toggle as dormant instead of rejecting it', () => {
    // Settings written as bare switch-offs (`{ enabled: false }`, the shape the
    // Models page wrote for shipped routes) are not declarations: they must not
    // break the declared routes sharing the section.
    const routes = resolveRoutes({
      'off-cli': { enabled: false },
      'on-cli': { displayName: 'On CLI (delegated)', binary: 'on-cli' },
    })
    expect(routes.get('off-cli')).toMatchObject({ enabled: false, binary: '' })
    expect(routes.get('on-cli')).toMatchObject({ enabled: true, binary: 'on-cli' })
    expect(() => resolveRoutes({ 'on-cli': { enabled: true, binary: 'on-cli' } }))
      .toThrow('displayName and binary')
  })

  it('merges overlay fields onto the conservative template', () => {
    const routes = resolveRoutes({
      extra: {
        displayName: 'Extra (custom)',
        binary: 'extra-cli',
        modelArg: '-m',
        effortArg: 'model_reasoning_effort',
        effortStyle: 'codex-config',
        efforts: ['low', 'high'],
        extraArgs: ['exec', '--json'],
        promptStyle: 'trailing',
        parseMode: 'stream-json',
        env: { FLAG: '1' },
        apiKeyEnv: 'CUSTOM_KEY',
        allowDelegatedTools: true,
        contextWindow: 200_000,
        defaultMaxTokens: 16_384,
        models: [{ id: 'x-1', name: 'X 1' }, { id: 'x-2' }],
        enabled: false,
      },
    })
    expect(routes.get('extra')).toMatchObject({
      displayName: 'Extra (custom)',
      binary: 'extra-cli',
      modelArg: '-m',
      effortArg: 'model_reasoning_effort',
      effortStyle: 'codex-config',
      efforts: ['low', 'high'],
      extraArgs: ['exec', '--json'],
      promptStyle: 'trailing',
      promptArg: '-p',
      parseMode: 'stream-json',
      env: { FLAG: '1' },
      apiKeyEnv: 'CUSTOM_KEY',
      allowDelegatedTools: true,
      contextWindow: 200_000,
      defaultMaxTokens: 16_384,
      models: [{ id: 'x-1', name: 'X 1' }, { id: 'x-2' }],
      enabled: false,
    })
    expect(CUSTOM_ROUTE_TEMPLATE.extraArgs).toEqual([])
  })

  it('keeps an explicit empty models list as a clearing override', () => {
    const routes = resolveRoutes(Config({
      routes: { extra: { displayName: 'Extra (custom)', binary: 'extra-cli', enabled: true, models: [] } },
    }).routes)
    expect(routes.get('extra')?.models).toEqual([])
  })

  it('coerces a custom route partial through Config before resolveRoutes', () => {
    // The settings layer coerces a partial route through the Config schema
    // before resolveRoutes merges it; absent array/dict fields stay absent.
    const section = Config({
      routes: { extra: { displayName: 'Extra (custom)', binary: 'extra-cli', enabled: true } },
    })
    const extra = resolveRoutes(section.routes).get('extra')
    expect(extra?.enabled).toBe(true)
    expect(extra?.models).toEqual([])
    expect(extra?.efforts).toEqual([])
    expect(extra?.parseMode).toBe('json')
  })
})

describe('plugin registration', () => {
  it('registers no adapter when every declared route is disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(plugin, {
      routes: {
        'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli', enabled: false },
        'thinking-cli': { displayName: 'Thinking CLI (delegated)', binary: 'thinking-cli', enabled: false },
      },
    })
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(
      expect.arrayContaining(['flag-cli', 'thinking-cli']),
    )
    await ctx.fiber.dispose()
  })

  it('boots with no declared routes and grows on a settings overlay', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    await ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: { 'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli' } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['flag-cli'])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['flag-cli'])
    await ctx.fiber.dispose()
  })

  it('keeps declared routes live beside bare disabled toggles from a settings overlay', async () => {
    // Regression: a section mixing bare switch-offs with one declared route
    // must not sink the declared route.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    await ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: {
        'off-cli': { enabled: false },
        'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli' },
      },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['flag-cli'])
    // A bare toggle-off placeholder carries no binary, so it earns no card.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['flag-cli'])
    await ctx.fiber.dispose()
  })

  it('rejects a settings write enabling a route without displayName and binary', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    await expect(ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: { 'flag-cli': { enabled: true } },
    })).rejects.toThrow('displayName and binary')
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('withdraws a disabled route from the live registry', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {
      routes: { 'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli' } },
    })
    expect(ctx.llm.listProviders().some(provider => provider.id === 'flag-cli')).toBe(true)
    await ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: { 'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli', enabled: false } },
    })
    expect(ctx.llm.listProviders().some(provider => provider.id === 'flag-cli')).toBe(false)
    expect(ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'flag-cli')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('registers the declared delegated routes and validates efforts', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(plugin, {
      routes: {
        'flag-cli': {
          displayName: 'Flag CLI (delegated)',
          binary: 'flag-cli',
          efforts: ['low', 'high'],
          models: [{ id: 'flag-4', name: 'Flag 4' }],
          allowDelegatedTools: true,
          apiKeyEnv: 'TEST_API_KEY',
        },
      },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['flag-cli'])
    expect(ctx.llm.listProviders().every(provider => provider.kind === 'delegated')).toBe(true)
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.find(entry => entry.provider === 'flag-cli')).toMatchObject({
      kind: 'delegated',
      settingsNs: 'llm-cli-bridge',
      binary: 'flag-cli',
    })
    expect(typeof directory.find(entry => entry.provider === 'flag-cli')?.binaryFound).toBe('boolean')
    const resolved = await ctx.llm.resolveCallConfig({
      provider: 'flag-cli',
      model: 'flag-4',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(resolved.reasoningEffort).toBe('high')
    await expect(ctx.llm.resolveCallConfig({
      provider: 'flag-cli',
      model: 'flag-4',
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
    await ctx.plugin(plugin, {
      routes: { 'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli' } },
    })
    await collect(ctx.llm.stream(options({ sessionId: SessionId('sess-1') })))
    expect(spawn.mock.calls[0]![0].cwd).toBe('/ws/project')
    expect(spawn.mock.calls[0]![0].graceMs).toBe(3_000)

    await ctx.settings.update(settingsNamespace('llm-cli-bridge'), {
      routes: { 'flag-cli': { displayName: 'Renamed Flag', binary: 'flag-cli' } },
      disposeGraceMs: 4_500,
    })
    await collect(ctx.llm.stream(options({ sessionId: SessionId('sess-1') })))
    expect(spawn.mock.calls[1]![0].graceMs).toBe(4_500)
    expect(ctx.llm.listProviders().find(provider => provider.id === 'flag-cli')?.name)
      .toBe('Renamed Flag')

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

  it('uses the default disposeGraceMs for a composition-only route', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fakeChild())
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('subprocess', { spawn })
    ctx.provide('sessions', {
      get: () => ({ header: { cwd: '/ws' } }),
    })
    plugin.apply(ctx, {
      routes: { 'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli' } },
    })
    await collect(ctx.llm.stream(options({ sessionId: SessionId('s') })))
    expect(spawn.mock.calls[0]![0].graceMs).toBe(3_000)
    await ctx.fiber.dispose()
  })

  it('fails loud when subprocess or sessions is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(plugin, {
      routes: { 'flag-cli': { displayName: 'Flag CLI (delegated)', binary: 'flag-cli' } },
    })
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
    const unnamed = { ...THINKING_ROUTE }
    delete unnamed.apiKeyEnv
    await expect(plugin.resolveRouteEnv(ctx, unnamed)).resolves.toEqual({})
    await expect(plugin.resolveRouteEnv(ctx, {
      ...THINKING_ROUTE,
      apiKeyEnv: '',
      env: { FLAG: '1' },
    })).resolves.toEqual({ FLAG: '1' })
  })

  it('injects a credentials-seam secret and skips an empty named ref', async () => {
    const keyed = new Context()
    keyed.provide('credentials', {
      resolve: async () => ({ value: 'sk-live', source: 'file' }),
    })
    await expect(plugin.resolveRouteEnv(keyed, FLAG_ROUTE))
      .resolves.toEqual({ TEST_API_KEY: 'sk-live' })

    const missing = new Context()
    missing.provide('credentials', {
      resolve: async () => undefined,
    })
    await expect(plugin.resolveRouteEnv(missing, FLAG_ROUTE))
      .resolves.toEqual({})

    const blank = new Context()
    blank.provide('credentials', {
      resolve: async () => ({ value: '', source: 'file' }),
    })
    await expect(plugin.resolveRouteEnv(blank, FLAG_ROUTE))
      .resolves.toEqual({})
  })

  it('reads the launch environment when the credentials seam is absent', async () => {
    const previous = process.env.TEST_API_KEY
    process.env.TEST_API_KEY = 'from-launch'
    try {
      const ctx = new Context()
      await expect(plugin.resolveRouteEnv(ctx, FLAG_ROUTE))
        .resolves.toEqual({ TEST_API_KEY: 'from-launch' })
    } finally {
      if (previous === undefined) delete process.env.TEST_API_KEY
      else process.env.TEST_API_KEY = previous
    }
  })
})
