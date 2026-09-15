/** First-run picker: detection, readiness, CLI transcript, and persistence. */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { LlmAdapter } from '@shres-code/shres-code-llm'
import type { GenerateOptions, StreamChunk } from '@shres-code/shres-code-llm'
import * as LlmPiAi from '@shres-code/shres-code-llm-pi-ai'
import AgentDefaultModelConfig from '@shres-code/shres-code-agent-default-model'
import { credentialRef } from '@shres-code/shres-code-credentials'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import { SettingsProvider, settingsNamespace } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import * as FirstRunSetup from '../src/index.ts'
import { apply as installInvariant } from '../src/invariant.ts'
import { formatMenu, numberOptions, readLine, readSecret, runCliPicker } from '../src/cli.ts'
import { detectLocalOllama } from '../src/detect.ts'
import { applyChoice, deriveKeyRef } from '../src/apply-choice.ts'
import {
  hasUserSelection, isDefaultUsable, listPickerOptions, noProviderError, TEMPLATE_ROUTES,
} from '../src/options.ts'
import type { CliIo } from '../src/types.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
    return Promise.resolve()
  }
}

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

async function listingServer(payload: unknown, status = 200): Promise<string> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

function captureIo(script: string[]): { io: CliIo; stdout: string } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let printed = ''
  stdout.on('data', (chunk: Buffer) => { printed += chunk.toString('utf8') })
  queueMicrotask(() => {
    for (const line of script) stdin.write(`${line}\n`)
    stdin.end()
  })
  return {
    io: { stdin, stdout, stderr: stdout, isTTY: true },
    get stdout() { return printed },
  }
}

async function boot(options: {
  defaultProvider?: string
  defaultModel?: string
  envKey?: string
  userSelection?: { provider: string; model: string }
} = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(MemoryCredentials, options.envKey === undefined ? {} : { [options.envKey]: 'secret' })
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: options.defaultProvider ?? 'deepseek-official',
    model: options.defaultModel ?? 'deepseek-v4-flash',
  })
  await ctx.plugin(LlmPiAi, {
    providers: {
      'ollama-local': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        headers: { Authorization: 'Bearer ollama' },
        models: [{ id: 'llama3.2' }],
      },
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    },
  })
  if (options.userSelection !== undefined) {
    await ctx.agentDefaultModel.saveSelection(options.userSelection)
  }
  if (options.envKey !== undefined) {
    await ctx.credentials.set(credentialRef(options.envKey), 'secret')
  }
  return ctx
}

describe('detectLocalOllama', () => {
  it('returns advertised models when the endpoint answers', async () => {
    const url = await listingServer({ data: [{ id: 'llama3.2', name: 'Llama 3.2' }] })
    const status = await detectLocalOllama({ baseURL: `${url}/v1`, timeoutMs: 1000 })
    expect(status).toEqual({
      reachable: true,
      models: [{ id: 'llama3.2', name: 'Llama 3.2' }],
    })
  })

  it('returns unreachable when the endpoint refuses', async () => {
    const url = await listingServer('nope', 500)
    const status = await detectLocalOllama({ baseURL: `${url}/v1`, timeoutMs: 1000 })
    expect(status).toEqual({ reachable: false, models: [] })
  })

  it('returns unreachable when nothing listens', async () => {
    const status = await detectLocalOllama({
      baseURL: 'http://127.0.0.1:1/v1',
      timeoutMs: 200,
    })
    expect(status.reachable).toBe(false)
  })
})

