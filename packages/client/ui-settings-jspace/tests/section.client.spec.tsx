// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSpaceSection, type JSpaceSettings } from '../src/client/JSpaceSection.tsx'
import type { JSpaceCardView } from '../src/client/card-source.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function snapshot(partial: Partial<SettingsScopeSnapshot<JSpaceSettings>>): SettingsScopeSnapshot<JSpaceSettings> {
  return {
    status: 'ready',
    value: { mode: 'available' },
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
    ...partial,
  }
}

function sessionLabel(state: string): string {
  return `${en.session} · ${state}`
}

function mount(
  snap: SettingsScopeSnapshot<JSpaceSettings>,
  set = vi.fn(async () => {}),
  card?: JSpaceCardView,
) {
  const scope = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    set,
    unset: vi.fn(async () => {}),
  } as unknown as SettingsScope<JSpaceSettings>
  render(
    <JSpaceSection
      scope={scope}
      useSnapshot={select => select(snap)}
      useCard={select => select(card)}
      t={key => en[key]}
      useSessions={select => select({ current: 's-test' } as never)}
      useWorkspaces={() => undefined as never}
      close={vi.fn()}
    />,
  )
  return { set }
}

describe('JSpaceSection', () => {
  it('toggles the activate switch', () => {
    const { set } = mount(snapshot({ value: { enabled: false, mode: 'available' } }))
    fireEvent.click(screen.getByRole('switch', { name: en.activate }))
    expect(set).toHaveBeenCalledWith('enabled', true)
    expect(screen.getByText(en.inactive)).toBeTruthy()
  })

  it('writes mode on change', () => {
    const { set } = mount(snapshot({}))
    fireEvent.change(screen.getByLabelText(en.mode), { target: { value: 'always-open' } })
    expect(set).toHaveBeenCalledWith('mode', 'always-open')
  })

  it('ignores an unknown mode value', () => {
    const { set } = mount(snapshot({}))
    fireEvent.change(screen.getByLabelText(en.mode), { target: { value: 'nope' } })
    expect(set).not.toHaveBeenCalled()
  })

  it('toggles requireCoverage', () => {
    const { set } = mount(snapshot({ value: { requireCoverage: true } }))
    fireEvent.click(screen.getByRole('switch', { name: en.requireCoverage }))
    expect(set).toHaveBeenCalledWith('requireCoverage', false)
  })

  it('shows last-known open card counts', () => {
    mount(snapshot({}), vi.fn(async () => {}), { open: true, checked: 3 })
    expect(screen.getByText((_, node) => node?.textContent === sessionLabel(en.open))).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText(en.coverageHonesty)).toBeTruthy()
  })

  it('shows a closed card and keeps the checked count', () => {
    mount(snapshot({ value: { enabled: false } }), vi.fn(async () => {}), { open: false, checked: 2 })
    expect(screen.getByText((_, node) => node?.textContent === sessionLabel(en.closed))).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText(en.inactive)).toBeTruthy()
  })

  it('shows an em dash when no card is known', () => {
    mount(snapshot({}))
    expect(screen.getByText((_, node) => node?.textContent === sessionLabel('—'))).toBeTruthy()
    expect(screen.getByText('—', { selector: 'dd' })).toBeTruthy()
  })

  it('shows settings loading without a switch', () => {
    mount(snapshot({ status: 'loading', value: undefined, writable: false }))
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByText(en.coverageHonesty)).toBeTruthy()
  })

  it('explains when the host seat is not mounted', () => {
    mount(snapshot({ status: 'unavailable', value: undefined, writable: false }))
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('disables writes when the settings document is read-only', () => {
    mount(snapshot({ writable: false, value: { enabled: true, mode: 'available' } }))
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByRole('switch', { name: en.disable }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('switch', { name: en.requireCoverage }).hasAttribute('disabled')).toBe(true)
  })

  it('turns requireCoverage on from an explicit false value', () => {
    const { set } = mount(snapshot({ value: { requireCoverage: false } }))
    fireEvent.click(screen.getByRole('switch', { name: en.requireCoverage }))
    expect(set).toHaveBeenCalledWith('requireCoverage', true)
  })
})
