import { Context } from '@roos-code/cordis'
import Loader from '@roos-code/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@roos-code/roos-code-agent'
import type { InvariantInstaller } from '@roos-code/roos-code-invariants'
import type { ContentBlock } from '@roos-code/roos-code-llm'
import SubagentRuntime from '@roos-code/roos-code-subagent'
import { MAX_TIMER_DELAY_MS } from '@roos-code/roos-code-timeout'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@roos-code/roos-code-subprocess'
import LocalSubprocessRuntime from '@roos-code/roos-code-subprocess-local'
import * as grok from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  grokHeadlessArgv,
  startGrokCliRun,
  textTask,
  type GrokCliRunSpec,
} from '../src/run.ts'
import { parseGrokJson } from '../src/parse.ts'

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent: fakeParent, signal }
}

function fakeChild(options: {
  stdout?: string
  outcome?: SubprocessOutcome
  doneError?: Error
  hold?: boolean
} = {}): { handle: SubprocessHandle; terminate: ReturnType<typeof vi.fn> } {
  const stdout = options.stdout ?? JSON.stringify({ result: 'done' })
  let settled = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (outcome: SubprocessOutcome): void => {
    if (settled) return
    settled = true
    resolveDone(outcome)
  }
  if (options.doneError !== undefined) rejectDone(options.doneError)
  else if (!options.hold) queueMicrotask(() => settle(options.outcome ?? { exitCode: 0, signal: null }))
  const terminate = vi.fn(() => {
    settle(options.outcome ?? { exitCode: null, signal: 'SIGTERM' })
  })
  const handle: SubprocessHandle = {
    pid: 1234,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: {
        readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }),
      },
    },
    done,
    terminate,
    waitForExit: vi.fn(async () => true),
  }
  return { handle, terminate }
}

function runSpec(child: ReturnType<typeof fakeChild>, overrides: Partial<GrokCliRunSpec> = {}): GrokCliRunSpec {
  return {
    cwd: process.cwd(),
    executable: 'grok',
    env: {},
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => child.handle,
    ...overrides,
  }
}

describe('textTask and parseGrokJson', () => {
  it('rejects empty or non-text tasks', () => {
    expect(() => textTask([])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'x' }])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'text', text: '   ' }])).toThrow('must not be empty')
    expect(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('extracts the Grok JSON answer and rejects empty or error payloads', () => {
    expect(parseGrokJson('{"result":"hello"}')).toBe('hello')
    expect(parseGrokJson('{"text":"from text"}')).toBe('from text')
    expect(() => parseGrokJson('')).toThrow('no output')
    expect(() => parseGrokJson('not-json')).toThrow('was not JSON')
    expect(() => parseGrokJson('{"is_error":true,"result":"no"}')).toThrow('no answer')
    expect(() => parseGrokJson('{"type":"error","message":"auth"}')).toThrow('no answer')
    expect(() => parseGrokJson('{}')).toThrow('no answer')
  })

  it('builds the fixed headless argv', () => {
    expect(grokHeadlessArgv('/bin/grok', 'task')).toEqual([
      '/bin/grok', '-p', 'task', '--output-format', 'json', '--always-approve', '--no-auto-update',
    ])
  })
})