describe('readiness', () => {
  it('treats a user-saved selection as already set up', async () => {
    const ctx = await boot({ userSelection: { provider: 'openai', model: 'gpt-4.1' } })
    expect(hasUserSelection(ctx)).toBe(true)
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    await ctx.fiber.dispose()
  })

  it('treats a keyed default as usable only when the credential is stored', async () => {
    const ctx = await boot()
    expect(hasUserSelection(ctx)).toBe(false)
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'sk')
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(true)
    await ctx.fiber.dispose()
  })

  it('does not treat a delegated CLI default as usable', async () => {
    class DelegatedAdapter extends LlmAdapter {
      override providerInfo(provider: string) {
        return { id: provider, name: provider, kind: 'delegated' as const }
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unused')
      }
    }

    const ctx = await boot({ defaultProvider: 'grok-cli', defaultModel: 'grok-4' })
    ctx.llm.registerConfigurableProviders([{
      provider: 'grok-cli',
      displayName: 'Grok',
      settingsNs: 'llm-cli-bridge',
      settingsPath: ['routes', 'grok-cli'],
      kind: 'delegated',
    }])
    ctx.llm.registerAdapter(['grok-cli'], new DelegatedAdapter())
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    await ctx.fiber.dispose()

    const liveOnly = await boot({ defaultProvider: 'orphan-cli', defaultModel: 'x' })
    liveOnly.llm.registerAdapter(['orphan-cli'], new DelegatedAdapter())
    expect(await isDefaultUsable(liveOnly, { reachable: false, models: [] })).toBe(false)
    await liveOnly.fiber.dispose()
  })

  it('does not treat a chat-gated default as usable', async () => {
    class GatedAdapter extends LlmAdapter {
      override providerInfo(provider: string) {
        return { id: provider, name: provider }
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unused')
      }
    }

    const ctx = await boot({ defaultProvider: 'cursor-session', defaultModel: 'gpt-5.2' })
    ctx.llm.registerConfigurableProviders([{
      provider: 'cursor-session',
      displayName: 'Cursor (subscription)',
      settingsNs: 'llm-cursor-session',
      settingsPath: [],
      chatGated: true,
    }])
    ctx.llm.registerAdapter(['cursor-session'], new GatedAdapter())
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    await ctx.fiber.dispose()
  })

  it('treats an ollama-local default as usable only while the probe succeeds', async () => {
    const ctx = await boot({ defaultProvider: 'ollama-local', defaultModel: 'llama3.2' })
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    expect(await isDefaultUsable(ctx, { reachable: true, models: [{ id: 'llama3.2' }] })).toBe(true)
    await ctx.fiber.dispose()
  })

  it('lists detected Ollama models before template routes and custom', () => {
    const options = listPickerOptions({
      reachable: true,
      models: [{ id: 'llama3.2', name: 'Llama 3.2' }],
    })
    expect(options[0]).toEqual({
      kind: 'ollama-local', provider: 'ollama-local', model: 'llama3.2', name: 'Llama 3.2',
    })
    expect(options.some(option => option.kind === 'template' && option.provider === 'xai')).toBe(true)
    expect(options.at(-1)).toEqual({ kind: 'custom' })
    expect(TEMPLATE_ROUTES.map(route => route.provider)).toContain('moonshotai')
    expect(TEMPLATE_ROUTES.map(route => route.provider)).toContain('zai')
  })
})

