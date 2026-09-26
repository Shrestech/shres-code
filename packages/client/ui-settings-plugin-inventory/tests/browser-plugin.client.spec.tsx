// @vitest-environment jsdom
import { Context, Service } from '@shres-code/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { resolveSlotLabel } from '@shres-code/shres-code-client-ui-slots'
import { usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'
import { PluginManageSettingsTab } from '../src/client/PluginManageSettingsTab.tsx'
import type { PluginManageSettingsTabInjected } from '../src/client/PluginManageSettingsTab.tsx'
import type { PluginConfirmToken, PluginGestureToken } from '@shres-code/shres-code-api-remotes/client'

usePinnedBrowserLanguages('en-US')
afterEach(cleanup)

const EMPTY = { entries: [] }
type ListResult =
  | { readonly ok: true; readonly value: typeof EMPTY }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const EMPTY_STATUS = { mutations: 'enabled', plugins: [], skills: [] }
type StatusResult =
  | { readonly ok: true; readonly value: typeof EMPTY_STATUS }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  ctx.provide('remote.pluginInventory', { list })
  const admin = {
    status: vi.fn<() => Promise<StatusResult>>()
      .mockResolvedValue({ ok: true, value: EMPTY_STATUS }),
    begin: vi.fn().mockResolvedValue({ ok: true, value: { token: 'tok', expiresAt: '2026-01-01T00:02:00Z' } }),
    stageInstall: vi.fn().mockResolvedValue(ok({
      kind: 'parked',
      transactionId: 'tx',
      preview: { spec: '/tmp/hello', name: '@f/hello', version: '1.0.0', source: 'path', clientHalf: false, addedPackages: [] },
      confirmToken: 'confirm',
    })),
    confirm: vi.fn().mockResolvedValue(ok({ kind: 'committed', name: '@f/hello', version: '1.0.0', readiness: 'restart-required' })),
    cancel: vi.fn().mockResolvedValue(ok({ filesRestored: true, reinstall: 'skipped' })),
    removePlugin: vi.fn().mockResolvedValue(ok({ kind: 'removed', pnpm: 'ok' })),
    skillAdd: vi.fn().mockResolvedValue(ok({ kind: 'installed', name: 'greet', path: '/g', digest: 'd' })),
    skillRemove: vi.fn().mockResolvedValue(ok({ kind: 'removed' })),
  }
  ctx.provide('remote.pluginAdmin', admin)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, admin }
}

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

function entryById(slots: SlotRegistry, id: string) {
  return slots.entries('settings.plugins.tab').find(entry => entry.options.id === id)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('declares only the services used by the Settings Remote contributions', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginAdmin'])
  })

  it('registers localized tabs without reading either Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const inventory = entryById(b.slots, 'all')!
    expect(inventory.component).toBe(PluginInventorySettingsTab)
    expect(inventory.options).toMatchObject({ id: 'all', order: 10 })
    expect(inventory.locale).toBe(NS)
    expect(resolveSlotLabel(inventory.options.label)).toBe('Plugin list')

    const manage = entryById(b.slots, 'manage')!
    expect(manage.component).toBe(PluginManageSettingsTab)
    expect(manage.options).toMatchObject({ id: 'manage', order: 20 })
    expect(manage.locale).toBe(NS)
    expect(resolveSlotLabel(manage.options.label)).toBe('Manage')

    expect(b.list).not.toHaveBeenCalled()
    expect(b.admin.status).not.toHaveBeenCalled()

    const listFace = (inventory.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await expect(listFace.list()).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(listFace.list()).rejects.toThrow('pluginInventory.list failed: REMOTE_ERROR: unavailable')

    const manageFace = (manage.inject as unknown as () => PluginManageSettingsTabInjected)()
    await expect(manageFace.status()).resolves.toEqual(EMPTY_STATUS)
    expect(b.admin.status).toHaveBeenCalledOnce()
    b.admin.status.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'down' } })
    await expect(manageFace.status()).rejects.toThrow('pluginAdmin.status failed: REMOTE_ERROR: down')
    await b.ctx.fiber.dispose()
  })

  it('installs and removes every gesture-gated operation through the receipts', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const manage = entryById(b.slots, 'manage')!
    const face = (manage.inject as unknown as () => PluginManageSettingsTabInjected)()

    const grant = await face.begin('install', '/tmp/hello')
    expect(grant).toEqual({ token: 'tok', expiresAt: '2026-01-01T00:02:00Z' })
    expect(b.admin.begin).toHaveBeenCalledWith({ verb: 'install', target: '/tmp/hello' })
    await expect(face.install(grant.token, '/tmp/hello')).resolves.toMatchObject({ kind: 'parked' })
    await expect(face.confirm('confirm' as PluginConfirmToken)).resolves.toMatchObject({ kind: 'committed' })
    await expect(face.cancel('confirm' as PluginConfirmToken)).resolves.toMatchObject({ reinstall: 'skipped' })
    await expect(face.remove('tok' as PluginGestureToken, '@f/hello')).resolves.toMatchObject({ kind: 'removed' })
    await expect(face.skillAdd('tok' as PluginGestureToken, '/g')).resolves.toMatchObject({ kind: 'installed' })
    await expect(face.skillRemove('tok' as PluginGestureToken, 'greet')).resolves.toMatchObject({ kind: 'removed' })
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(2) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entryById(b.slots, 'all')!.options.label)).toBe('Plugin list')
    expect(resolveSlotLabel(entryById(b.slots, 'manage')!.options.label)).toBe('Manage')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(entryById(b.slots, 'all')?.component).toBe(PluginInventorySettingsTab)
      expect(entryById(b.slots, 'manage')?.component).toBe(PluginManageSettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'xx', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
