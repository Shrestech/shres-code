import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, defineStore, shallowEqual } from '../src/client/contract/store.ts'

interface State {
  a: { n: number }
  b: { list: string[] }
}

const init = (): State => ({ a: { n: 1 }, b: { list: ['x'] } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSnapshotStore', () => {
  it('applies update through a draft and preserves untouched branch references', () => {
    const store = createSnapshotStore(init())
    const before = store.getSnapshot()
    store.update((d) => { d.a.n = 2 })
    const after = store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.a.n).toBe(2)
    expect(after.b).toBe(before.b)
  })

  it('notifies synchronously per update by default', () => {
    const store = createSnapshotStore(init())
    const seen: number[] = []
    store.subscribe(() => { seen.push(store.getSnapshot().a.n) })
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    expect(seen).toEqual([2, 3])
  })

  it('coalesces a frame of updates into one notification in raf mode', () => {
    const frame: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.push(cb)
      return frame.length
    })
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    store.update((d) => { d.b.list.push('y') })
    expect(spy).not.toHaveBeenCalled()
    expect(frame).toHaveLength(1)
    frame.shift()!(0)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().a.n).toBe(3)
    // Next frame batches independently.
    store.update((d) => { d.a.n = 4 })
    expect(frame).toHaveLength(1)
    frame.shift()!(0)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('falls back to microtask batching in raf mode without requestAnimationFrame', async () => {
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    expect(spy).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes raf-mode listeners', () => {
    const frame: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.push(cb)
      return frame.length
    })
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    const off = store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    off()
    frame.shift()!(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('replaces state wholesale via set and freezes it outside production', () => {
    const store = createSnapshotStore(init())
    const next = init()
    store.set(next)
    expect(store.getSnapshot()).toBe(next)
    expect(() => { (store.getSnapshot().a).n = 9 }).toThrow()
  })

  it('freezes update produce output outside production (immer dev freeze)', () => {
    const store = createSnapshotStore(init())
    store.update((d) => { d.a.n = 2 })
    expect(() => { (store.getSnapshot().a).n = 9 }).toThrow()
  })

  it('rehydrates primitive state whole, not spread into index keys', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const store = createSnapshotStore<string>('', { persist: { name: 'spec-draft' } })
    store.set('hello')
    const revived = createSnapshotStore<string>('', { persist: { name: 'spec-draft' } })
    expect(revived.getSnapshot()).toBe('hello')
  })

  it('persists to localStorage under the given name and rehydrates', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const store = createSnapshotStore(init(), { persist: { name: 'spec-store' } })
    store.update((d) => { d.a.n = 42 })
    expect(backing.has('spec-store')).toBe(true)
    const revived = createSnapshotStore(init(), { persist: { name: 'spec-store' } })
    expect(revived.getSnapshot().a.n).toBe(42)
  })

  it('leaves transient fields out of what it writes and restores them from init', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const fresh = () => ({ draft: '', open: false })
    const store = createSnapshotStore(fresh(), { persist: { name: 'spec-transient', transient: ['open'] } })
    store.update((d) => {
      d.draft = 'kept'
      d.open = true
    })
    expect(JSON.parse(backing.get('spec-transient')!)).toEqual({ draft: 'kept' })
    // A value written before the field was transient is restored from init too.
    backing.set('spec-transient', JSON.stringify({ draft: 'kept', open: true }))
    const revived = createSnapshotStore(fresh(), { persist: { name: 'spec-transient', transient: ['open'] } })
    expect(revived.getSnapshot()).toEqual({ draft: 'kept', open: false })
    // A persisted primitive, from a store that once had an object state, is restored as written.
    backing.set('spec-transient', JSON.stringify('legacy text'))
    expect(createSnapshotStore(fresh(), { persist: { name: 'spec-transient', transient: ['open'] } }).getSnapshot()).toBe('legacy text')
  })

  it('fails loud for a transient field the initial state does not have at the top level', () => {
    expect(() => createSnapshotStore({ draft: '' }, { persist: { name: 'spec-typo', transient: ['opne'] } }))
      .toThrow("snapshot store 'spec-typo': transient field 'opne' is not a top-level field of the initial state")
    expect(() => createSnapshotStore({ panel: { open: false } }, { persist: { name: 'spec-nested', transient: ['panel.open'] } }))
      .toThrow("transient field 'panel.open'")
    expect(() => createSnapshotStore('', { persist: { name: 'spec-text', transient: ['open'] } }))
      .toThrow("snapshot store 'spec-text': transient field 'open'")
  })
})

describe('snapshot store persistence failures', () => {
  it('reports a value it cannot restore or write and keeps working, and skips freezing in production', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => { throw new Error('quota') },
      removeItem: () => {},
    })
    const store = createSnapshotStore({ draft: '', open: false }, { persist: { name: 'spec-broken', transient: ['open'] } })
    expect(store.getSnapshot()).toEqual({ draft: '', open: false })
    store.update((d) => { d.draft = 'still works' })
    expect(store.getSnapshot().draft).toBe('still works')
    expect(errors.mock.calls.map((call: unknown[]) => call[0] as string)).toEqual([
      "snapshot store 'spec-broken' rehydration failed:",
      "snapshot store 'spec-broken' persistence failed:",
    ])
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ draft: 'prod', open: true }), setItem: () => {}, removeItem: () => {} })
    vi.stubEnv('NODE_ENV', 'production')
    const production = createSnapshotStore({ draft: '', open: false }, { persist: { name: 'spec-prod', transient: ['open'] } })
    expect(production.getSnapshot()).toEqual({ draft: 'prod', open: false })
    expect(Object.isFrozen(production.getSnapshot())).toBe(false)
    vi.unstubAllEnvs()
  })
})