describe('CLI picker', () => {
  it('fails loud without a TTY', async () => {
    await expect(runCliPicker({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false,
    }, listPickerOptions({ reachable: false, models: [] }))).rejects.toThrow(noProviderError().message)
  })

  it('prints the menu and applies a numbered Ollama choice', async () => {
    const options = listPickerOptions({
      reachable: true,
      models: [{ id: 'qwen2.5', name: 'Qwen 2.5' }],
    })
    const captured = captureIo(['1'])
    const choice = await runCliPicker(captured.io, options)
    expect(choice).toEqual({ kind: 'ollama-local', model: 'qwen2.5' })
    expect(captured.stdout).toContain('Qwen 2.5 (Ollama local)')
    expect(captured.stdout).toContain('q. Quit')
  })

  it('collects a template key and a custom route', async () => {
    const options = listPickerOptions({ reachable: false, models: [] })
    const openaiIndex = numberOptions(options).find(entry =>
      entry.option.kind === 'template' && entry.option.provider === 'openai')
    if (openaiIndex === undefined) throw new Error('openai template missing')
    const captured = captureIo([String(openaiIndex.index), 'sk-openai'])
    await expect(runCliPicker(captured.io, options)).resolves.toEqual({
      kind: 'template',
      provider: 'openai',
      apiKey: 'sk-openai',
      model: 'gpt-4.1',
    })

    const customIndex = numberOptions(options).at(-1)
    if (customIndex === undefined) throw new Error('custom missing')
    const custom = captureIo([String(customIndex.index), 'acme-gateway', 'https://acme.test/v1', 'acme-large', 'sk-acme'])
    await expect(runCliPicker(custom.io, options)).resolves.toEqual({
      kind: 'custom',
      provider: 'acme-gateway',
      baseURL: 'https://acme.test/v1',
      model: 'acme-large',
      api: 'openai-completions',
      apiKey: 'sk-acme',
    })
  })

  it('rejects quit, a blank key, and a bad custom id', async () => {
    const options = listPickerOptions({ reachable: false, models: [] })
    await expect(runCliPicker(captureIo(['q']).io, options)).rejects.toThrow(/does not silently default/)
    const openaiIndex = numberOptions(options).find(entry =>
      entry.option.kind === 'template' && entry.option.provider === 'openai')
    if (openaiIndex === undefined) throw new Error('openai template missing')
    await expect(runCliPicker(captureIo([String(openaiIndex.index), '']).io, options))
      .rejects.toThrow(/OPENAI_API_KEY is required/)
    const customIndex = numberOptions(options).at(-1)
    if (customIndex === undefined) throw new Error('custom missing')
    await expect(runCliPicker(captureIo([String(customIndex.index), 'BAD']).io, options))
      .rejects.toThrow(/Provider ID must start/)
  })

  it('reprompts an unknown number and fails when stdin closes', async () => {
    const options = listPickerOptions({ reachable: false, models: [] })
    const captured = captureIo(['nope', 'q'])
    await expect(runCliPicker(captured.io, options)).rejects.toThrow(/does not silently default/)
    expect(captured.stdout).toContain('Enter a listed number')

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    queueMicrotask(() => { stdin.end() })
    await expect(runCliPicker({ stdin, stdout, stderr: stdout, isTTY: true }, options))
      .rejects.toThrow(/stdin closed/)
  })

  it('formats a stable transcript header', () => {
    const text = formatMenu(numberOptions([{ kind: 'custom' }]))
    expect(text).toContain('No default model is configured')
    expect(text).toContain('1. Custom base URL')
  })

  it('rejects a closed stdin on readLine', async () => {
    const stdin = new PassThrough()
    const pending = readLine(stdin)
    stdin.end()
    await expect(pending).rejects.toThrow(/stdin closed/)
  })

  it('pauses the shared line reader and restores a previous raw TTY', async () => {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (value: boolean) => boolean
    }
    stdin.isTTY = true
    stdin.isRaw = true
    stdin.setRawMode = (value: boolean) => {
      stdin.isRaw = value
      return value
    }
    const stdout = new PassThrough()
    let printed = ''
    stdout.on('data', (chunk: Buffer) => { printed += chunk.toString('utf8') })
    const io: CliIo = { stdin, stdout, stderr: stdout, isTTY: true }
    const pendingLine = readLine(stdin)
    queueMicrotask(() => { stdin.write('1\n') })
    await expect(pendingLine).resolves.toBe('1')
    const pending = readSecret(io)
    queueMicrotask(() => { stdin.write('sk-live\r') })
    await expect(pending).resolves.toBe('sk-live')
    expect(printed).toBe('\n')
    expect(stdin.isRaw).toBe(true)
  })

  it('hides TTY keystrokes while collecting an API key', async () => {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (value: boolean) => boolean
    }
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (value: boolean) => {
      stdin.isRaw = value
      return value
    }
    const stdout = new PassThrough()
    let printed = ''
    stdout.on('data', (chunk: Buffer) => { printed += chunk.toString('utf8') })
    const pending = readSecret({ stdin, stdout, stderr: stdout, isTTY: true })
    queueMicrotask(() => { stdin.write('sk-live\r') })
    await expect(pending).resolves.toBe('sk-live')
    expect(printed).toBe('\n')
    expect(stdin.isRaw).toBe(false)
  })

  it('supports backspace and treats Ctrl-C as interrupt on a hidden TTY', async () => {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (value: boolean) => boolean
    }
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (value: boolean) => {
      stdin.isRaw = value
      return value
    }
    const stdout = new PassThrough()
    const pending = readSecret({ stdin, stdout, stderr: stdout, isTTY: true })
    queueMicrotask(() => { stdin.write('a\tb\u0001\u007fc\r') })
    await expect(pending).resolves.toBe('a\tc')

    const cancelled = readSecret({ stdin, stdout, stderr: stdout, isTTY: true })
    queueMicrotask(() => { stdin.write('\u0003') })
    await expect(cancelled).rejects.toThrow(/interrupted/)
  })
})

