/**
 * Settings-driven lifecycle: the section overlay re-registers the route in
 * place (enabled toggle), and the no-seam launch-environment fallback
 * resolves the key when no credentials service is mounted.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import * as LlmXaiApiKey from '../src/index.ts'
import type { Config as XaiConfig } from '../src/config.ts'
import { mockUpstream, textTurn } from './helpers.ts'
import type { MockUpstream } from './helpers.ts'

const NS = settingsNamespace('llm-xai-apikey')

let root: string | undefined
let upstream: MockUpstream | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Boot the plugin with a writable settings section over a local xAI stand-in. */
async function boot(config: XaiConfig = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'xai-apikey-dynamic-'))
  upstream = await mockUpstream(textTurn('hello'))
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  await context.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  const pluginConfig: XaiConfig = config
  if (pluginConfig.baseURL === undefined) pluginConfig.baseURL = upstream.url + '/v1'
  await context.plugin(LlmXaiApiKey, pluginConfig)
  return context
}

/** Drive ctx.llm.stream through the production assembler. */
async function assemble(
  context: Context,
  request: Omit<import('@shres-code/shres-code-llm').GenerateOptions, 'provider'>,
): Promise<{ text: string; finish: import('@shres-code/shres-code-llm').FinishReason }> {
  const assembler = new BlockAssembler()
  for await (const chunk of context.llm.stream({ provider: 'xai-apikey', ...request })) {
    assembler.push(chunk)
  }
  const message = assembler.message({ kind: 'model', provider: 'xai-apikey', model: request.model })
  return {
    text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    finish: assembler.finish,
  }
}

describe('llm-xai-apikey settings lifecycle', () => {
  it('enabled: false in settings withdraws the route and restoring re-registers it', async () => {
    await boot({ enabled: true })
    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['xai-apikey'])
    await ctx!.settings.update(NS, { enabled: false })
    expect(ctx!.llm.listProviders()).toEqual([])
    expect(ctx!.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['xai-apikey'])
    await ctx!.settings.update(NS, { enabled: true })
    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['xai-apikey'])
  })

  it('resolves the key from the launch environment when no credentials seam is mounted', async () => {
    vi.stubEnv('XAI_API_KEY', 'from-launch')
    await boot({ enabled: true })
    const result = await assemble(ctx!, { model: 'grok-4.6', messages: [] })
    expect(result.text).toBe('hello')
    expect(result.finish.kind).toBe('stop')
    expect(upstream!.authHeaders[0]).toBe('Bearer from-launch')
  })
})
