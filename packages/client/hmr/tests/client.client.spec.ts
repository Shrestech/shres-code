// @vitest-environment jsdom
/** Client graph membership transitions through the browser HMR Loader seam. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import { ClientModuleSystem, type ShresWindow } from '@shres-code/shres-code-client-modules/client'
import { apply, inject } from '../src/client/index.ts'

const win = globalThis as ShresWindow

class FakeEventSource {
  static current: FakeEventSource | undefined
  private readonly listeners = new Set<(event: MessageEvent<string>) => void>()
  closed = false
  constructor(readonly url: string) { FakeEventSource.current = this }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'message' || typeof listener !== 'function') return
    this.listeners.add(listener)
  }
  emit(value: unknown): void {
    const event = { data: JSON.stringify(value) } as MessageEvent<string>
    for (const listener of this.listeners) listener(event)
  }
  close(): void { this.closed = true; this.listeners.clear() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete win.__ModuleLoader__
})

describe('client graph membership', () => {
  it('creates, removes, and re-enables a plugin entry from validated graph frames', async () => {
    const factories = new Map<string, () => Record<string, unknown>>()
    const modules = new ClientModuleSystem({
      modules: [],
      staticModules: {},
      loadBundle: async (url) => {
        const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
        const factory = id === undefined ? undefined : factories.get(id)
        if (id !== undefined && factory !== undefined) win.__ModuleLoader__?.load({ id, factory })
      },
    })
    factories.set('plugin-a', () => ({ apply: () => {} }))

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')

    source.emit({
      type: 'graph',
      graph: {
        rev: 'one',
        entries: [{ id: 'plugin-a', url: '/plugins/plugin-a/client.js?rev=1', rev: '1' }],
      },
    })
    await vi.waitFor(() => { expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain('plugin-a') })
    expect(modules.graphRows().map(row => row.id)).toEqual(['plugin-a'])

    source.emit({ type: 'graph', graph: { rev: 'two', entries: [] } })
    await vi.waitFor(() => { expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('plugin-a') })
    expect(modules.graphRows()).toEqual([])

    source.emit({
      type: 'graph',
      graph: {
        rev: 'three',
        entries: [{ id: 'plugin-a', url: '/plugins/plugin-a/client.js?rev=3', rev: '3' }],
      },
    })
    await vi.waitFor(() => { expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain('plugin-a') })
    expect(modules.graphRows().map(row => row.id)).toEqual(['plugin-a'])

    await hmr.dispose()
    await ctx.fiber.dispose()
  })

  it('removes an obsolete provider before creating its replacement', async () => {
    const factories = new Map<string, () => Record<string, unknown>>()
    const modules = new ClientModuleSystem({
      modules: [],
      staticModules: {},
      loadBundle: async (url) => {
        const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
        const factory = id === undefined ? undefined : factories.get(id)
        if (id !== undefined && factory !== undefined) win.__ModuleLoader__?.load({ id, factory })
      },
    })
    factories.set('provider-a', () => ({ apply: (context: Context) => { context.provide('shared', 'a') } }))
    factories.set('provider-b', () => ({ apply: (context: Context) => { context.provide('shared', 'b') } }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')

    source.emit({ type: 'graph', graph: { rev: 'provider-a', entries: [{ id: 'provider-a', url: '/plugins/provider-a/client.js?rev=1', rev: '1' }] } })
    await vi.waitFor(() => { expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain('provider-a') })
    source.emit({ type: 'graph', graph: { rev: 'provider-b', entries: [{ id: 'provider-b', url: '/plugins/provider-b/client.js?rev=1', rev: '1' }] } })
    await vi.waitFor(() => {
      const names = [...ctx.loader.entries()].map(entry => entry.options.name)
      expect(names).toContain('provider-b')
      expect(names).not.toContain('provider-a')
    })
    await hmr.dispose()
    await ctx.fiber.dispose()
  })

  it('drops malformed graph frames before touching the Loader', async () => {
    const modules = new ClientModuleSystem({ modules: [], staticModules: {} })
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')
    source.emit({ type: 'graph', graph: { rev: 7, entries: [] } })
    await Promise.resolve()
    expect([...ctx.loader.entries()]).toHaveLength(0)
    await hmr.dispose()
    await ctx.fiber.dispose()
  })

  it('retries a fiberless import when the host repeats the same graph', async () => {
    const factories = new Map<string, () => Record<string, unknown>>()
    let loadAttempts = 0
    let failed = false
    const modules = new ClientModuleSystem({
      modules: [],
      staticModules: {},
      loadBundle: async (url) => {
        loadAttempts += 1
        const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
        const factory = id === undefined ? undefined : factories.get(id)
        if (id === undefined || factory === undefined) {
          failed = true
          throw new Error('bundle unavailable')
        }
        win.__ModuleLoader__?.load({ id, factory })
      },
    })
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')
    const graph = {
      type: 'graph',
      graph: {
        rev: 'retry',
        entries: [{ id: 'late-plugin', url: '/plugins/late-plugin/client.js?rev=1', rev: '1' }],
      },
    }
    source.emit(graph)
    await vi.waitFor(() => {
      expect(loadAttempts).toBe(1)
      expect(failed).toBe(true)
      expect([...ctx.loader.entries()]).toHaveLength(0)
    })
    factories.set('late-plugin', () => ({ apply: () => {} }))
    source.emit(graph)
    await vi.waitFor(() => {
      expect(loadAttempts).toBe(2)
      expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain('late-plugin')
    })
    await hmr.dispose()
    await ctx.fiber.dispose()
  })

  it('retains a changed-row reload when the first replacement arrival fails', async () => {
    const factories = new Map<string, () => Record<string, unknown>>()
    let loadAttempts = 0
    let allowReplacement = false
    const modules = new ClientModuleSystem({
      modules: [],
      staticModules: {},
      loadBundle: async (url) => {
        loadAttempts += 1
        const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
        const factory = id === undefined ? undefined : factories.get(id)
        if (id === undefined || factory === undefined || (loadAttempts > 1 && !allowReplacement)) {
          throw new Error('replacement bundle unavailable')
        }
        win.__ModuleLoader__?.load({ id, factory })
      },
    })
    factories.set('replace-me', () => ({ apply: () => {} }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')
    source.emit({ type: 'graph', graph: { rev: 'one', entries: [{ id: 'replace-me', url: '/plugins/replace-me/client.js?rev=1', rev: '1' }] } })
    await vi.waitFor(() => { expect(loadAttempts).toBe(1) })
    source.emit({ type: 'graph', graph: { rev: 'two', entries: [{ id: 'replace-me', url: '/plugins/replace-me/client.js?rev=2', rev: '2' }] } })
    await vi.waitFor(() => { expect(loadAttempts).toBe(2) })
    allowReplacement = true
    source.emit({ type: 'graph', graph: { rev: 'two', entries: [{ id: 'replace-me', url: '/plugins/replace-me/client.js?rev=2', rev: '2' }] } })
    await vi.waitFor(() => {
      expect(loadAttempts).toBe(3)
      expect([...ctx.loader.entries()].map(entry => entry.options.name)).toContain('replace-me')
    })
    await hmr.dispose()
    await ctx.fiber.dispose()
  })

  it('loads new bytes when a changed row recreates a failed entry', async () => {
    let loadAttempts = 0
    let newRevisionApplied = false
    const oldFactory = () => ({ apply: () => { throw new Error('old revision rejected') } })
    const newFactory = () => ({ apply: () => { newRevisionApplied = true } })
    const modules = new ClientModuleSystem({
      modules: [],
      staticModules: {},
      loadBundle: async (url) => {
        loadAttempts += 1
        const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
        if (id === undefined) throw new Error('invalid plugin URL')
        win.__ModuleLoader__?.load({ id, factory: url.includes('rev=1') ? oldFactory : newFactory })
      },
    })
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')

    source.emit({ type: 'graph', graph: { rev: 'one', entries: [{ id: 'failed-row', url: '/plugins/failed-row/client.js?rev=1', rev: '1', immediately: true }] } })
    await vi.waitFor(() => {
      expect(loadAttempts).toBe(1)
      expect([...ctx.loader.entries()]).toHaveLength(0)
    })

    source.emit({ type: 'graph', graph: { rev: 'two', entries: [{ id: 'failed-row', url: '/plugins/failed-row/client.js?rev=2', rev: '2', immediately: true }] } })
    await vi.waitFor(() => {
      expect(loadAttempts).toBe(2)
      expect(newRevisionApplied).toBe(true)
      expect([...ctx.loader.entries()][0]?.fiber?.state).toBe(FiberState.ACTIVE)
    })
    await hmr.dispose()
    await ctx.fiber.dispose()
  })

  it('does not create a row after the HMR owner is disposed during arrival', async () => {
    let release: (() => void) | undefined
    let started = false
    let settled = false
    const modules = new ClientModuleSystem({
      modules: [],
      staticModules: {},
      loadBundle: async () => {
        started = true
        try {
          await new Promise<void>((resolve) => { release = resolve })
          throw new Error('bundle became unavailable')
        } finally {
          settled = true
        }
      },
    })
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const hmr = await ctx.plugin({ inject, apply })
    const source = FakeEventSource.current
    if (source === undefined) throw new Error('client HMR did not open EventSource')
    source.emit({
      type: 'graph',
      graph: {
        rev: 'arrival',
        entries: [{ id: 'pending-plugin', url: '/plugins/pending-plugin/client.js?rev=1', rev: '1', immediately: true }],
      },
    })
    await vi.waitFor(() => { expect(started).toBe(true) })
    await hmr.dispose()
    release?.()
    await vi.waitFor(() => { expect(settled).toBe(true) })
    expect([...ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('pending-plugin')
    await ctx.fiber.dispose()
  })

  it('continues a self-reload through the old fiber disposal', async () => {
    const factories = new Map<string, () => Record<string, unknown>>()
    const modules = new ClientModuleSystem({
      modules: [{ id: '@shres-code/shres-code-client-hmr', url: '/plugins/@shres-code/shres-code-client-hmr/client.js?rev=1', rev: '1' }],
      staticModules: {},
      loadBundle: async (url) => {
        const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
        const factory = id === undefined ? undefined : factories.get(id)
        if (id === undefined || factory === undefined) throw new Error('self bundle unavailable')
        win.__ModuleLoader__?.load({ id, factory })
      },
    })
    factories.set('@shres-code/shres-code-client-hmr', () => ({ inject, apply }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.internal = modules as never
    ctx.provide('modules', modules)
    vi.stubGlobal('EventSource', FakeEventSource)
    const id = await ctx.loader.create({ name: '@shres-code/shres-code-client-hmr' })
    await ctx.loader.await()
    const first = FakeEventSource.current
    if (first === undefined) throw new Error('self HMR did not open EventSource')
    first.emit({ type: 'rebuilt', id: '@shres-code/shres-code-client-hmr', rev: '2' })
    await vi.waitFor(() => {
      const current = FakeEventSource.current
      expect(current).not.toBe(first)
      expect(current?.closed).toBe(false)
      expect(ctx.loader.resolve(id).fiber?.state).toBe(FiberState.ACTIVE)
    })
    expect(first.closed).toBe(true)
    await ctx.loader.remove(id)
    await ctx.fiber.dispose()
  })
})
