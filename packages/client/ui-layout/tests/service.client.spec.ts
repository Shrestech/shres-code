/**
 * LayoutController behavior: the cross-plugin panel-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: attachPanels wiring, the panel actions and navigate
 * forwarding, the unwired fail-loud of the panel actions, a destination
 * recorded before attach, and re-attach overwriting a stale action set.
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@shres-code/shres-code-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@shres-code/shres-code-client-ui-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    navigate: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the three panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
  })

  it('forwards a full-page destination to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)
    service.navigate('model-routing')
    service.navigate(null)
    expect(panels.navigate).toHaveBeenNthCalledWith(1, 'model-routing')
    expect(panels.navigate).toHaveBeenNthCalledWith(2, null)
  })

  it('fails loud for a panel action before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
  })

  it('records the latest destination requested before attach and applies it after the attaching render', async () => {
    const service = new LayoutController()
    service.navigate('models')
    service.navigate('general')
    const panels = fakePanels()
    service.attachPanels(panels)
    expect(panels.navigate).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(panels.navigate).toHaveBeenCalledExactlyOnceWith('general')
    service.attachPanels(fakePanels())
    await Promise.resolve()
    expect(panels.navigate).toHaveBeenCalledTimes(1)
  })

  it('drops a recorded destination that null cleared or that a later request superseded', async () => {
    const cleared = new LayoutController()
    cleared.navigate('general')
    cleared.navigate(null)
    const idle = fakePanels()
    cleared.attachPanels(idle)
    await Promise.resolve()
    expect(idle.navigate).not.toHaveBeenCalled()

    const superseded = new LayoutController()
    superseded.navigate('general')
    const panels = fakePanels()
    superseded.attachPanels(panels)
    superseded.navigate('models')
    await Promise.resolve()
    expect(panels.navigate).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
