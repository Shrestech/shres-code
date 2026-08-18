/**
 * ui-jspace browser half on a real SlotRegistry: the plugin occupies
 * conversation.input.left (chip) and conversation.input.dock order 11
 * (strip); the chip inject executes /j-space on|off; teardown empties
 * both seats (HMR safety).
 */
import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import type { SessionId } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { JSpaceChip } from '../src/client/JSpaceChip.tsx'
import { JSpaceDock } from '../src/client/JSpaceDock.tsx'
import type { JSpaceChipInjected, JSpaceDockInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import type { JSpaceSettings } from '../src/client/settings.ts'

const SID = 's-jspace' as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const host = stubSettingsScope<JSpaceSettings>()
  const bind = vi.fn(() => host.scope)
  ctx.provide('settingsScope', { bind })
  return { ctx, slots, execute, bind, host }
}

describe('ui-jspace browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'locale', 'settingsScope'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the left and dock seats', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('remote', { commands: {} })
    ctx.provide('remote.commands', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.input.left': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.input.dock')).toHaveLength(1)
  })

  it('registers the chip and dock, executes session commands, and unregisters on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.bind).toHaveBeenCalledWith({ namespace: 'jspace' })

    const chip = b.slots.entries('conversation.input.left')[0]!
    expect(chip.component).toBe(JSpaceChip)
    expect(chip.options).toMatchObject({ id: 'jspace', order: 0 })
    expect(chip.locale).toBe('jspace')
    const chipInjected = (chip.inject as unknown as (id: SessionId) => JSpaceChipInjected)(SID)
    expect(chipInjected.sessionId).toBe(SID)

    await expect(chipInjected.closeCard()).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/j-space off')
    await expect(chipInjected.openCard()).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/j-space on')

    b.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: {} },
    } as never)
    await expect(chipInjected.closeCard()).resolves.toBe('gone (session-not-found)')

    b.execute.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    await expect(chipInjected.openCard()).resolves.toBe('unknown command: /j-space on')

    const dock = b.slots.entries('conversation.input.dock')[0]!
    expect(dock.component).toBe(JSpaceDock)
    expect(dock.options).toMatchObject({ id: 'jspace', order: 11 })
    expect(dock.locale).toBe('jspace')
    const dockInjected = (dock.inject as unknown as (id: SessionId) => JSpaceDockInjected)(SID)
    expect(dockInjected.sessionId).toBe(SID)
    expect(dockInjected.hooks.jspaceSettings).toBe(b.host.scope)

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(b.slots.entries('conversation.input.dock')).toHaveLength(0)
  })
})
