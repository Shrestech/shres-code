/**
 * Shield settings browser half: slot registration and the loading mark skip.
 */
// @vitest-environment jsdom
import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { stubSettingsScope, usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { resolveSlotLabel } from '@shres-code/shres-code-client-ui-slots'
import type { ShieldSnapshot } from '@shres-code/shres-code-api-remotes/client'
import { apply, inject, SHIELD_SETTINGS_NAMESPACE } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { ShieldSection, type ShieldSettings } from '../src/client/ShieldSection.tsx'

/** Wire result of `remote.shield.snapshot` — success and engine-missing both occur in these tests. */
type ShieldSnapshotResult =
  | { readonly ok: true; readonly value: ShieldSnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

usePinnedBrowserLanguages('en-US')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const snapshot = vi.fn(async (_sessionId?: string): Promise<ShieldSnapshotResult> => ({
    ok: true,
    value: {
      status: { active: true, reason: 'active' },
      stats: {
        cwd: null,
        screened: 0,
        observed: 0,
        asked: 0,
        askedGranted: 0,
        askedDenied: 0,
        blocked: 0,
        byChannel: {},
        byRule: {},
        otherRules: { observed: 0, asked: 0, blocked: 0 },
        recent: [],
      },
    },
  }))
  ctx.provide('remote', { shield: { snapshot } })
  ctx.provide('remote.shield', { snapshot })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const host = stubSettingsScope<ShieldSettings>()
  ctx.provide('settingsScope', { bind: vi.fn(() => host.scope) })
  return { ctx, slots, host, snapshot }
}

describe('ui-settings-shield browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'remote', 'remote.shield'])
    expect(SHIELD_SETTINGS_NAMESPACE).toBe('shres-shield')
  })

  it('node-half apply is an intentional no-op', () => {
    nodeApply()
  })

  it('skips the product mark while the host snapshot is loading, then publishes once ready', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')[0]?.component).toBe(ShieldSection)
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBeTruthy()
    const loadSnapshot = b.slots.entries('settings.section')[0]?.inject?.().loadSnapshot
    if (typeof loadSnapshot !== 'function') {
      expect.fail('settings.section inject is missing loadSnapshot')
    }
    await expect(loadSnapshot()).resolves.toMatchObject({ status: { active: true } })
    b.snapshot.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: 'down' },
    })
    await expect(loadSnapshot()).rejects.toThrow(/shield.snapshot failed/)
    expect(document.documentElement.dataset.shresShield).toBeUndefined()
    b.host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true, posture: 'ask' },
      user: {},
    })
    expect(document.documentElement.dataset.shresShield).toBe('on')
    b.host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: false, posture: 'ask' },
      user: {},
    })
    expect(document.documentElement.dataset.shresShield).toBe('off')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
  })
})
