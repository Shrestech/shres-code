/**
 * Settings-section behavior: the directory entry follows a display-name
 * change without re-registration, the `enabled` switch withdraws and
 * restores the live route, and the section validate refuses an explicit
 * empty models catalog.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import LlmRuntime from '@shres-code/shres-code-llm'
import { SettingsProvider, settingsNamespace } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import * as plugin from '../src/index.ts'

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

const NS = settingsNamespace('llm-cursor-session')

describe('llm-cursor-session settings section', () => {
  it('replaces the directory entry on a display-name change', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'cursor-session'))
      .toMatchObject({ displayName: 'Cursor (subscription)', settingsNs: 'llm-cursor-session', chatGated: true })
    await ctx.settings.update(NS, { displayName: 'Cursor sub' })
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'cursor-session'))
      .toMatchObject({ displayName: 'Cursor sub' })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor-session'])
    await ctx.fiber.dispose()
  })

  it('withdraws and restores the live route on the enabled switch', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor-session'])
    await ctx.settings.update(NS, { enabled: false })
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toContain('cursor-session')
    await ctx.settings.update(NS, { enabled: true })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor-session'])
    await ctx.fiber.dispose()
  })

  it('boots dormant on a disabled composition entry and wakes on the switch', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, { enabled: false })
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.settings.update(NS, { enabled: true })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor-session'])
    await ctx.fiber.dispose()
  })

  it('rejects an explicit empty models catalog and adopts a non-empty overlay', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(plugin, {})
    await expect(ctx.settings.update(NS, { models: [] })).rejects.toThrow(/empty models catalog/)
    expect((await ctx.llm.listModels('cursor-session')).map(model => model.id)).toContain('gpt-5.2')
    await ctx.settings.update(NS, { models: [{ id: 'cursor-new' }] })
    expect((await ctx.llm.listModels('cursor-session')).map(model => model.id)).toEqual(['cursor-new'])
    await ctx.fiber.dispose()
  })
})