describe('applyChoice', () => {
  it('saves a local Ollama default and adopts the picked model onto the route', async () => {
    const ctx = await boot()
    await applyChoice(ctx, { kind: 'ollama-local', model: 'qwen2.5' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ollama-local', model: 'qwen2.5' })
    const info = await ctx.llm.resolveModelInfo('ollama-local', 'qwen2.5')
    expect(info.id).toBe('qwen2.5')
    await expect(ctx.llm.resolveModelInfo('ollama-local', 'llama3.2'))
      .rejects.toThrow(/no configured model/)
    await ctx.fiber.dispose()
  })

  it('stores a template key and default model', async () => {
    const ctx = await boot()
    await applyChoice(ctx, { kind: 'template', provider: 'openai', apiKey: 'sk-live', model: 'gpt-4.1' })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    expect((await ctx.credentials.describe(credentialRef('OPENAI_API_KEY'))).configured).toBe(true)
    await ctx.fiber.dispose()
  })

  it('writes a custom pi-ai route', async () => {
    const ctx = await boot()
    await applyChoice(ctx, {
      kind: 'custom',
      provider: 'acme-gateway',
      baseURL: 'https://acme.test/v1',
      model: 'acme-large',
      apiKey: 'sk-acme',
      displayName: 'Acme',
    })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: 'acme-gateway', model: 'acme-large',
    })
    const section = ctx.settings.get(settingsNamespace('llm-pi-ai')) as {
      providers?: { 'acme-gateway'?: { baseURL?: string } }
    }
    expect(section.providers?.['acme-gateway']?.baseURL).toBe('https://acme.test/v1')
    expect(deriveKeyRef('acme-gateway')).toBe('ACME_GATEWAY_API_KEY')
    await ctx.fiber.dispose()
  })

  it('rejects an unknown template', async () => {
    const ctx = await boot()
    await expect(applyChoice(ctx, { kind: 'template', provider: 'no-such' }))
      .rejects.toThrow(/unknown template provider/)
    await ctx.fiber.dispose()
  })

  it('rejects an ollama-local pick when agentDefaultModel is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'ollama-local': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          headers: { Authorization: 'Bearer ollama' },
          models: [{ id: 'llama3.2' }],
        },
      },
    })
    await expect(applyChoice(ctx, { kind: 'ollama-local', model: 'qwen2.5' }))
      .rejects.toThrow(/agentDefaultModel is required/)
    await ctx.fiber.dispose()
  })
})

