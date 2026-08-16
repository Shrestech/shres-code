import { describe, expect, it, vi } from 'vitest'
import { Context } from '@roos-code/cordis'
import LlmRuntime, {
  createUserMessage,
  LlmError,
  ReasoningEffortId,
} from '@roos-code/roos-code-llm'
import type { GenerateOptions, StreamChunk } from '@roos-code/roos-code-llm'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@roos-code/roos-code-subprocess'
import { CliLlmAdapter } from '../src/adapter.ts'
import { buildCliArgv } from '../src/argv.ts'
import { resolveRoutes, SHIPPED_ROUTES } from '../src/config.ts'
import { serializePrompt } from '../src/serialize.ts'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

function fakeChild(options: {
  stdout?: string
  outcome?: SubprocessOutcome
} = {}): SubprocessHandle {
  const stdout = options.stdout ?? JSON.stringify({ result: 'hello', usage: { input_tokens: 3, output_tokens: 2 } })
  const done = Promise.resolve(options.outcome ?? { exitCode: 0, signal: null })
  return {
    pid: 99,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
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
      model: 'grok-4.5',
      effort: 'high',
      prompt: 'do it',
    })).toEqual([
      'grok',
      '--output-format', 'json',
      '--always-approve',
      '--no-auto-update',
      '--model', 'grok-4.5',
      '--effort', 'high',
      '-p', 'do it',
    ])
  })

  it('maps kimi thinking-bool and Codex config effort flags', () => {
    expect(buildCliArgv(SHIPPED_ROUTES['kimi-cli'], {
      model: 'k2',
      effort: 'high',
      prompt: 'q',
    })).toEqual([
      'kimi',
      '--output-format', 'stream-json',
      '--yolo',
      '--model', 'k2',
      '--thinking',
      '-p', 'q',
    ])
    expect(buildCliArgv(SHIPPED_ROUTES['kimi-cli'], {
      model: 'k2',
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
      model: 'k2',
      effort: 'xhigh',
      prompt: 'q',
    })).toThrow(LlmError)
    try {
      buildCliArgv(SHIPPED_ROUTES['kimi-cli'], { model: 'k2', effort: 'xhigh', prompt: 'q' })
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
    const child = fakeChild()
    child.done = new Promise((resolve) => { resolveDone = resolve })
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
    const resolved = await adapter.resolveModel('grok-cli', 'grok-4')
    expect(resolved.context).toEqual({ contextWindow: 128_000 })
    expect(resolved.defaultMaxTokens).toBe(8_192)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ])
    const kimi = await adapter.resolveModel('kimi-cli', 'k2')
    expect(kimi.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high'])
  })
})

describe('plugin registration', () => {
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
    })
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

  it('keeps the namespace export shape and empty invariant', async () => {
    expect(plugin.name).toBe('llm-cli-bridge')
    expect(plugin.inject).toEqual(['llm'])
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@roos-code/roos-code-llm-cli-bridge',
      expect.any(Function),
    )
  })
})
