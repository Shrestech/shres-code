// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedBundle, PluginActivationOutcome, PluginGestureToken } from '@shres-code/shres-code-api-remotes/client'
import { BundleManagerTab } from '../src/client/BundleManagerTab.tsx'
import type { BundleManagerTabProps } from '../src/client/BundleManagerTab.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const BUNDLE = '@example/feature-bundle'
const translations: Record<string, string> = en
const translate: BundleManagerTabProps['t'] = key => translations[key] ?? key

function bundle(overrides: Partial<ManagedBundle> = {}): ManagedBundle {
  return {
    name: BUNDLE,
    description: 'A feature bundle',
    selected: true,
    active: true,
    shipped: false,
    rows: ['feature'],
    ...overrides,
  }
}

function renderManager(overrides: Partial<BundleManagerTabProps> = {}) {
  const listBundles = vi.fn().mockResolvedValue([bundle()])
  const begin = vi.fn().mockResolvedValue({ token: 'grant' as PluginGestureToken, expiresAt: 'later' })
  const setBundleEnabled = vi.fn().mockResolvedValue({ kind: 'saved', application: 'applied' } satisfies PluginActivationOutcome)
  const renderSlot = vi.fn(() => <div data-feature-details="true">feature details</div>)
  const effective = {
    listBundles: overrides.listBundles ?? listBundles,
    begin: overrides.begin ?? begin,
    setBundleEnabled: overrides.setBundleEnabled ?? setBundleEnabled,
    renderSlot: overrides.renderSlot ?? renderSlot,
  }
  render(<BundleManagerTab
    listBundles={effective.listBundles}
    begin={effective.begin}
    setBundleEnabled={effective.setBundleEnabled}
    renderSlot={effective.renderSlot as BundleManagerTabProps['renderSlot']}
    useSessions={() => undefined as never}
    useWorkspaces={() => undefined as never}
    useConnectionRevision={selector => selector(0)}
    t={translate}
  />)
  return effective
}

describe('BundleManagerTab', () => {
  it('keeps feature details behind an explicit disclosure and dispatches by bundle name', async () => {
    const b = renderManager()
    await waitFor(() => { expect(screen.getByText(BUNDLE)).toBeTruthy() })
    expect(screen.queryByText('feature details')).toBeNull()
    expect(b.renderSlot).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.bundleShowDetails }))
    expect(screen.getByText('feature details')).toBeTruthy()
    expect(b.renderSlot).toHaveBeenCalledWith(
      'settings.plugins.bundle',
      { bundle: bundle() },
      { entryKey: BUNDLE },
    )
  })

  it('does not expose a feature slot for a selected bundle that is not active', async () => {
    const b = renderManager({
      listBundles: vi.fn().mockResolvedValue([bundle({ active: false })]),
    })
    await waitFor(() => { expect(screen.getByText(BUNDLE)).toBeTruthy() })
    expect(screen.queryByRole('button', { name: en.bundleShowDetails })).toBeNull()
    expect(b.renderSlot).not.toHaveBeenCalled()
  })

  it('localizes bundle management restrictions', async () => {
    renderManager({
      listBundles: vi.fn().mockResolvedValue([bundle({ readOnlyReason: 'management-required' })]),
    })
    await waitFor(() => { expect(screen.getByText(en.bundleManagementRequired)).toBeTruthy() })
    expect(screen.queryByText('management-required')).toBeNull()
  })

  it('shows generic bundle metadata when no feature contributes details', async () => {
    renderManager({ renderSlot: vi.fn(() => <div data-empty-feature-slot="true" />) as BundleManagerTabProps['renderSlot'] })
    await waitFor(() => { expect(screen.getByText(BUNDLE)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.bundleShowDetails }))
    expect(document.querySelector('[data-generic-bundle-details]')?.textContent).toBe('A feature bundle')
    expect(screen.getByText(`${en.bundleRows}: feature`)).toBeTruthy()
    expect(document.querySelector('[data-empty-feature-slot]')).not.toBeNull()
  })

  it('spends one gesture and refreshes after enabling a bundle', async () => {
    const b = renderManager({ listBundles: vi.fn()
      .mockResolvedValueOnce([bundle({ selected: false, active: false })])
      .mockResolvedValueOnce([bundle()]) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en.bundleEnableAction })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.bundleEnableAction }))
    await waitFor(() => { expect(b.setBundleEnabled).toHaveBeenCalledWith('grant', BUNDLE, true) })
    expect(b.begin).toHaveBeenCalledWith('bundle-enable', BUNDLE)
    await waitFor(() => { expect(b.listBundles).toHaveBeenCalledTimes(2) })
  })

  it.each([
    { application: 'restart-required' as const, message: en.bundleRestartRequired },
    { application: 'overridden' as const, message: en.bundleOverridden },
  ])('reports a $application outcome accurately', async ({ application, message }) => {
    renderManager({
      setBundleEnabled: vi.fn().mockResolvedValue({ kind: 'saved', application } satisfies PluginActivationOutcome),
    })
    await waitFor(() => { expect(screen.getByText(BUNDLE)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.bundleDisableAction }))
    expect((await screen.findByRole('status')).textContent).toContain(message)
  })
})
