// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SettingsRootComponentProps, SettingsSectionRow } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import { Menu } from '@shres-code/shres-code-client-ui-primitives'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mount({ rows = [
  { id: 'general', order: 0, label: 'Preferences' },
  { id: 'models', order: 10, label: 'Models & providers' },
  { id: 'teams', order: 15, label: 'Team members' },
  { id: 'plugins', order: 20, label: 'Plugins' },
  { id: 'agent-presets', order: 30, label: 'Agent presets' },
], onboardingActive = false }: { rows?: SettingsSectionRow[]; onboardingActive?: boolean } = {}) {
  let current = rows
  const listeners = new Set<() => void>()
  const renderSlot = vi.fn(((key: string, _owner: unknown, options?: { only?: string }) => {
    if (key === 'settings.section') return <div data-testid={`section-${options?.only}`} />
    if (key === 'settings.trigger') return 'Settings'
    if (key === 'settings.close') return 'Close'
    if (key === 'settings.action') return 'Open configuration file'
    return null
  }) as SettingsRootComponentProps['renderSlot'])
  function Harness() {
    const [page, navigate] = useState<string | null>(null)
    return <SettingsRoot page={page} navigate={navigate}
      t={key => (en as Record<string, string>)[key] ?? key}
      useWorkspaces={() => { throw new Error('unused') }}
      useSessions={((select: (state: unknown) => unknown) => select({ phase: 'ready', current: onboardingActive ? undefined : 's', byId: { s: { blank: false, cwd: '/work/shres-code' } } })) as never}
      useSections={(select) => {
        const [, force] = useState(0)
        useEffect(() => {
          const listener = () => { force(n => n + 1) }
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        }, [])
        return select(current)
      }}
      useOnboardingSteps={select => select([{ id: 'welcome', order: 0 }, { id: 'credentials', order: 1 }])}
      renderSlot={renderSlot} />
  }
  const view = render(<Harness />)
  return { view, renderSlot, listeners, bump: (next: SettingsSectionRow[]) => {
    act(() => { current = next; for (const listener of listeners) listener() })
  } }
}
const openSettings = () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })) }

