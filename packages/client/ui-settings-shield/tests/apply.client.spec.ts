/** Shield section registration and locale-following nav label. */

import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@shres-code/shres-code-client-ui-slots'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { SettingsScopeBinder } from '@shres-code/shres-code-client-ui-settings/client'
import { apply, inject } from '@shres-code/shres-code-client-ui-settings-shield/client'
import { ShieldSection } from '../src/client/ShieldSection.tsx'
import type { ShieldSectionInjected } from '../src/client/ShieldSection.tsx'

usePinnedBrowserLanguages('en-US')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const snapshot = vi.fn(async () => ({ ok: true as const, value: { status: { active: false, reason: 'engine-missing' as const }, stats: { cwd: null, screened: 0, observed: 0, asked: 0, askedGranted: 0, askedDenied: 0, blocked: 0, byChannel: {}, recent: [] } } }))
  const remote = new TestRemote(ctx)
  Object.assign(remote, { shield: { snapshot } })
  ctx.provide('remote.shield', { snapshot })
  ctx.provide('connection', {
    isLoopback: true,
    api: {
      settings: { describe: vi.fn(() => Promise.resolve({ rpcId: 's', result: { ok: false, error: {} } })) },
    },
  } as never)
  await ctx.plugin(SettingsScopeBinder).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, snapshot }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-shield apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'remote', 'remote.shield'])
  })

  it('registers the Shield nav entry', async () => {
    const { ctx, slots, snapshot } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ShieldSection)
    expect(entry.options).toMatchObject({ id: 'shield', order: 12 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Shield')
    expect(snapshot).not.toHaveBeenCalled()
    const injected = (entry.inject as unknown as () => ShieldSectionInjected)()
    await expect(injected.loadSnapshot('s-current')).resolves.toMatchObject({ stats: { screened: 0 } })
    expect(snapshot).toHaveBeenCalledWith('s-current')
    snapshot.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } } as never)
    await expect(injected.loadSnapshot()).rejects.toThrow('shield.snapshot failed: REMOTE_ERROR: unavailable')
  })

  it('unregisters the section with the fiber', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('settings.section')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