describe('FirstRunSetup service', () => {
  it('does not probe local Ollama when a keyed composition default is already usable', async () => {
    const server = createServer(() => {
      throw new Error('first-run-setup must not probe Ollama when the default key is present')
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const ctx = await boot({ envKey: 'DEEPSEEK_API_KEY' })
    await ctx.plugin(FirstRunSetup, {
      ollamaBaseURL: `http://127.0.0.1:${address.port}/v1`,
      detectTimeoutMs: 2000,
      autoRunCli: false,
    })
    const started = Date.now()
    expect(await ctx.firstRunSetup.needsSetup()).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
    await ctx.fiber.dispose()
  })

  it('needs setup until a usable default exists, then apply is a no-op', async () => {
    const url = await listingServer({ data: [] }, 500)
    const ctx = await boot()
    await ctx.plugin(FirstRunSetup, {
      ollamaBaseURL: `${url}/v1`,
      detectTimeoutMs: 200,
      autoRunCli: false,
    })
    expect(await ctx.firstRunSetup.needsSetup()).toBe(true)
    expect(ctx.firstRunSetup.templateRoutes()).toHaveLength(TEMPLATE_ROUTES.length)
    const options = await ctx.firstRunSetup.listOptions()
    expect(options.at(-1)).toEqual({ kind: 'custom' })

    await ctx.firstRunSetup.applyChoice({ kind: 'template', provider: 'openai', apiKey: 'sk' })
    expect(await ctx.firstRunSetup.needsSetup()).toBe(false)
    await ctx.firstRunSetup.ensureReady({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false,
    })
    await ctx.fiber.dispose()
  })

  it('exposes detectLocalOllama on the registered service', async () => {
    const url = await listingServer({ data: [] }, 500)
    const ctx = await boot()
    await ctx.plugin(FirstRunSetup, {
      ollamaBaseURL: `${url}/v1`,
      detectTimeoutMs: 200,
      autoRunCli: false,
    })
    const status = await ctx.firstRunSetup.detectLocalOllama()
    expect(status.reachable).toBe(false)
    await ctx.fiber.dispose()
  })

  it('auto-runs the CLI picker during apply when autoRunCli is true', async () => {
    const url = await listingServer({ data: [{ id: 'qwen2.5' }] })
    const ctx = await boot()
    const captured = captureIo(['1'])
    const previous = FirstRunSetup.internals.io
    FirstRunSetup.internals.io = () => captured.io
    try {
      await ctx.plugin(FirstRunSetup, {
        ollamaBaseURL: `${url}/v1`,
        detectTimeoutMs: 1000,
        autoRunCli: true,
      })
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'ollama-local', model: 'qwen2.5',
      })
      expect((await ctx.llm.resolveModelInfo('ollama-local', 'qwen2.5')).id).toBe('qwen2.5')
    } finally {
      FirstRunSetup.internals.io = previous
    }
    expect(FirstRunSetup.defaultIo().stdout).toBe(process.stderr)
    await ctx.fiber.dispose()
  })

  it('registers an empty invariant companion', async () => {
    const ctx = new Context()
    const registered: string[] = []
    ctx.provide('invariants', {
      register: (packageName: string, install: () => void) => {
        registered.push(packageName)
        install()
        return () => {}
      },
    } as never)
    const dispose = await installInvariant(ctx)
    expect(registered).toEqual(['@shres-code/shres-code-first-run-setup'])
    expect(typeof dispose).toBe('function')
    dispose()
    await ctx.fiber.dispose()
  })
})

describe('user-layer detection without settings', () => {
  it('reports no user selection when settings are absent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    expect(hasUserSelection(ctx)).toBe(false)
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    process.env.P_API_KEY = 'from-env'
    try {
      // No credentials seam and no matching apiKeyEnv on the route: a live
      // adapter still counts as usable when the route names no key.
      expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    } finally {
      delete process.env.P_API_KEY
    }
    await ctx.fiber.dispose()
  })

  it('reads process.env when the credentials seam is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'openai', model: 'gpt-4.1' })
    await ctx.plugin(LlmPiAi, { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
    process.env.OPENAI_API_KEY = 'env-key'
    try {
      expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(true)
    } finally {
      delete process.env.OPENAI_API_KEY
    }
    await ctx.fiber.dispose()
  })
})