describe('defineStore', () => {
  const declare = () => defineStore({
    init: () => ({ selection: null as string | null, draft: '' }),
    actions: {
      select: (d, target: string) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      clearDraft: (d) => { d.draft = '' },
    },
  })

  it('create() yields a live instance: fresh init state, selector-visible action writes', () => {
    const inst = declare().create()
    expect(inst.store.getSnapshot()).toEqual({ selection: null, draft: '' })
    inst.actions.setDraft('hello')
    inst.actions.select('m1')
    expect(inst.store.getSnapshot()).toEqual({ selection: 'm1', draft: 'hello' })
    inst.actions.clearDraft()
    expect(inst.store.getSnapshot().draft).toBe('')
  })

  it('bakes draft-stripped actions that write through update (draft mutation, not replacement)', () => {
    const inst = declare().create()
    const before = inst.store.getSnapshot()
    inst.actions.setDraft('x')
    const after = inst.store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.selection).toBe(before.selection)   // untouched branch preserved (immer path)
  })

  it('creates independent instances per create() call (the handle is a spec, not a singleton)', () => {
    const handle = declare()
    const a = handle.create()
    const b = handle.create()
    a.actions.setDraft('only-a')
    expect(b.store.getSnapshot().draft).toBe('')
  })

  it('suffixes the persist key with the scope key: per-session persistence plus clearPersisted cleanup', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    handle.create('s1').actions.setDraft('one')
    handle.create('s2').actions.setDraft('two')
    handle.create().actions.setDraft('root')
    expect(JSON.parse(backing.get('spec.chat.s1')!)).toEqual({ draft: 'one' })
    expect(JSON.parse(backing.get('spec.chat.s2')!)).toEqual({ draft: 'two' })
    expect(JSON.parse(backing.get('spec.chat')!)).toEqual({ draft: 'root' })
    // Rehydration honors the same suffixed key.
    expect(handle.create('s1').store.getSnapshot().draft).toBe('one')
    // Scope-death cleanup removes exactly the suffixed key.
    handle.create('s1').clearPersisted()
    expect(backing.has('spec.chat.s1')).toBe(false)
    expect(backing.has('spec.chat.s2')).toBe(true)
    expect(backing.has('spec.chat')).toBe(true)
  })

  it('passes a declaration\'s transient fields to persistence', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const handle = defineStore({
      init: () => ({ draft: '', open: false }),
      persist: 'spec.popover',
      transient: ['open'],
      actions: { open: (d) => { d.open = true } },
    })
    const instance = handle.create('s1')
    const seen = vi.fn()
    const unsubscribe = instance.subscribe(seen)
    instance.actions.open()
    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(instance.getSnapshot()).toEqual({ draft: '', open: true })
    expect(JSON.parse(backing.get('spec.popover.s1')!)).toEqual({ draft: '' })
    // A reload restores the persisted fields and starts the transient one from init.
    backing.set('spec.popover.s2', JSON.stringify({ draft: 'kept', open: true }))
    expect(handle.create('s2').getSnapshot()).toEqual({ draft: 'kept', open: false })
  })

  it('rejects a declaration naming a transient field init() does not produce, naming it', () => {
    expect(() => defineStore({
      init: () => ({ draft: '', open: false }),
      persist: 'spec.typo',
      // @ts-expect-error -- the declaration admits only top-level fields of the state
      transient: ['opened'],
      actions: {},
    })).toThrow("snapshot store 'spec.typo': transient field 'opened' is not a top-level field of the initial state")
  })

  it('rejects transient fields on a declaration without a persist key', () => {
    expect(() => defineStore({
      init: () => ({ draft: '', open: false }),
      transient: ['open', 'draft'],
      actions: {},
    })).toThrow('defineStore: transient fields [open, draft] need a persist key')
  })

  it('clearPersisted is a no-op without a persist declaration or without storage', () => {
    const inst = declare().create('s1')   // no persist key declared
    expect(() => { inst.clearPersisted() }).not.toThrow()
    const persisting = defineStore({
      init: () => ({ n: 0 }),
      persist: 'spec.nostorage',
      actions: { inc: (d) => { d.n += 1 } },
    }).create()
    // jsdom-less lane: localStorage may exist here, so simulate its absence.
    vi.stubGlobal('localStorage', undefined)
    expect(() => { persisting.clearPersisted() }).not.toThrow()
  })

  it('swallows storage failures in clearPersisted (same non-fatal contract as persistence)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { throw new Error('quota / private mode') },
    })
    const inst = defineStore({
      init: () => ({ n: 0 }),
      persist: 'spec.throwing',
      actions: { inc: (d) => { d.n += 1 } },
    }).create()
    expect(() => { inst.clearPersisted() }).not.toThrow()
  })
})

describe('shallowEqual', () => {
  it('matches one-level-equal objects and rejects deeper drift', () => {
    const leaf = { deep: 1 }
    expect(shallowEqual({ x: 1, y: leaf }, { x: 1, y: leaf })).toBe(true)
    expect(shallowEqual({ x: 1, y: { deep: 1 } }, { x: 1, y: { deep: 1 } })).toBe(false)
    expect(shallowEqual([1, 2], [1, 2])).toBe(true)
    expect(shallowEqual([1, 2], [2, 1])).toBe(false)
  })
})
