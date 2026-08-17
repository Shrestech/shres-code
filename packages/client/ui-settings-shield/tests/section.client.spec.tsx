// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShieldSection, type ShieldSettings } from '../src/client/ShieldSection.tsx'
import type { SettingsScope, SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function snapshot(partial: Partial<SettingsScopeSnapshot<ShieldSettings>>): SettingsScopeSnapshot<ShieldSettings> {
  return {
    status: 'ready',
    value: { posture: 'ask' },
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
    ...partial,
  }
}

function mount(snap: SettingsScopeSnapshot<ShieldSettings>, set = vi.fn(async () => {})) {
  const scope = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    set,
    unset: vi.fn(async () => {}),
  } as unknown as SettingsScope<ShieldSettings>
  render(
    <ShieldSection
      scope={scope}
      useSnapshot={select => select(snap)}
      t={key => en[key]}
      renderSlot={() => null}
      useSessions={() => undefined as never}
      useWorkspaces={() => undefined as never}
    />,
  )
  return { set }
}

describe('ShieldSection', () => {
  it('toggles the activate switch and publishes the mark lockup', () => {
    const { set } = mount(snapshot({ value: { enabled: true, posture: 'ask' } }))
    fireEvent.click(screen.getByRole('switch', { name: en.disable }))
    expect(set).toHaveBeenCalledWith('enabled', false)
    expect(document.documentElement.dataset.shresShield).toBe('off')
    expect(screen.getByText(en.active)).toBeTruthy()
  })

  it('writes posture on change', () => {
    const { set } = mount(snapshot({}))
    fireEvent.change(screen.getByLabelText(en.posture), { target: { value: 'enforce' } })
    expect(set).toHaveBeenCalledWith('posture', 'enforce')
  })

  it('applies a typed license', () => {
    const { set } = mount(snapshot({}))
    fireEvent.change(screen.getByLabelText(en.license), { target: { value: ' paid-key ' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(set).toHaveBeenCalledWith('license', 'paid-key')
  })

  it('explains when the host seat is not mounted', () => {
    mount(snapshot({ status: 'unavailable', value: undefined, writable: false }))
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
  })
})