describe('global destinations and settings', () => {
  it('opens full-page preferences and restores navigation focus on close', () => {
    mount()
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    openSettings()
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your workspace, your way.' }))
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }))
  })

  it('keeps teams and customization out of settings and returns to the workspace', () => {
    mount()
    openSettings()
    expect(within(screen.getByRole('region', { name: 'Settings' })).queryByRole('button', { name: 'Team members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Plugins' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    expect(screen.getByTestId('section-teams')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    expect(screen.getByTestId('section-plugins')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Agent presets' }))
    expect(screen.getByTestId('section-agent-presets')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('returns keyboard focus to the destination opener and leaves Workspace clicks focused', () => {
    mount()
    const teams = screen.getByRole('button', { name: 'Teams' })
    fireEvent.click(teams)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(teams)
    openSettings()
    const workspace = screen.getByRole('button', { name: 'Workspace' })
    workspace.focus()
    fireEvent.click(workspace)
    expect(document.activeElement).toBe(workspace)
  })

  it('finds sections by text and shows empty results without discarding the active page', () => {
    mount()
    openSettings()
    const search = screen.getByRole('searchbox', { name: 'Search settings…' })
    fireEvent.change(search, { target: { value: 'PROVIDER' } })
    expect(screen.queryByRole('button', { name: 'Preferences' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Models & providers' }))
    expect(screen.getByTestId('section-models')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe('No matching sections.')
    expect(screen.getByTestId('section-models')).toBeTruthy()
  })

  it('gives every shipped section an icon and returns home from the wordmark and the workspace button', () => {
    const { renderSlot } = mount({ rows: [
      { id: 'general', order: 0, label: 'Preferences' },
      { id: 'audio', order: 14, label: 'Voice & audio' },
      { id: 'jspace', order: 13, label: 'J-Space' },
      { id: 'shield', order: 12, label: 'Shield' },
    ] })
    openSettings()
    for (const name of ['Voice & audio', 'J-Space', 'Shield']) {
      expect(screen.getByRole('button', { name }).querySelector('svg')).not.toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: en['navigation.home'] }))
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    openSettings()
    fireEvent.click(screen.getByTitle('/work/shres-code'))
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    void renderSlot
  })

  it('returns focus to the trigger when Settings was opened from outside the shell', () => {
    const navigate = vi.fn()
    render(<SettingsRoot page="models" navigate={navigate}
      t={key => (en as Record<string, string>)[key] ?? key}
      useWorkspaces={() => { throw new Error('unused') }}
      useSessions={((select: (state: unknown) => unknown) => select({ phase: 'ready', current: undefined, byId: {} })) as never}
      useSections={select => select([{ id: 'models', order: 10, label: 'Models & providers' }])}
      useOnboardingSteps={select => select([])}
      renderSlot={(() => null) as never} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(navigate).toHaveBeenCalledWith(null)
  })

  it('completes an onboarding step once even when its completion is repeated', () => {
    const { renderSlot } = mount({ onboardingActive: true })
    const owner = renderSlot.mock.calls.findLast(([key]) => key === 'settings.onboarding')?.[1] as { stepId: string; complete: () => void }
    expect(owner.stepId).toBe('welcome')
    act(() => { owner.complete() })
    act(() => { owner.complete() })
    const next = renderSlot.mock.calls.findLast(([key]) => key === 'settings.onboarding')?.[1] as { stepId: string }
    expect(next.stepId).toBe('credentials')
  })

  it('lets a section open another section, which lists with its own icon', () => {
    const { renderSlot } = mount({ rows: [
      { id: 'general', order: 0, label: 'Preferences' },
      { id: 'models', order: 10, label: 'Models & providers' },
      { id: 'model-routing', order: 10.5, label: 'Model routing' },
    ] })
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Models & providers' }))
    const call = renderSlot.mock.calls.findLast(([key]) => key === 'settings.section')
    const owner = call?.[1] as { openSection: (id: string) => void }
    act(() => { owner.openSection('model-routing') })
    expect(screen.getByTestId('section-model-routing')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model routing' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Model routing' }).querySelector('svg')).not.toBeNull()
  })

  it('targets the appearance preference without duplicating its plugin', () => {
    const { renderSlot } = mount()
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    const call = renderSlot.mock.calls.findLast(([key]) => key === 'settings.section')
    expect(call?.[1]).toHaveProperty('item', 'appearance')
    expect(call?.[2]).toEqual({ only: 'general' })
  })

  it('supports search shortcut and Escape, without consuming an already handled Escape', () => {
    mount()
    openSettings()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('lets an open preference menu consume Escape before closing Settings', () => {
    mount()
    openSettings()
    const closeMenu = vi.fn()
    render(<Menu open anchor={<button>Choose preference</button>} items={[{ id: 'one', label: 'One' }]} onSelect={() => {}} onClose={closeMenu} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeMenu).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy()
  })

  it('keeps unknown plugin sections discoverable and falls back after disposal', () => {
    const { bump } = mount()
    bump([{ id: 'general', order: 0, label: 'Preferences' }, { id: 'extension', order: 1, label: 'Extension settings' }])
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Extension settings' }))
    expect(screen.getByTestId('section-extension')).toBeTruthy()
    bump([{ id: 'general', order: 0, label: 'Preferences' }])
    expect(screen.getByTestId('section-general')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Teams' })).toBeNull()
  })

  it('opens an empty settings page when no feature sections are installed', () => {
    mount({ rows: [] })
    openSettings()
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('transfers onboarding ownership in order and opens the requested section', () => {
    const { renderSlot } = mount({ onboardingActive: true })
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => { (first?.[1] as { complete: () => void }).complete() })
    const second = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding').at(-1)
    expect(second?.[2]).toEqual({ only: 'credentials' })
    act(() => { (second?.[1] as { openSection: (id: string) => void }).openSection('models') })
    expect(screen.getByTestId('section-models')).toBeTruthy()
  })

  it('releases its ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})