describe('coverage edges', () => {
  it('applies a template without a key and fails custom writes without seams', async () => {
    const ctx = await boot()
    await applyChoice(ctx, { kind: 'template', provider: 'openai' })
    expect(ctx.agentDefaultModel.currentSelection().provider).toBe('openai')

    const empty = new Context()
    await empty.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    await expect(applyChoice(empty, {
      kind: 'custom', provider: 'x', baseURL: 'http://x', model: 'm',
    })).rejects.toThrow(/settings provider is required/)
    await expect(applyChoice(empty, {
      kind: 'template', provider: 'openai', apiKey: 'sk',
    })).rejects.toThrow(/credentials provider is required/)
    await applyChoice(empty, { kind: 'template', provider: 'openai' })
    // No settings provider: saveSelection is a no-op and the composition entry stays.
    expect(empty.agentDefaultModel.currentSelection()).toEqual({ provider: 'p', model: 'm' })
    await empty.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('collects a keyless template and a custom route without a key', async () => {
    const options = [
      { kind: 'template' as const, provider: 'local', label: 'Local', defaultModel: 'm' },
      { kind: 'custom' as const },
    ]
    await expect(runCliPicker(captureIo(['1']).io, options)).resolves.toEqual({
      kind: 'template', provider: 'local', model: 'm',
    })
    await expect(runCliPicker(captureIo(['2', 'ok-id', 'http://x/v1', 'model', '']).io, options))
      .resolves.toEqual({
        kind: 'custom',
        provider: 'ok-id',
        baseURL: 'http://x/v1',
        model: 'model',
        api: 'openai-completions',
      })
  })

  it('rejects a stream error and a second read after end', async () => {
    const stdin = new PassThrough()
    const pending = readLine(stdin)
    stdin.destroy(new Error('boom'))
    await expect(pending).rejects.toThrow('boom')

    const closed = new PassThrough()
    closed.end()
    await expect(readLine(closed)).rejects.toThrow(/stdin closed/)
    await expect(readLine(closed)).rejects.toThrow(/stdin closed/)
  })

  it('aborts a hung local-Ollama probe', async () => {
    const server = createServer((_request: IncomingMessage, _response: ServerResponse) => {
      // Leave the request hanging so the configured timeout fires.
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const status = await detectLocalOllama({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: 30,
    })
    expect(status.reachable).toBe(false)
  })

  it('walks a settings path for apiKeyEnv and lists unnamed Ollama models', async () => {
    const ctx = await boot()
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(false)
    const options = listPickerOptions({ reachable: true, models: [{ id: 'bare' }] })
    expect(options[0]).toMatchObject({ kind: 'ollama-local', name: 'bare' })
    const io = FirstRunSetup.defaultIo()
    expect(io.isTTY).toBe(process.stdin.isTTY &&  process.stderr.isTTY)
    expect(await isDefaultUsable(new Context(), { reachable: false, models: [] })).toBe(false)
    const noLlm = new Context()
    await noLlm.plugin(AgentDefaultModelConfig, { provider: 'openai', model: 'gpt-4.1' })
    expect(await isDefaultUsable(noLlm, { reachable: false, models: [] })).toBe(false)
    await noLlm.fiber.dispose()
    const unknown = new Context()
    await unknown.plugin(AgentDefaultModelConfig, { provider: 'acme-gateway', model: 'm' })
    expect(await isDefaultUsable(unknown, { reachable: false, models: [] })).toBe(false)
    await unknown.fiber.dispose()
    await applyChoice(ctx, { kind: 'custom', provider: 'local-llm', baseURL: 'http://127.0.0.1:9/v1', model: 'qwen' })
    expect(await isDefaultUsable(ctx, { reachable: false, models: [] })).toBe(true)
    await applyChoice(ctx, { kind: 'template', provider: 'openai', apiKey: '' })
    expect(ctx.agentDefaultModel.currentSelection().provider).toBe('openai')
    await ctx.fiber.dispose()
  })

  it('buffers a partial line until newline and ignores a late stream error', async () => {
    const stdin = new PassThrough()
    const pending = readLine(stdin)
    stdin.write('par')
    stdin.write('tial\n')
    await expect(pending).resolves.toBe('partial')
    stdin.destroy(new Error('late'))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})

describe('apply autoRunCli', () => {
  it('fails loud on a non-TTY when setup is required', async () => {
    const ctx = await boot()
    await expect(ctx.plugin(FirstRunSetup, {
      ollamaBaseURL: 'http://127.0.0.1:1/v1',
      detectTimeoutMs: 50,
      autoRunCli: true,
    })).rejects.toThrow(/does not silently default/)
    await ctx.fiber.dispose()
  })

  it('stores a custom route without a key and rejects missing fields', async () => {
    const ctx = await boot()
    await applyChoice(ctx, {
      kind: 'custom',
      provider: 'local-llm',
      baseURL: 'http://127.0.0.1:8080/v1',
      model: 'qwen',
    })
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'local-llm', model: 'qwen' })

    const options = listPickerOptions({ reachable: false, models: [] })
    const customIndex = numberOptions(options).at(-1)
    if (customIndex === undefined) throw new Error('custom missing')
    await expect(runCliPicker(captureIo([String(customIndex.index), 'ok-id', '', 'm']).io, options))
      .rejects.toThrow(/needs a base URL/)
    await expect(runCliPicker(captureIo([String(customIndex.index), 'ok-id', 'http://x/v1', '']).io, options))
      .rejects.toThrow(/needs a model id/)
    await expect(applyChoice(ctx, { kind: 'custom', provider: 'x', baseURL: 'http://x', model: 'm' })
      .then(async () => {
        const empty = new Context()
        await applyChoice(empty, { kind: 'ollama-local', model: 'x' })
      })).rejects.toThrow(/settings provider is required/)
    await ctx.fiber.dispose()
  })
})
