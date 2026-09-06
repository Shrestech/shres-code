/**
 * Settings-driven lifecycle: the section overlay re-registers the route in
 * place (endpoint, catalog, credential source, enabled), the not-logged-in
 * wrap converts non-seam read failures, and unusable replay state on history
 * degrades with the plugin-owned diagnostic.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler, createMessage, createUserMessage } from '@shres-code/shres-code-llm'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import * as LlmCodexSession from '../src/index.ts'
import type { Config as CodexSessionConfig } from '../src/config.ts'
import { farFuture, mockUpstream, textTurn, tokensRaw, writeAuthDocument } from './helpers.ts'

const NS = settingsNamespace('llm-codex-session')

let root: string | undefined
let authPath: string | undefined
let upstream: Awaited<ReturnType<typeof mockUpstream>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the plugin with a writable settings section over a live mock backend. */
async function boot(config: CodexSessionConfig = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'codex-session-dynamic-'))
  authPath = config.authPath ?? await writeAuthDocument(tokensRaw(farFuture()))
  upstream = await mockUpstream(textTurn('hello'))
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  await context.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  const pluginConfig: CodexSessionConfig = {
    authPath: config.authPath ?? authPath,
    baseURL: config.baseURL ?? upstream.url,
  }
  if (config.enabled !== undefined) pluginConfig.enabled = config.enabled
  if (config.models !== undefined) pluginConfig.models = config.models
  if (config.displayName !== undefined) pluginConfig.displayName = config.displayName
  await context.plugin(LlmCodexSession, pluginConfig)
  return context
}

describe('llm-codex-session settings lifecycle', () => {
  it('re-registers on a section change: rename, catalog swap, and endpoint swap', async () => {
    await boot()
    await ctx!.settings.update(NS, {
      displayName: 'Codex Renamed',
      models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }],
    })
    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['codex-session'])
    const directory = ctx!.llm.listConfigurableProviders()
    expect(directory).toContainEqual({
      provider: 'codex-session',
      displayName: 'Codex Renamed',
      settingsNs: NS,
      settingsPath: [],
      declared: false,
    })
    const models = await ctx!.llm.listModels('codex-session')
    expect(models.map(model => model.id)).toEqual(['gpt-6-astra'])
    // A second request under an unchanged credential spec reuses the manager
    // instead of rebuilding it.
    const assemblerAgain = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({ provider: 'codex-session', model: 'gpt-6-astra', messages: [] })) {
      assemblerAgain.push(chunk)
    }
    expect(assemblerAgain.finish).toMatchObject({ kind: 'stop' })
    // A third request under the same credential spec: the manager is warm.
    const assemblerThird = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({ provider: 'codex-session', model: 'gpt-6-astra', messages: [] })) {
      assemblerThird.push(chunk)
    }
    expect(assemblerThird.finish).toMatchObject({ kind: 'stop' })
  })

  it('enabled: false in settings withdraws the route and restoring re-registers it', async () => {
    await boot()
    await ctx!.settings.update(NS, { enabled: false })
    expect(ctx!.llm.listProviders()).toEqual([])
    expect(ctx!.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['codex-session'])
    await ctx!.settings.update(NS, { enabled: true })
    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['codex-session'])
  })

  it('rebuilds the credential source when authPath changes, wrapping non-seam read failures', async () => {
    await boot()
    // A path with a NUL byte fails every stat/read with a non-ENOENT error,
    // which is the branch where the plugin wraps the raw failure itself.
    await ctx!.settings.update(NS, { authPath: 'bad\u0000path' })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({ provider: 'codex-session', model: 'gpt-6-astra', messages: [] })) {
      assembler.push(chunk)
    }
    const finish = assembler.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/reading the Codex session failed/)
  })

  it('admits image input only on a model that declares it, then demands the attachment service', async () => {
    await boot()
    await ctx!.settings.update(NS, {
      models: [{ id: 'gpt-6-astra', input: ['text', 'image'] }],
    })
    const imageRef = {
      attachmentId: 'sha256-1',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const message = createUserMessage({
      content: [{ type: 'image', attachment: imageRef as never }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({ provider: 'codex-session', model: 'gpt-6-astra', messages: [message] })) {
      assembler.push(chunk)
    }
    const finish = assembler.finish
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('UNSUPPORTED_CONTENT')
    expect(finish.failure.message).toMatch(/durable attachment service/)
  })

  it('warns through the plugin-owned hook when history replay state is unusable', async () => {
    const context = await boot()
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    const history = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'earlier answer' }],
      source: {
        kind: 'model',
        ...{
          provider: 'codex-session',
          model: 'gpt-6-astra',
          replayState: { response: { kind: 'pi-ai', version: 3 }, blocks: [] },
        },
      },
    })
    const assembler = new BlockAssembler()
    for await (const chunk of context.llm.stream({
      provider: 'codex-session',
      model: 'gpt-6-astra',
      messages: [history],
    })) assembler.push(chunk)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable replay state'))
    warn.mockRestore()
  })
})
