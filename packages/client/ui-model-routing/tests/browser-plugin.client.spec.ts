/**
 * ui-model-routing browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared `conversation.input.modelRouting` single seat; the
 * injected face reports availability per session, executes /route on|off,
 * folding admission outcomes into null (admitted) or a user-visible failure
 * line, and submits the routing-idle restore through the session's
 * model-selection directory — the same path the composer picker uses — folding a
 * refusal or an absent selection surface into a failure line; teardown empties
 * the seat (HMR safety).
 */
import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import type { SessionId, SubagentAddress } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { RoutingChip } from '../src/client/RoutingChip.tsx'
import type { RoutingChipInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const SID = 's-routing' as SessionId
const CHILD = 's-routing-child' as SessionId

const STRONG = { provider: 'deepseek', model: 'deepseek-v4.1' }

async function bench(options: { directories?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'conversation.input.modelRouting': { kind: 'single', scope: 'session' } },
  } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', {
    subagentAddress: (id: SessionId): SubagentAddress | undefined =>
      id === CHILD ? { parentSessionId: SID, childSessionId: CHILD, mode: 'continuable' } : undefined,
  })
  const select = vi.fn((_selection: { provider: string; model: string }) => Promise.resolve())
  if (options.directories !== false) {
    ctx.provide('modelDirectories', {
      directoryFor: (id: SessionId) => {
        if (id !== SID) throw new Error(`ui-model-selection: session "${String(id)}" resolved no scope`)
        return { select }
      },
    })
  }
  return { ctx, slots, execute, select }
}

describe('ui-model-routing browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'sessions', 'remote', 'remote.commands', 'locale'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the routing seat', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('remote', { commands: {} })
    ctx.provide('remote.commands', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { subagentAddress: () => undefined })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.modelRouting')).toHaveLength(0)
    ctx.slots.register({
      name: 'root', children: { 'conversation.input.modelRouting': { kind: 'single', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.modelRouting')).toHaveLength(1)
  })

  it('registers the chip, switches the mode, and unregisters on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.input.modelRouting')[0]!
    expect(entry.component).toBe(RoutingChip)
    const seat = entry.inject as unknown as (id: SessionId) => RoutingChipInjected
    const injected = seat(SID)
    expect(injected.available).toBe(true)

    await expect(injected.setRouting(true)).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/route on')
    await expect(injected.setRouting(false)).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/route off')

    // Business failure folds to the composer-visible line: the generated method
    // reports the RPC failure in its error branch.
    b.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: {} },
    } as never)
    await expect(injected.setRouting(true)).resolves.toBe('gone (session-not-found)')

    // Unmatched admission (model-router not composed host-side) is also a failure line.
    b.execute.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    await expect(injected.setRouting(false)).resolves.toBe('unknown command: /route off')

    // An addressed subagent session gets no Agent-bound command channel.
    expect(seat(CHILD).available).toBe(false)

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.modelRouting')).toHaveLength(0)
  })

  it('restores the strong route through the session model-selection directory', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const seat = b.slots.entries('conversation.input.modelRouting')[0]!.inject as unknown as (
      id: SessionId,
    ) => RoutingChipInjected

    await expect(seat(SID).restoreStrong(STRONG)).resolves.toBeNull()
    expect(b.select).toHaveBeenCalledWith(STRONG)
    await fiber.dispose()
  })

  it('folds a refused selection and an unresolvable session scope into failure lines', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const seat = b.slots.entries('conversation.input.modelRouting')[0]!.inject as unknown as (
      id: SessionId,
    ) => RoutingChipInjected

    // The host refused the selection (route gone, model unavailable, image
    // policy): the directory rethrows what the wire reported.
    b.select.mockRejectedValueOnce(new Error('session.selectModel failed: model-unavailable: no images'))
    await expect(seat(SID).restoreStrong(STRONG)).resolves.toBe('session.selectModel failed: model-unavailable: no images')

    // A rejection that is not an Error still reaches the caller as text.
    b.select.mockRejectedValueOnce('socket closed')
    await expect(seat(SID).restoreStrong(STRONG)).resolves.toBe('socket closed')

    // A session with no live scope cannot resolve a directory at all.
    await expect(seat(CHILD).restoreStrong(STRONG)).resolves.toContain('resolved no scope')
    await fiber.dispose()
  })

  it('reports an absent model-selection surface instead of failing the gesture', async () => {
    const b = await bench({ directories: false })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const seat = b.slots.entries('conversation.input.modelRouting')[0]!.inject as unknown as (
      id: SessionId,
    ) => RoutingChipInjected

    await expect(seat(SID).restoreStrong(STRONG)).resolves.toBe('model selection is unavailable')
    await fiber.dispose()
  })
})
