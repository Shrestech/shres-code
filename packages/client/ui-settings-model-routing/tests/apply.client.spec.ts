/** Model routing settings registration: availability gating, invalidations, and HMR disposal. */
import { Context } from '@shres-code/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@shres-code/shres-code-client-ui-slots'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { ModelRoutingSectionInjected } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { ModelRoutingSection } from '../src/client/ModelRoutingSection.tsx'
import { LAYA_VIEW, remoteFail, remoteOk, scripted, snapshot } from './fixtures.client.ts'

usePinnedBrowserLanguages('en-US')

/** A client root with the slot registry, locale, remote double, the three Remote namespaces, and a scripted settings wire. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const remote = new TestRemote(ctx)
  const s = scripted()
  // The generated namespaces hang off `ctx.remote` and are also inject keys of their own.
  const judgmentEngines = { snapshot: s.remotes.snapshot }
  const laya = { gatewayStatus: s.remotes.layaStatus, installGateway: s.remotes.layaInstall, restartGateway: s.remotes.layaRestart }
  const modelRouting = { gate: s.remotes.gate, poolStatus: s.remotes.poolStatus }
  Object.assign(remote, { judgmentEngines, laya, modelRouting })
  ctx.provide('remote.judgmentEngines', judgmentEngines)
  ctx.provide('remote.laya', laya)
  ctx.provide('remote.modelRouting', modelRouting)
  ctx.provide('connection', { api: s.api, isLoopback: true } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const declare = (): (() => void) => slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  return { ctx, slots, remote, s, declare }
}

/** Let queued probes and reads settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('ui-settings-model-routing browser apply', () => {
  it('declares the services it binds, and its node half does nothing', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.judgmentEngines', 'remote.laya', 'remote.modelRouting'])
    nodeApply()
  })

  it('registers Model routing after Models once the Host serves the engine view', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()

    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ModelRoutingSection)
    expect(entry.options).toMatchObject({ id: 'model-routing', order: 10.5 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Model routing')
    expect(entry.locale).toBe('settings.modelRouting')
    const injected = entry.inject?.() as unknown as ModelRoutingSectionInjected
    expect(injected.hooks.snapshot).toBe(injected.controller.store)
    expect(b.s.describe).not.toHaveBeenCalled()
  })

  it('registers nothing while the Host composes no dispatcher, and registers once it does', async () => {
    const b = await bench()
    b.s.remotes.snapshot.mockResolvedValue(remoteFail('invocation-unavailable', 'no active Remote method exports this endpoint'))
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    b.s.remotes.snapshot.mockResolvedValue(remoteOk(snapshot()))
    b.remote.$dispatch('judgment/engines-updated', [])
    await settle()
    expect(b.slots.entries('settings.section')).toHaveLength(1)

    b.s.remotes.snapshot.mockResolvedValue(remoteFail('service-unavailable', 'gone'))
    b.ctx.emit('connection/reset')
    await settle()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
  })

  it('refreshes a loaded page on engine, judgment, model-router, adapter, and connection invalidations only', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    const injected = b.slots.entries('settings.section')[0]!.inject?.() as unknown as ModelRoutingSectionInjected
    await injected.controller.load()
    expect(injected.controller.store.getSnapshot()).toMatchObject({ status: 'ready', laya: LAYA_VIEW })
    const reads = (): number => b.s.describe.mock.calls.length
    const before = reads()

    b.remote.$dispatch('settings/document-updated', ['llm-pi-ai', 1])
    await settle()
    expect(reads()).toBe(before)
    b.remote.$dispatch('settings/document-updated', ['judgment', 2])
    await settle()
    b.remote.$dispatch('settings/document-updated', ['model-router', 3])
    await settle()
    b.remote.$dispatch('judgment/engines-updated', [])
    await settle()
    b.remote.$dispatch('llm/adapters-updated', [])
    await settle()
    b.ctx.emit('connection/reset')
    await settle()
    expect(reads()).toBe(before + 5)
  })

  it('withdraws the page and every listener when the plugin unloads (HMR), and registers again on reload', async () => {
    const b = await bench()
    b.declare()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await settle()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    const probes = b.s.remotes.snapshot.mock.calls.length

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    b.remote.$dispatch('judgment/engines-updated', [])
    b.ctx.emit('connection/reset')
    await settle()
    expect(b.s.remotes.snapshot.mock.calls.length).toBe(probes)

    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
  })

  it('follows the settings shell through a slot declaration collapse and re-declaration', async () => {
    const b = await bench()
    const undeclare = b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    undeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    b.declare()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
  })

  it('routes the page controller to the Remote namespaces', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    const { controller } = b.slots.entries('settings.section')[0]!.inject?.() as unknown as ModelRoutingSectionInjected
    await controller.load()
    await controller.runLaya('install')
    await controller.runLaya('restart')
    expect(b.s.remotes.layaStatus).toHaveBeenCalled()
    expect(b.s.remotes.layaInstall).toHaveBeenCalledTimes(1)
    expect(b.s.remotes.layaRestart).toHaveBeenCalledTimes(1)
    // The router's gate and pool status, and the model catalog, are read with the page.
    expect(b.s.remotes.gate).toHaveBeenCalled()
    expect(b.s.remotes.poolStatus).toHaveBeenCalled()
    expect(b.s.models).toHaveBeenCalled()
    expect(controller.store.getSnapshot()).toMatchObject({ gate: { downgradeThreshold: 0.8 }, pool: { candidates: [{ id: 'flash' }, { id: 'glm' }] } })
    void vi
  })
})
