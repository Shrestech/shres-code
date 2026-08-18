/** J-Space section registration and locale-following nav label. */

import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@shres-code/shres-code-client-ui-slots'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { SettingsScopeBinder } from '@shres-code/shres-code-client-ui-settings/client'
import { apply, inject } from '@shres-code/shres-code-client-ui-settings-jspace/client'
import { JSpaceSection } from '../src/client/JSpaceSection.tsx'
import type { JSpaceSectionInjected } from '../src/client/JSpaceSection.tsx'

usePinnedBrowserLanguages('en-US')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({ current: undefined }),
      subscribe: () => () => {},
    },
    binding: () => undefined,
  })
  new TestRemote(ctx)
  ctx.provide('connection', {
    isLoopback: true,
    api: {
      settings: { describe: vi.fn(() => Promise.resolve({ rpcId: 's', result: { ok: false, error: {} } })) },
    },
  } as never)
  await ctx.plugin(SettingsScopeBinder).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-jspace apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'sessions'])
  })

  it('registers the J-Space nav entry', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(JSpaceSection)
    expect(entry.options).toMatchObject({ id: 'jspace', order: 13 })
    expect(resolveSlotLabel(entry.options.label)).toBe('J-Space')
    const injected = (entry.inject as unknown as () => JSpaceSectionInjected)()
    expect(injected.t('nav')).toBe('J-Space')
    expect(injected.scope.getSnapshot().mode).toBe('host')
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
