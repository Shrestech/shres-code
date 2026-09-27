// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ManagedPlugin,
  PluginActivationOutcome,
  PluginGestureToken,
} from '@shres-code/shres-code-api-remotes/client'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginInventorySettingsTabProps['t']
const entryId = 'browser-row' as ManagedPlugin['entryId']

function row(overrides: Partial<ManagedPlugin> = {}): ManagedPlugin {
  return {
    entryId,
    moduleName: '@example/browser-plugin',
    enabled: false,
    fiberPhase: null,
    ...overrides,
  }
}

function props(
  listPlugins: PluginInventorySettingsTabInjected['listPlugins'],
  beginPlugin: PluginInventorySettingsTabInjected['beginPlugin'],
  setPluginEnabled: PluginInventorySettingsTabInjected['setPluginEnabled'],
): PluginInventorySettingsTabProps {
  return {
    t,
    listPlugins,
    beginPlugin,
    setPluginEnabled,
    useSessions: () => undefined as never,
    useWorkspaces: () => undefined as never,
  }
}

describe('PluginInventorySettingsTab activation controls', () => {
  it('uses one plugin gesture and refreshes after saving an enablement change', async () => {
    const managed = vi.fn<PluginInventorySettingsTabInjected['listPlugins']>()
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([row({ enabled: true, fiberPhase: 'active' })])
    const begin = vi.fn<NonNullable<PluginInventorySettingsTabInjected['beginPlugin']>>()
      .mockResolvedValue({ token: 'grant' as PluginGestureToken, expiresAt: 'later' })
    const outcome: PluginActivationOutcome = { kind: 'saved', application: 'applied' }
    const setEnabled = vi.fn<NonNullable<PluginInventorySettingsTabInjected['setPluginEnabled']>>()
      .mockResolvedValue(outcome)

    render(<PluginInventorySettingsTab {...props(managed, begin, setEnabled)} />)
    const card = await screen.findByRole('button', { name: 'browser-plugin, Disabled' })
    fireEvent.click(card)
    const enable = await screen.findByRole('button', { name: en.pluginEnableAction })
    fireEvent.click(enable)

    await waitFor(() => {
      expect(begin).toHaveBeenCalledWith('plugin-enable', entryId)
      expect(setEnabled).toHaveBeenCalledWith('grant', entryId, true)
      expect(managed).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByRole('button', { name: 'browser-plugin, Mounted, Enabled' })).toBeTruthy()
  })

  it('keeps a host-reported read-only row visible without an activation control', async () => {
    const managed = vi.fn<PluginInventorySettingsTabInjected['listPlugins']>()
      .mockResolvedValue([row({ readOnlyReason: 'management-required' })])
    const begin = vi.fn<NonNullable<PluginInventorySettingsTabInjected['beginPlugin']>>()
    const setEnabled = vi.fn<NonNullable<PluginInventorySettingsTabInjected['setPluginEnabled']>>()

    render(<PluginInventorySettingsTab {...props(managed, begin, setEnabled)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browser-plugin, Disabled' }))
    expect(screen.getByText(en.pluginReadOnlyManagement)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.pluginEnableAction })).toBeNull()
    expect(begin).not.toHaveBeenCalled()
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it.each([
    { application: 'restart-required' as const, message: en.pluginActivationRestartRequired },
    { application: 'overridden' as const, message: en.pluginActivationOverridden },
  ])('reports a $application plugin outcome accurately', async ({ application, message }) => {
    const listPlugins = vi.fn<PluginInventorySettingsTabInjected['listPlugins']>().mockResolvedValue([row()])
    const begin = vi.fn<PluginInventorySettingsTabInjected['beginPlugin']>()
      .mockResolvedValue({ token: 'grant' as PluginGestureToken, expiresAt: 'later' })
    const setEnabled = vi.fn<PluginInventorySettingsTabInjected['setPluginEnabled']>()
      .mockResolvedValue({ kind: 'saved', application })

    render(<PluginInventorySettingsTab {...props(listPlugins, begin, setEnabled)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browser-plugin, Disabled' }))
    fireEvent.click(await screen.findByRole('button', { name: en.pluginEnableAction }))
    expect((await screen.findByRole('status')).textContent).toBe(message)
  })
})
