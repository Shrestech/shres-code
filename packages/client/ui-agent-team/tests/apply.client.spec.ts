/**
 * ui-agent-team plugin halves: the browser entry's dictionary and Activity-slot
 * registrations against the real SlotRegistry (fiber teardown proves removal),
 * the injected roster load, the inert node entry, and the invariant companion.
 */
import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { stubSettingsScope } from '@shres-code/shres-code-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@shres-code/shres-code-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as TeamInvariant from '../src/invariant.ts'
import { en, NS } from '../src/client/locales.ts'
import type { TeamActionInjected } from '../src/client/TeamAction.tsx'

/** Slot ledger reader: entry ids currently registered in the Activity list. */
function activityEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.activity')
    .map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree that declares the Activity list. */
async function bench(view = vi.fn()) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.activity': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const refreshSubagents = vi.fn()
  const openSubagent = vi.fn()
  ctx.provide('sessions', { refreshSubagents, openSubagent })
  ctx.provide('connection', {
    api: { agentTeams: { view } },
    isLoopback: false,
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, view, refreshSubagents, openSubagent }
}

describe('ui-agent-team browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'connection'])
  })

  it('registers the Activity contribution, and fiber teardown removes it', async () => {
    const { ctx, fiber } = await bench()
    expect(activityEntryIds(ctx)).toContain('agent-team')
    await fiber.dispose()
    expect(activityEntryIds(ctx)).not.toContain('agent-team')
  })

  it('registers the dictionary under its own namespace and releases it with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('teamAction')).toBe(en.teamAction)
    await fiber.dispose()
    expect(translate('teamAction')).not.toBe(en.teamAction)
  })

  it('unwraps a successful roster view and throws on a failed call', async () => {
    const view = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, value: { sessionId: 'lead', isTeam: true, members: [] } } })
      .mockResolvedValueOnce({ result: { ok: false, error: { message: 'view failed' } } })
    const { ctx, refreshSubagents, openSubagent } = await bench(view)
    const entry = ctx.slots.entries('conversation.session.activity')[0]!
    const injected = (entry.inject as unknown as () => TeamActionInjected)()
    await expect(injected.load('lead' as never)).resolves.toEqual({
      sessionId: 'lead',
      isTeam: true,
      members: [],
    })
    await expect(injected.load('lead' as never)).rejects.toThrow(/view failed/)
    injected.openTeammate('lead' as never, { id: 'aegis-child' } as never)
    expect(refreshSubagents).toHaveBeenCalledWith('lead')
    expect(openSubagent).toHaveBeenCalledWith({
      parentSessionId: 'lead',
      childSessionId: 'aegis-child',
      mode: 'continuable',
    })
    await ctx.fiber.dispose()
  })
})

describe('ui-agent-team node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})

describe('ui-agent-team invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(TeamInvariant)
    await fiber.await()
    expect(TeamInvariant.name).toBe('client-ui-agent-team-invariant')
    expect(TeamInvariant.inject).toEqual(['invariants'])
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
