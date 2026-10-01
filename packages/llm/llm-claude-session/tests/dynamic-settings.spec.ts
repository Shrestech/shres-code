/**
 * Settings-driven lifecycle: the section overlay re-registers the route in
 * place (display name, catalog, enabled), an unserviceable write is refused
 * where it is made, and a change that touches no route fact re-registers
 * nothing.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime, { BlockAssembler } from '@shres-code/shres-code-llm'
import { settingsNamespace } from '@shres-code/shres-code-settings'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import * as LlmClaudeSession from '../src/index.ts'
import { mockAnthropic, writeCredentialsDocument } from './helpers.ts'

const NS = settingsNamespace('llm-claude-session')

let root: string | undefined
let upstream: Awaited<ReturnType<typeof mockAnthropic>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the plugin with a writable settings section over a loopback stand-in. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'claude-session-dynamic-'))
  const authPath = await writeCredentialsDocument()
  upstream = await mockAnthropic()
  const context = new Context()
  ctx = context
  await context.plugin(LlmRuntime)
  await context.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  await context.plugin(LlmClaudeSession, { authPath, useKeychain: false, baseURL: upstream.url })
  return context
}

describe('llm-claude-session settings lifecycle', () => {
  it('rejects an unserviceable section where it is written', async () => {
    await boot()
    await expect(ctx!.settings.update(NS, { baseURL: '' })).rejects.toThrow(/baseURL must be non-empty/)
    await expect(ctx!.settings.update(NS, { models: [] })).rejects.toThrow(/models must list at least one model/)
    // A negative leeway never reaches the validate hook: the section's own
    // schema refuses it first, with the field named.
    await expect(ctx!.settings.update(NS, { refreshLeewayMs: -1 }))
      .rejects.toThrow(/\$\.refreshLeewayMs expected number >= 0 but got -1/)
    await expect(ctx!.settings.update(NS, { cacheRetention: 'forever' }))
      .rejects.toThrow(/\$\.cacheRetention expected "none" \| "short" \| "long" but got "forever"/)
    // Every refusal left the live route exactly as it was.
    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])
    expect(ctx!.llm.listConfigurableProviders().map(entry => entry.displayName)).toEqual(['Claude (subscription)'])
  })

  it('re-registers on a section change: rename and catalog swap', async () => {
    await boot()
    await ctx!.settings.update(NS, {
      displayName: 'Claude Renamed',
      models: [{ id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000 }],
    })

    expect(ctx!.llm.listConfigurableProviders()).toContainEqual({
      provider: 'claude-session',
      displayName: 'Claude Renamed',
      settingsNs: NS,
      settingsPath: [],
      declared: false,
    })
    expect((await ctx!.llm.listModels('claude-session')).map(model => model.id)).toEqual(['claude-opus-5'])

    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({ provider: 'claude-session', model: 'claude-opus-5', messages: [] })) {
      assembler.push(chunk)
    }
    expect(assembler.finish).toEqual({ kind: 'stop' })
  })

  it('leaves the route facts alone when a change touches none of them', async () => {
    await boot()
    // A credential-leeway change is not a registration fact: the directory
    // entry and the adapter registration both stay exactly as they were.
    await ctx!.settings.update(NS, { refreshLeewayMs: 1_000 })

    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])
    expect((await ctx!.llm.listModels('claude-session')).map(model => model.id))
      .toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5'])
  })

  it('republishes the route with the new lifetime when cacheRetention changes', async () => {
    await boot()
    let published = 0
    ctx!.on('llm/adapters-updated', () => { published += 1 })
    expect((await ctx!.llm.listModels('claude-session'))[0]?.promptCacheTtlMs).toBe(300_000)

    await ctx!.settings.update(NS, { cacheRetention: 'long' })

    // Listings refresh on the registry notification, so the change must
    // publish one for the new lifetime to reach them.
    expect(published).toBe(1)
    expect((await ctx!.llm.listModels('claude-session'))[0]?.promptCacheTtlMs).toBe(3_600_000)
    const assembler = new BlockAssembler()
    for await (const chunk of ctx!.llm.stream({ provider: 'claude-session', model: 'claude-opus-5', system: 'Be brief.', messages: [] })) {
      assembler.push(chunk)
    }
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(upstream!.requests.at(-1)!.body)).toContain('"ttl":"1h"')
  })

  it('enabled: false in settings withdraws the route and restoring re-registers it', async () => {
    await boot()
    await ctx!.settings.update(NS, { enabled: false })
    expect(ctx!.llm.listProviders()).toEqual([])
    expect(ctx!.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual(['claude-session'])

    await ctx!.settings.update(NS, { enabled: true })
    expect(ctx!.llm.listProviders().map(provider => provider.id)).toEqual(['claude-session'])
  })
})