describe('startGrokCliRun', () => {
  it('spawns grok -p, maps JSON success, and tears down', async () => {
    const child = fakeChild({ stdout: '{"result":"ok answer"}' })
    const spawn = vi.fn(() => child.handle)
    const run = await startGrokCliRun(request(), runSpec(child, { spawn, env: { XAI_API_KEY: 'k' } }))
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'ok answer' }],
      stopReason: 'completed',
    })
    const spec = spawn.mock.calls[0]![0] as SubprocessSpawnSpec
    expect(spec.argv).toEqual(grokHeadlessArgv('grok', 'do the task'))
    expect(spec.env).toEqual({ XAI_API_KEY: 'k' })
    expect(spec.cwd).toBe(process.cwd())
    await run.dispose()
    expect(child.terminate).toHaveBeenCalled()
  })

  it('disposes a pid-less child and treats missing stdout as empty', async () => {
    const missing = fakeChild()
    missing.handle.collected = { stdout: undefined }
    const missingRun = await startGrokCliRun(request(), runSpec(missing))
    await expect(missingRun.result).resolves.toMatchObject({ stopReason: 'error' })
    await missingRun.dispose()

    const child = fakeChild({ stdout: '' })
    child.handle.pid = 0
    child.handle.collected = { stdout: undefined }
    child.handle.done = Promise.reject(new Error('already gone'))
    void child.handle.done.catch(() => undefined)
    const run = await startGrokCliRun(request(), runSpec(child))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await run.dispose()
  })

  it('maps a non-zero exit to a structured error, not success', async () => {
    const child = fakeChild({
      stdout: '{"result":"ignored"}',
      outcome: { exitCode: 2, signal: null },
    })
    const onError = vi.fn()
    const run = await startGrokCliRun(request(), runSpec(child, { onError }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('exited with code 2'),
    }), 'error')
    await run.dispose()
  })

  it('maps local cancellation to aborted', async () => {
    const controller = new AbortController()
    const child = fakeChild({ hold: true })
    const run = await startGrokCliRun(
      request([{ type: 'text', text: 'task' }], controller.signal),
      runSpec(child),
    )
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
  })

  it('rejects start when the request is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(startGrokCliRun(
      request([{ type: 'text', text: 'task' }], controller.signal),
      runSpec(fakeChild()),
    )).rejects.toThrow('aborted before Grok Build startup')
  })
})

describe('Grok CLI provider registration', () => {
  it('registers grok-cli with no start capabilities and validates config', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(grok, {})
    expect(ctx.subagents.list()).toContain('grok-cli')
    const info = ctx.subagents.getProvider('grok-cli')
    expect(info).toMatchObject({
      name: 'grok-cli',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    await fiber.dispose()

    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ctx.plugin(grok, { disposeGraceMs }))
        .rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(ctx.plugin(grok, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    await expect(ctx.plugin(grok, { executable: '' }))
      .rejects.toThrow('executable must not be empty')
    await ctx.fiber.dispose()
  })

  it('requires a parent session cwd and honors an executable override', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable')
    await ctx.plugin(grok, { executable: '/opt/grok' })

    await expect(ctx.subagents.start('grok-cli', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
      signal: new AbortController().signal,
    })).rejects.toThrow(
      'subagent-grok-cli: no working directory for the child — delegate from a parent session that has one',
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(resolveExecutable).not.toHaveBeenCalled()

    const child = fakeChild()
    spawn.mockImplementation(() => child.handle)
    const run = await ctx.subagents.start('grok-cli', request())
    expect(spawn.mock.calls[0]![0].argv[0]).toBe('/opt/grok')
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('resolves the executable from PATH and logs a child failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable')
      .mockResolvedValue('/resolved/grok')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(grok, {})
    const child = fakeChild({
      stdout: '',
      outcome: { exitCode: 2, signal: null },
    })
    child.handle.collected = { stdout: undefined }
    spawn.mockImplementation(() => child.handle)
    const run = await ctx.subagents.start('grok-cli', request())
    expect(resolveExecutable).toHaveBeenCalled()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(warn).toHaveBeenCalled()
    child.handle.pid = 0
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape and package-owned empty invariant', async () => {
    expect('default' in grok).toBe(false)
    expect(grok.name).toBe('subagent-grok-cli')
    expect(grok.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(grok)).toBe(grok)

    const dispose = vi.fn()
    const register = vi.fn((
      _packageName: string,
      _installer: InvariantInstaller,
    ) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@roos-code/roos-code-subagent-grok-cli',
      expect.any(Function),
    )
    const install = register.mock.calls[0]![1]
    await install(new Context(), (message) => { throw new Error(message) })
    expect(invariant.name).toBe('subagent-grok-cli-invariant')
    expect(invariant.inject).toEqual(['invariants'])
  })
})
