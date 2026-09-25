/** ctx.settingsPages: the settings-owned face that opens Settings at a registered section. */
import { Context } from '@shres-code/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@shres-code/shres-code-client-runtime/client'
import { LocaleRuntime } from '@shres-code/shres-code-client-locale/client'
import { usePinnedBrowserLanguages } from '@shres-code/shres-code-client-test-runtime'
import { apply, inject } from '@shres-code/shres-code-client-ui-settings-general/client'
import { LayoutController } from '@shres-code/shres-code-client-ui-layout/client'
import { createLayoutStore } from '@shres-code/shres-code-client-ui-layout/src/client/stores.ts'
import { SettingsPages } from '../src/client/settings-pages.ts'

usePinnedBrowserLanguages('en-US')

describe('SettingsPages', () => {
  function pages(declared: boolean, ids: string[]) {
    const ledger = { declared: vi.fn(() => declared), has: vi.fn((id: string) => ids.includes(id)) }
    const navigate = vi.fn()
    return { ledger, navigate, face: new SettingsPages(ledger, navigate) }
  }

  it('opens a registered section and rejects an unknown id by name without navigating', async () => {
    const { face, navigate } = pages(true, ['models'])
    await face.open('models')
    expect(navigate).toHaveBeenCalledWith('models')
    await expect(face.open('routing')).rejects.toThrow('settings: no Settings section "routing" is registered')
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('waits while settings.section is undeclared, then checks the id once flushed', async () => {
    const setup = pages(false, [])
    const known = setup.face.open('models')
    const unknown = setup.face.open('gone')
    await Promise.resolve()
    expect(setup.navigate).not.toHaveBeenCalled()
    setup.ledger.declared.mockReturnValue(true)
    setup.ledger.has.mockImplementation((id: string) => id === 'models')
    setup.face.flush()
    await known
    await expect(unknown).rejects.toThrow('"gone"')
    expect(setup.navigate).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('rejects the waiting calls and every later call once the face is withdrawn', async () => {
    const { face, navigate } = pages(false, [])
    const waiting = face.open('models')
    face.dispose()
    await expect(waiting).rejects.toThrow('settings: the Settings pages face was withdrawn before section "models" opened')
    face.flush()
    await expect(face.open('general')).rejects.toThrow('withdrawn before section "general" opened')
    expect(navigate).not.toHaveBeenCalled()
  })
})

const contexts: Context[] = []

/**
 * Register the frame's root entry with its shell.navigation seat, as ui-layout
 * does; the settings shell occupies it and declares settings.section under it.
 * @param slots - the client slot registry.
 * @returns the registration's disposer.
 */
function registerFrame(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'shell.navigation': { kind: 'single', scope: 'root' } },
  } as never, () => null)
}
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

/** A client root with slots, locale, a loopback-less connection, and a frame double providing ctx.layout. */
async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: {}, isLoopback: false } as never)
  const layout = { navigate: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() }
  ctx.provide('layout', layout)
  const slots = ctx.get('slots') as SlotRegistry
  const declareFrame = (): (() => void) => registerFrame(slots)
  /** A feature plugin registering one section once settings.section is declared. */
  const section = (id: string) => ctx.plugin({
    inject: ['slots'],
    apply: (inner: Context) => {
      inner.slots.inject('settings.section', () => inner.slots.register({ name: 'settings.section', id, order: 10, label: id }, () => null))
    },
  })
  return { ctx, slots, layout, declareFrame, section }
}

describe('ctx.settingsPages from the settings shell', () => {
  it('provides the face once ctx.layout exists, and opens a registered section through the frame', async () => {
    const b = await bench()
    b.declareFrame()
    await b.section('models')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    await b.ctx.settingsPages.open('models')
    await b.ctx.settingsPages.open('general')
    expect(b.layout.navigate.mock.calls).toEqual([['models'], ['general']])

    // The General section lists the settings.general.item ledger, ordered, and follows it.
    const general = b.slots.entries('settings.section').find(entry => entry.options.id === 'general')!
    type ItemsHook = { getSnapshot: () => readonly string[]; subscribe: (listener: () => void) => () => void }
    const items = (general.inject?.() as { hooks: { items: ItemsHook } }).hooks.items
    expect(items.getSnapshot()).toEqual([])
    const listener = vi.fn()
    const unsubscribe = items.subscribe(listener)
    b.slots.register({ name: 'settings.general.item', id: 'late', order: 2 }, () => null)
    b.slots.register({ name: 'settings.general.item', id: 'early', order: 1 }, () => null)
    b.slots.register({ name: 'settings.general.item', id: 'unordered' }, () => null)
    await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })
    const first = items.getSnapshot()
    expect(first).toEqual(['unordered', 'early', 'late'])
    expect(items.getSnapshot()).toBe(first)
    unsubscribe()
  })

  it('throws naming an unknown id once settings.section is declared', async () => {
    const b = await bench()
    b.declareFrame()
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    await expect(b.ctx.settingsPages.open('model-routing')).rejects.toThrow('settings: no Settings section "model-routing" is registered')
    expect(b.layout.navigate).not.toHaveBeenCalled()
  })

  it('waits for the settings.section declaration, then opens a section registered with it', async () => {
    const b = await bench()
    await b.section('models')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const opening = b.ctx.settingsPages.open('models')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.layout.navigate).not.toHaveBeenCalled()

    b.declareFrame()
    await opening
    expect(b.layout.navigate).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('withdraws the face and rejects a waiting call when the settings shell unloads (HMR), and provides it again on reload', async () => {
    const b = await bench()
    const shell = b.ctx.plugin({ inject: [...inject], apply })
    await shell.await()
    const waiting = b.ctx.settingsPages.open('models')

    await shell.dispose()
    await expect(waiting).rejects.toThrow('withdrawn before section "models" opened')
    await vi.waitFor(() => { expect(b.ctx.get('settingsPages')).toBeUndefined() })

    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.declareFrame()
    await b.ctx.settingsPages.open('general')
    expect(b.layout.navigate).toHaveBeenCalledExactlyOnceWith('general')
  })
})

describe('ctx.settingsPages with the real frame navigation', () => {
  /**
   * A client root whose ctx.layout is the real LayoutController, before the
   * frame's first render attached its store actions.
   */
  async function frameBench() {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('connection', { api: {}, isLoopback: false } as never)
    const layout = new LayoutController()
    ctx.provide('layout', layout)
    const slots = ctx.get('slots') as SlotRegistry

    /** The frame's first render: the root store instance hands its actions to ctx.layout. */
    const renderFrame = () => {
      const frame = createLayoutStore().create()
      layout.attachPanels(frame.actions)
      return frame.store
    }
    return { ctx, registerFrame: () => registerFrame(slots), renderFrame }
  }

  it('resolves an open made before the frame rendered, and the frame lands on the section once it renders', async () => {
    const b = await frameBench()
    b.registerFrame()
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    await b.ctx.settingsPages.open('general')
    const store = b.renderFrame()
    expect(store.getSnapshot().page).toBeNull()
    await Promise.resolve()
    expect(store.getSnapshot().page).toBe('general')
  })

  it('resolves an open that waited for settings.section while the frame had not rendered', async () => {
    const b = await frameBench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const opening = b.ctx.settingsPages.open('general')

    b.registerFrame()
    await opening
    const store = b.renderFrame()
    await Promise.resolve()
    expect(store.getSnapshot().page).toBe('general')
  })
})
