/**
 * ui-model-routing browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared `conversation.input.modelRouting` single seat; the
 * injected face reports availability per session, executes /route on|off,
 * folding admission outcomes into null (admitted) or a user-visible failure
 * line, and submits the routing-idle restore through the session's
 * model-selection directory — the same path the composer picker uses — folding a
 * refusal or an absent selection surface into a failure line. The plugin also
 * lists the Routing view in the `conversation.view` slot while the
 * `model-router` settings scope is loading or ready, unlists it when the scope
 * reports the namespace unavailable, and lists it again when it returns; the
 * view's face reads the `modelRouting` decision and gate Remotes for its own
 * session. One judgment engine source, read from the `judgmentEngines`
 * Remote and refreshed on each `judgment/engines-updated` announcement, feeds
 * both surfaces. Teardown empties the seat and the view list and stops the
 * source (HMR safety).
 */
import { Context } from '@shres-code/cordis'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import type { SessionId, SubagentAddress } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { RoutingChip } from '../src/client/RoutingChip.tsx'
import type { RoutingChipInjected, RoutingViewInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { RoutingView } from '../src/client/view/RoutingView.tsx'
import { engines } from './fixtures/engines.client.ts'
import { apply as nodeApply } from '../src/index.ts'

const SID = 's-routing' as SessionId
const CHILD = 's-routing-child' as SessionId
const SEAT = 's-routing-seat' as SessionId

const STRONG = { provider: 'deepseek', model: 'deepseek-v4.1' }

type ScopeStatus = 'loading' | 'ready' | 'unavailable'

/** A controllable `model-router` settings scope and the binder that serves it. */
function routerScope(status: ScopeStatus) {
  const store = createSnapshotStore<{ status: ScopeStatus }>({ status })
  const bind = vi.fn((_spec: { namespace: string }) => ({
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => store.subscribe(listener),
  }))
  return { bind, set: (next: ScopeStatus) => { store.set({ status: next }) } }
}

async function bench(options: { directories?: boolean; scope?: ScopeStatus } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.modelRouting': { kind: 'single', scope: 'session' },
      'conversation.view': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  const routingRemote = {
    decision: vi.fn((_sessionId: SessionId, seq: number) => Promise.resolve<unknown>({ ok: true, value: { seq } })),
    gate: vi.fn(() => Promise.resolve<unknown>({ ok: true, value: { downgradeThreshold: 0.8 } })),
  }
  const enginesRemote = { snapshot: vi.fn(() => Promise.resolve<unknown>({ ok: true, value: engines('laya') })) }
  const listeners = new Map<string, () => void>()
  const off = vi.fn()
  const $on = vi.fn((event: string, listener: () => void) => {
    listeners.set(event, listener)
    return off
  })
  ctx.provide('remote', { commands: commandsRemote, modelRouting: routingRemote, judgmentEngines: enginesRemote, $on })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('remote.modelRouting', routingRemote)
  ctx.provide('remote.judgmentEngines', enginesRemote)
  const scope = routerScope(options.scope ?? 'ready')
  ctx.provide('settingsScope', { bind: scope.bind })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', {
    subagentAddress: (id: SessionId): SubagentAddress | undefined =>
      id === CHILD ? { parentSessionId: SID, childSessionId: CHILD, mode: 'continuable' } : undefined,
    // A Team seat: delegated, reached through no subagent address.
    list: { getSnapshot: () => ({ byId: { [SEAT]: { origin: 'subagent' } } }), subscribe: () => () => {} },
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
  return { ctx, slots, execute, select, routingRemote, scope, enginesRemote, listeners, off }
}

describe('ui-model-routing browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual([
      'slots', 'sessions', 'remote', 'remote.commands', 'remote.modelRouting', 'remote.judgmentEngines', 'locale', 'settingsScope',
    ])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the routing seat', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const enginesRemote = { snapshot: () => new Promise(() => {}) }
    ctx.provide('remote', { commands: {}, modelRouting: {}, judgmentEngines: enginesRemote, $on: () => () => {} })
    ctx.provide('remote.commands', {})
    ctx.provide('remote.modelRouting', {})
    ctx.provide('remote.judgmentEngines', enginesRemote)
    ctx.provide('settingsScope', { bind: routerScope('ready').bind })
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { subagentAddress: () => undefined, list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } })
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
    // A Team seat is a delegated child the router does not adopt.
    expect(seat(SEAT).available).toBe(false)

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.modelRouting')).toHaveLength(0)
  })

  it('lists the Routing view after Chat and Trajectory, reads its own session, and unlists it on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.scope.bind).toHaveBeenCalledWith({ namespace: 'model-router' })
    const entry = b.slots.entries('conversation.view')[0]!
    expect(entry.component).toBe(RoutingView)
    expect(entry.options.id).toBe('routing')
    expect(entry.options.order).toBe(20)
    const label = entry.options.label
    expect(typeof label === 'function' ? label() : label).toBe('Routing')
    const face = entry.inject as unknown as (id: SessionId) => RoutingViewInjected
    expect(face(SID).available).toBe(true)
    expect(face(CHILD).available).toBe(false)
    expect(face(SEAT).available).toBe(false)
    await expect(face(SID).loadDecision(1037)).resolves.toEqual({ seq: 1037 })
    expect(b.routingRemote.decision).toHaveBeenCalledWith(SID, 1037)
    await expect(face(SID).loadGate()).resolves.toEqual({ downgradeThreshold: 0.8 })
    expect(b.routingRemote.gate).toHaveBeenCalledTimes(1)
    expect(face(SID).hooks.routerSettings.getSnapshot().status).toBe('ready')
    // No client service opens a Settings section yet, so the view names it as text.
    expect(face(SID).openRoutingSettings).toBeUndefined()
    // A host failure reaches the view as a rejection naming its message and code.
    b.routingRemote.decision.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'seq 9 is not a routing decision', details: {} } })
    await expect(face(SID).loadDecision(9)).rejects.toThrow('seq 9 is not a routing decision (internal)')

    await fiber.dispose()
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
    expect(b.slots.entries('conversation.input.modelRouting')).toHaveLength(0)
  })

  it('lists the Routing view while the router scope is loading or ready, and not when it is unavailable', async () => {
    const absent = await bench({ scope: 'unavailable' })
    const unlisted = absent.ctx.plugin({ inject: [...inject], apply })
    await unlisted.await()
    expect(absent.slots.entries('conversation.view')).toHaveLength(0)
    await unlisted.dispose()

    const unknown = await bench({ scope: 'loading' })
    const optimistic = unknown.ctx.plugin({ inject: [...inject], apply })
    await optimistic.await()
    // Unknown is not absent: the row stays, so a persisted selection keeps its view.
    expect(unknown.slots.entries('conversation.view')).toHaveLength(1)
    await optimistic.dispose()
    expect(unknown.slots.entries('conversation.view')).toHaveLength(0)
  })

  it('unlists the view when the router goes away and lists it again when it returns', async () => {
    const b = await bench({ scope: 'loading' })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    b.scope.set('ready')
    expect(b.slots.entries('conversation.view')).toHaveLength(1)
    b.scope.set('unavailable')
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
    b.scope.set('unavailable')
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
    b.scope.set('ready')
    expect(b.slots.entries('conversation.view')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
    // A scope change after unload lists nothing.
    b.scope.set('loading')
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
  })

  it('feeds both surfaces one engine source, refreshed on each announcement and stopped on unload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const view = (b.slots.entries('conversation.view')[0]!.inject as unknown as (id: SessionId) => RoutingViewInjected)(SID)
    const chip = (b.slots.entries('conversation.input.modelRouting')[0]!.inject as unknown as (id: SessionId) => RoutingChipInjected)(SID)
    expect(view.hooks.routingEngine).toBe(chip.hooks.routingEngine)
    await vi.waitFor(() => { expect(chip.hooks.routingEngine.getSnapshot()).toEqual({ kind: 'ready', snapshot: engines('laya') }) })
    expect(b.enginesRemote.snapshot).toHaveBeenCalledTimes(1)

    b.enginesRemote.snapshot.mockResolvedValueOnce({ ok: true, value: engines('typesafe') })
    b.listeners.get('judgment/engines-updated')!()
    await vi.waitFor(() => { expect(chip.hooks.routingEngine.getSnapshot()).toEqual({ kind: 'ready', snapshot: engines('typesafe') }) })
    await expect(chip.loadGate()).resolves.toEqual({ downgradeThreshold: 0.8 })

    await fiber.dispose()
    expect(b.off).toHaveBeenCalledTimes(1)
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
