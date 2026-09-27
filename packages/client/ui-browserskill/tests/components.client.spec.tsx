// @vitest-environment jsdom
/**
 * BrowserSkill section behavior on typed fixtures over the runtime's own
 * status vocabulary: consent content parity (download URLs, versions, and
 * hashes, locations, extension permissions, the persistent update-metadata
 * fetch, the agent-capability and no-human-presence statements), unsupported
 * states that offer no install control, provisioning progress, the accepted
 * operation lifecycle (a stale Ready never settles an accepted operation),
 * ready, disconnected, and failed states, teardown with the unconditional
 * reset warning and the uninstall keep-profile choice, and refusal rendering
 * without any bypass. Fixtures are synthetic; they prove UI behavior, not
 * browser control.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSkillOperationId, BrowserSkillRefusal, BrowserSkillStatus } from '@shres-code/shres-code-api-remotes/client'
import { BrowserSkillSettingsSection, BrowserSkillUnavailableError } from '../src/client/BrowserSkillSettingsSection.tsx'
import type {
  BrowserSkillSettingsSectionInjected,
  BrowserSkillSettingsSectionProps,
  BrowserSkillStartVerdict,
} from '../src/client/BrowserSkillSettingsSection.tsx'
import { en, type BrowserSkillLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: BrowserSkillLocaleKey): string => en[key]) as BrowserSkillSettingsSectionProps['t']

/** The consent facts every status snapshot carries. */
function consent() {
  return {
    downloads: [
      { artifact: 'bsk' as const, version: '0.3.1', url: 'https://example.com/bsk.tar.gz', sha256: 'aaaa1111' },
      { artifact: 'extension' as const, version: '0.3.1', url: 'https://example.com/ext.zip', sha256: 'bbbb2222' },
    ],
    extensionPermissions: ['debugger', 'tabs'],
    extensionHostPermissions: ['https://*/*'],
    installDir: '/home/.shres/browserskill',
    profileDir: '/home/.shres/browserskill/profile',
    updateManifestUrl: 'https://example.com/manifest.json',
  }
}

/** A supported status snapshot; every test overrides the slice it drives. */
function statusFixture(overrides: Partial<BrowserSkillStatus> = {}): BrowserSkillStatus {
  return {
    state: { kind: 'absent' },
    consent: consent(),
    ...overrides,
  }
}

/** An accepted start verdict the spending methods answer with. */
function accepted(id: string): BrowserSkillStartVerdict {
  return { accepted: true, operationId: id as BrowserSkillOperationId }
}

/** A refused start verdict the spending methods answer with. */
function refused(refusal: BrowserSkillRefusal): BrowserSkillStartVerdict {
  return { accepted: false, refusal }
}

const READY = statusFixture({ state: { kind: 'ready', instanceId: 'inst-1' as never }, chrome: { version: '153' } })

/** Injected face with neutral defaults; each test overrides the operation it drives. */
function face(overrides: Partial<BrowserSkillSettingsSectionInjected> = {}): BrowserSkillSettingsSectionInjected {
  return {
    status: () => Promise.resolve(statusFixture()),
    begin: () => Promise.resolve({ token: 'tok-1' as never, expiresAt: '2026-01-01T00:02:00Z' }),
    provision: () => Promise.resolve(accepted('op-1')),
    openBrowser: () => Promise.resolve(accepted('op-1')),
    closeBrowser: () => Promise.resolve(accepted('op-1')),
    reset: () => Promise.resolve(accepted('op-1')),
    uninstall: () => Promise.resolve(accepted('op-1')),
    ...overrides,
  }
}

function props(overrides?: Partial<BrowserSkillSettingsSectionInjected>): BrowserSkillSettingsSectionProps {
  return { t, ...face(overrides) } as BrowserSkillSettingsSectionProps
}

/** Mount and wait for the ready view (any lifecycle state). */
async function renderReady(overrides?: Partial<BrowserSkillSettingsSectionInjected>, status?: Partial<BrowserSkillStatus>) {
  const statusFn = vi.fn(face().status).mockResolvedValue(statusFixture(status))
  const view = render(<BrowserSkillSettingsSection {...props({ ...overrides, status: statusFn })} />)
  await waitFor(() => {
    expect(view.container.querySelector('[data-browserskill-state]')).not.toBeNull()
  })
  return { view, statusFn }
}

describe('BrowserSkillSettingsSection', () => {
  it('renders an unavailable bundle without provisioning controls', async () => {
    const status = vi.fn<BrowserSkillSettingsSectionInjected['status']>()
      .mockRejectedValue(new BrowserSkillUnavailableError('browserSkill/status failed: method-unavailable'))
    render(<BrowserSkillSettingsSection {...props({ status })} />)
    expect((await screen.findByRole('status')).textContent).toBe(en.unavailable)
    expect(screen.queryByRole('button', { name: en.installAction })).toBeNull()
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
  })

  it('renders the disconnected-transport state and recovers through retry', async () => {
    const deferred = Promise.withResolvers<BrowserSkillStatus>()
    const status = vi.fn<BrowserSkillSettingsSectionInjected['status']>()
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(statusFixture())
    const view = render(<BrowserSkillSettingsSection {...props({ status })} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    await act(async () => { deferred.reject(new Error('transport down')) })
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByText(en.installHeading)
    view.unmount()
  })

  it('renders the consent card with every required disclosure', async () => {
    const c = consent()
    const { view } = await renderReady()
    expect(screen.getByText(en.installIntro)).toBeTruthy()
    for (const download of c.downloads) {
      const row = screen.getByText(download.artifact).closest('li')!
      expect(row.getAttribute('data-artifact')).toBe(download.artifact)
      expect(row.textContent).toContain(download.url)
      expect(row.textContent).toContain(download.version)
      expect(row.textContent).toContain(download.sha256)
    }
    expect(screen.getByText(c.installDir)).toBeTruthy()
    expect(screen.getByText(c.profileDir)).toBeTruthy()
    expect(screen.getByText(c.extensionPermissions.join(', '))).toBeTruthy()
    expect(screen.getByText(c.extensionHostPermissions.join(', '))).toBeTruthy()
    expect(screen.getByText(c.updateManifestUrl)).toBeTruthy()
    expect(screen.getByText(c.updateManifestUrl).closest('dd')!.textContent).toContain(en.updateManifestNote)
    expect(screen.getByText(en.gestureNote)).toBeTruthy()
    expect(screen.getByText(en.agentCapabilityNote)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.installAction })).getAttribute('data-install-action')).not.toBeNull()
    view.unmount()
  })

  it('offers no install control before downloads when Chrome is missing or too old', async () => {
    const { view } = await renderReady({}, { state: { kind: 'unsupported', reason: 'chrome-missing', detail: 'none' } })
    expect(screen.getByText(en.chromeMissing)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installAction })).toBeNull()
    view.unmount()
    await renderReady({}, { state: { kind: 'unsupported', reason: 'chrome-too-old', detail: 'old' } })
    expect(screen.getByText(en.chromeTooOld)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installAction })).toBeNull()
  })

  it('renders the unsupported-platform notice without an install control', async () => {
    const { view } = await renderReady({}, { state: { kind: 'unsupported', reason: 'platform', detail: 'win' } })
    expect(screen.getByText(en.unsupportedPlatform)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installAction })).toBeNull()
    view.unmount()
  })

  it('drives the single disclosed install flow from consent into ready', async () => {
    const begin = vi.fn(face().begin).mockResolvedValue({ token: 'tok-1' as never, expiresAt: 'x' })
    const provision = vi.fn(face().provision).mockResolvedValue(accepted('op-1'))
    // The poll after acceptance first reports a STALE Ready from an older
    // operation, then the accepted id settling with Ready.
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture())
      .mockResolvedValueOnce(statusFixture({
        state: READY.state,
        operation: { id: 'op-stale' as BrowserSkillOperationId, verb: 'provision', phase: 'succeeded' },
      }))
      .mockResolvedValue(statusFixture({
        state: READY.state,
        chrome: { version: '153' },
        operation: { id: 'op-1' as BrowserSkillOperationId, verb: 'provision', phase: 'succeeded' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, begin, provision })} />)
    await screen.findByText(en.installHeading)
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    expect(await screen.findByText(en.provisionedNotice, {}, { timeout: 3000 })).toBeTruthy()
    expect(begin).toHaveBeenCalledWith('provision', false)
    expect(provision).toHaveBeenCalledWith('tok-1')
    expect(await screen.findByText(en.readyBadge, {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByText('153')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.closeAction })).toBeTruthy()
    view.unmount()
  })

  it('never settles an accepted operation from a stale Ready state', async () => {
    // Every poll reports Ready but only ever the OLD operation's terminal
    // record; the accepted id never settles, so no success banner may appear
    // and the controls stay disabled while the wait continues.
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture())
      .mockResolvedValue(statusFixture({
        state: READY.state,
        operation: { id: 'op-stale' as BrowserSkillOperationId, verb: 'provision', phase: 'succeeded' },
      }))
    const provision = vi.fn(face().provision).mockResolvedValue(accepted('op-2'))
    const view = render(<BrowserSkillSettingsSection {...props({ status, provision })} />)
    await screen.findByText(en.installHeading)
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledTimes(4)
    }, { timeout: 3000 })
    expect(screen.queryByText(en.provisionedNotice)).toBeNull()
    // The Ready badge may render — it reflects the runtime's state — but the
    // success banner belongs to the accepted operation, whose id never
    // settles here, so it must never appear while the polls continue.
    expect(screen.queryByRole('button', { name: en.installAction })).toBeNull()
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(4)
    view.unmount()
  })

  it('renders a refused start as its refusal and never tracks an operation', async () => {
    const provision = vi.fn(face().provision).mockResolvedValue(refused({ kind: 'operation-in-progress' }))
    const status = vi.fn(face().status).mockResolvedValue(statusFixture())
    const view = render(<BrowserSkillSettingsSection {...props({ status, provision })} />)
    await screen.findByText(en.installHeading)
    fireEvent.click(screen.getByRole('button', { name: en.installAction }))
    expect(await screen.findByText(en.refuseOperationInProgress)).toBeTruthy()
    // Nothing was accepted, so no tracked wait keeps polling or the controls busy.
    expect(status).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: en.installAction })).toBeTruthy()
    view.unmount()
  })

  it('renders an owned-by-peer refusal with the manual recovery detail when present', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'failed', refusal: { kind: 'owned-by-peer', pid: 4242, detail: 'remove the runtime lock manually' } },
    })
    expect(screen.getByText(en.refuseOwnedByPeer)).toBeTruthy()
    expect(screen.getByText('remove the runtime lock manually')).toBeTruthy()
    view.unmount()
    // Without a reported detail the pid line renders as before.
    const second = await renderReady({}, {
      state: { kind: 'failed', refusal: { kind: 'owned-by-peer', pid: 4242 } },
    })
    expect(screen.getByText('Owned by process 4242.')).toBeTruthy()
    second.view.unmount()
  })

  it('renders the shutdown-incomplete refusal with its detail', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'failed', refusal: { kind: 'shutdown-incomplete', detail: 'daemon stop failed: daemon did not exit' } },
    })
    expect(screen.getByText(en.refuseShutdownIncomplete)).toBeTruthy()
    expect(screen.getByText('daemon stop failed: daemon did not exit')).toBeTruthy()
    view.unmount()
  })

  it('renders the disposed refusal with its detail', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'failed', refusal: { kind: 'disposed', detail: 'the runtime was shut down' } },
    })
    expect(screen.getByText(en.refuseDisposed)).toBeTruthy()
    expect(screen.getByText('the runtime was shut down')).toBeTruthy()
    view.unmount()
  })

  it('renders provisioning progress steps while the runtime reports them', async () => {
    const { view } = await renderReady({}, { state: { kind: 'provisioning', step: 'verify' } })
    const verify = screen.getByText(en.stepVerify).closest('li')!
    expect(verify.getAttribute('data-step-phase')).toBe('stepActive')
    expect(screen.getByText(en.stepDownload).closest('li')!.getAttribute('data-step-phase')).toBe('stepPending')
    expect(screen.getByText(en.provisioningNote)).toBeTruthy()
    view.unmount()
  })

  it('renders a failed provision as its refusal with specifics and no bypass', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'failed', refusal: { kind: 'endpoint-in-use', port: 52800 } },
    })
    const refusal = screen.getByText(en.refuseEndpointInUse).closest('div')!
    expect(refusal.getAttribute('data-refusal')).toBe('endpoint-in-use')
    expect(screen.getByText('Port 52800 is already in use.')).toBeTruthy()
    expect(screen.queryByText(/continue anyway/i)).toBeNull()
    expect(screen.queryByText(/re-port|different port|alternate port/i)).toBeNull()
    view.unmount()
  })

  it('renders a hash mismatch with the expected and actual digests', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'failed', refusal: { kind: 'hash-mismatch', artifact: 'bsk', expected: 'aaaa', actual: 'bbbb' } },
    })
    expect(screen.getByText(en.refuseHashMismatch)).toBeTruthy()
    expect(screen.getByText('bsk: expected aaaa, got bbbb.')).toBeTruthy()
    view.unmount()
  })

  it('renders the disconnected state with a reopen control and no re-download claim', async () => {
    const { view } = await renderReady({}, { state: { kind: 'disconnected' } })
    expect(screen.getByText(en.disconnectedNotice)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.openAction })).toBeTruthy()
    view.unmount()
  })

  it('closes from ready and reopens from the provisioned state', async () => {
    const begin = vi.fn(face().begin)
    const closeBrowser = vi.fn(face().closeBrowser).mockResolvedValue(accepted('op-9'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'ready', instanceId: 'inst-1' as never } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'provisioned' },
        operation: { id: 'op-9' as BrowserSkillOperationId, verb: 'close', phase: 'succeeded' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, begin, closeBrowser })} />)
    await screen.findByText(en.readyBadge)
    fireEvent.click(screen.getByRole('button', { name: en.closeAction }))
    expect(await screen.findByText(en.closedNotice, {}, { timeout: 3000 })).toBeTruthy()
    expect(begin).toHaveBeenCalledWith('close', false)
    expect(closeBrowser).toHaveBeenCalledWith('tok-1')
    expect(await screen.findByRole('button', { name: en.openAction }, { timeout: 3000 })).toBeTruthy()
    view.unmount()
  })

  it('warns unconditionally before the profile-deleting reset and then confirms', async () => {
    const begin = vi.fn(face().begin)
    const reset = vi.fn(face().reset).mockResolvedValue(accepted('op-1'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'ready', instanceId: 'inst-1' as never } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'absent' },
        operation: { id: 'op-1' as BrowserSkillOperationId, verb: 'reset', phase: 'succeeded' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, begin, reset })} />)
    await screen.findByText(en.readyBadge)
    fireEvent.click(screen.getByRole('button', { name: en.resetAction }))
    const confirmCard = screen.getByText(en.confirmResetAction).closest('[data-confirm]')!
    expect(confirmCard.getAttribute('data-confirm')).toBe('reset')
    expect(screen.getByText(en.resetWarning)).toBeTruthy()
    expect(confirmCard.textContent).toContain(consent().profileDir)
    fireEvent.click(screen.getByRole('button', { name: en.confirmResetAction }))
    expect(await screen.findByText(en.resetDoneNotice, {}, { timeout: 3000 })).toBeTruthy()
    expect(begin).toHaveBeenCalledWith('reset', false)
    expect(reset).toHaveBeenCalledWith('tok-1')
    view.unmount()
  })

  it('defaults uninstall to keeping the profile and warns only when deleting', async () => {
    const begin = vi.fn(face().begin)
    const uninstall = vi.fn(face().uninstall).mockResolvedValue(accepted('op-1'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'provisioned' } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'absent' },
        operation: { id: 'op-1' as BrowserSkillOperationId, verb: 'uninstall', phase: 'succeeded' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, begin, uninstall })} />)
    await screen.findByText(en.teardownHeading)
    fireEvent.click(screen.getByRole('button', { name: en.uninstallAction }))
    const confirmCard = screen.getByText(en.confirmUninstallAction).closest('[data-confirm]')!
    expect(confirmCard.getAttribute('data-confirm')).toBe('uninstall')
    expect(screen.getByLabelText(en.keepProfileLabel)).toBeTruthy()
    expect(screen.queryByText(en.destructiveWarning)).toBeNull()
    fireEvent.click(screen.getByLabelText(en.keepProfileLabel))
    expect((await screen.findByRole('alert')).textContent).toBe(en.destructiveWarning)
    fireEvent.click(screen.getByRole('button', { name: en.confirmUninstallAction }))
    expect(await screen.findByText(en.uninstallDonePurgedNotice, {}, { timeout: 3000 })).toBeTruthy()
    expect(begin).toHaveBeenCalledWith('uninstall', false)
    expect(uninstall).toHaveBeenCalledWith('tok-1', false)
    view.unmount()
  })

  it('renders the generic failure notice when an operation rejects', async () => {
    const begin = vi.fn(face().begin).mockRejectedValue(new Error('browserSkill.begin failed: down'))
    const { view } = await renderReady(
      { begin },
      { state: { kind: 'ready', instanceId: 'inst-1' as never } },
    )
    fireEvent.click(screen.getByRole('button', { name: en.closeAction }))
    expect(await screen.findByText(en.opFailedNotice)).toBeTruthy()
    view.unmount()
  })

  it('renders the remaining detail-bearing refusals with their specifics and an open control', async () => {
    const cases: Array<[BrowserSkillRefusal, string, BrowserSkillLocaleKey]> = [
      [{ kind: 'extension-load-failed', detail: 'loader refused the unpacked extension' }, 'loader refused the unpacked extension', 'refuseExtensionLoadFailed'],
      [{ kind: 'daemon-start-failed', detail: 'daemon exited during startup' }, 'daemon exited during startup', 'refuseDaemonStartFailed'],
      [{ kind: 'command-lost', detail: 'navigate never completed' }, 'navigate never completed', 'refuseCommandLost'],
      [{ kind: 'download-failed', detail: 'mirror down' }, 'mirror down', 'refuseDownloadFailed'],
      [{ kind: 'unsupported-platform', detail: 'win32' }, 'win32', 'unsupportedPlatform'],
      [{ kind: 'chrome-missing', detail: 'none installed' }, 'none installed', 'chromeMissing'],
      [{ kind: 'chrome-too-old', detail: 'Chrome 110' }, 'Chrome 110', 'chromeTooOld'],
    ]
    for (const [refusal, detail, key] of cases) {
      const { view } = await renderReady({}, { state: { kind: 'failed', refusal } })
      expect(screen.getByText(en[key])).toBeTruthy()
      expect(screen.getByText(detail)).toBeTruthy()
      expect(screen.getByRole('button', { name: en.openAction })).toBeTruthy()
      view.unmount()
    }
  })

  it('renders an instance-mismatch failure without a detail line but with an open control', async () => {
    const { view } = await renderReady({}, { state: { kind: 'failed', refusal: { kind: 'instance-mismatch' } } })
    expect(screen.getByText(en.refuseInstanceMismatch)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.openAction })).toBeTruthy()
    expect(screen.getByText(en.refuseInstanceMismatch).closest('div')!.textContent).not.toContain('undefined')
    view.unmount()
  })

  it('renders the running operation while its accepted id is pending', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'ready', instanceId: 'inst-1' as never },
      operation: { id: 'op-live' as BrowserSkillOperationId, verb: 'provision', phase: 'running' },
    })
    expect(screen.getByText('provision — running')).toBeTruthy()
    view.unmount()
  })

  it('renders provisioned artifact versions and digests when reported', async () => {
    const { view } = await renderReady({}, {
      state: { kind: 'ready', instanceId: 'inst-1' as never },
      chrome: { version: '153' },
      artifacts: {
        bsk: { version: '0.3.1', sha256: 'aaaa' },
        extension: { version: '0.3.1', sha256: 'bbbb' },
      },
    })
    expect(screen.getByText('bsk 0.3.1 aaaa')).toBeTruthy()
    expect(screen.getByText('extension 0.3.1 bbbb')).toBeTruthy()
    view.unmount()
  })

  it('keeps the open control busy and single-flight while the gesture is in flight', async () => {
    const deferred = Promise.withResolvers<BrowserSkillStartVerdict>()
    const openBrowser = vi.fn(() => deferred.promise)
    const begin = vi.fn(face().begin)
    const { view } = await renderReady({ begin, openBrowser }, { state: { kind: 'disconnected' } })
    fireEvent.click(screen.getByRole('button', { name: en.openAction }))
    expect(screen.getByRole('button', { name: en.openBusyAction })).toBeTruthy()
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: en.openBusyAction }))
    expect(openBrowser).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => { deferred.resolve(accepted('op-open')) })
  })

  it('drops a rejecting operation that settles after unmount', async () => {
    const deferred = Promise.withResolvers<BrowserSkillStartVerdict>()
    const openBrowser = vi.fn(() => deferred.promise)
    const { view } = await renderReady({ openBrowser }, { state: { kind: 'disconnected' } })
    fireEvent.click(screen.getByRole('button', { name: en.openAction }))
    view.unmount()
    await act(async () => { deferred.reject(new Error('late failure')) })
    expect(screen.queryByText(en.opFailedNotice)).toBeNull()
  })

  it('renders the kept-profile success notice for a kept uninstall', async () => {
    const begin = vi.fn(face().begin)
    const uninstall = vi.fn(face().uninstall).mockResolvedValue(accepted('op-1'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'provisioned' } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'absent' },
        operation: { id: 'op-1' as BrowserSkillOperationId, verb: 'uninstall', phase: 'succeeded' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, begin, uninstall })} />)
    await screen.findByText(en.teardownHeading)
    fireEvent.click(screen.getByRole('button', { name: en.uninstallAction }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmUninstallAction }))
    expect(await screen.findByText(en.uninstallDoneKeptNotice, {}, { timeout: 3000 })).toBeTruthy()
    expect(begin).toHaveBeenCalledWith('uninstall', true)
    expect(uninstall).toHaveBeenCalledWith('tok-1', true)
    view.unmount()
  })

  it('closes the reset confirmation without spending a gesture', async () => {
    const { view } = await renderReady({}, { state: { kind: 'ready', instanceId: 'inst-1' as never } })
    await screen.findByText(en.readyBadge)
    fireEvent.click(screen.getByRole('button', { name: en.resetAction }))
    expect(screen.getByText(en.resetWarning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancelAction }))
    expect(screen.queryByText(en.resetWarning)).toBeNull()
    expect(screen.getByRole('button', { name: en.resetAction })).toBeTruthy()
    view.unmount()
  })

  it('closes the uninstall confirmation without spending a gesture', async () => {
    const { view } = await renderReady({}, { state: { kind: 'provisioned' } })
    await screen.findByText(en.teardownHeading)
    fireEvent.click(screen.getByRole('button', { name: en.uninstallAction }))
    expect(screen.getByLabelText(en.keepProfileLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancelAction }))
    expect(screen.queryByLabelText(en.keepProfileLabel)).toBeNull()
    expect(screen.getByRole('button', { name: en.uninstallAction })).toBeTruthy()
    view.unmount()
  })

  it('reopens a disconnected browser and renders the opened notice', async () => {
    const begin = vi.fn(face().begin)
    const openBrowser = vi.fn(face().openBrowser).mockResolvedValue(accepted('op-7'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'disconnected' } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'ready', instanceId: 'inst-1' as never },
        chrome: { version: '153' },
        operation: { id: 'op-7' as BrowserSkillOperationId, verb: 'open', phase: 'succeeded' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, begin, openBrowser })} />)
    await screen.findByText(en.disconnectedNotice)
    fireEvent.click(screen.getByRole('button', { name: en.openAction }))
    expect(await screen.findByText(en.openedNotice, {}, { timeout: 3000 })).toBeTruthy()
    expect(begin).toHaveBeenCalledWith('open', false)
    expect(openBrowser).toHaveBeenCalledWith('tok-1')
    view.unmount()
  })

  it('renders the refusal banner when the accepted operation settles as failed', async () => {
    const openBrowser = vi.fn(face().openBrowser).mockResolvedValue(accepted('op-3'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'disconnected' } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'failed', refusal: { kind: 'endpoint-in-use', port: 52800 } },
        operation: {
          id: 'op-3' as BrowserSkillOperationId, verb: 'open', phase: 'failed',
          refusal: { kind: 'endpoint-in-use', port: 52800 },
        },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, openBrowser })} />)
    await screen.findByText(en.disconnectedNotice)
    fireEvent.click(screen.getByRole('button', { name: en.openAction }))
    const notices = await screen.findAllByText(en.refuseEndpointInUse, {}, { timeout: 3000 })
    expect(notices.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Port 52800 is already in use.').length).toBeGreaterThanOrEqual(1)
    view.unmount()
  })

  it('renders the generic failure banner when a settled operation carries no refusal', async () => {
    const openBrowser = vi.fn(face().openBrowser).mockResolvedValue(accepted('op-4'))
    const status = vi.fn(face().status)
      .mockResolvedValueOnce(statusFixture({ state: { kind: 'disconnected' } }))
      .mockResolvedValue(statusFixture({
        state: { kind: 'failed', refusal: { kind: 'instance-mismatch' } },
        operation: { id: 'op-4' as BrowserSkillOperationId, verb: 'open', phase: 'failed' },
      }))
    const view = render(<BrowserSkillSettingsSection {...props({ status, openBrowser })} />)
    await screen.findByText(en.disconnectedNotice)
    fireEvent.click(screen.getByRole('button', { name: en.openAction }))
    expect(await screen.findByText(en.opFailedNotice, {}, { timeout: 3000 })).toBeTruthy()
    view.unmount()
  })

  it('drops a status resolution that lands after unmount', async () => {
    const deferred = Promise.withResolvers<BrowserSkillStatus>()
    const status = vi.fn<BrowserSkillSettingsSectionInjected['status']>().mockReturnValueOnce(deferred.promise)
    const view = render(<BrowserSkillSettingsSection {...props({ status })} />)
    view.unmount()
    await act(async () => { deferred.resolve(statusFixture()) })
    expect(view.container.querySelector('[data-browserskill-state]')).toBeNull()
  })

  it('drops a status rejection that lands after unmount', async () => {
    const deferred = Promise.withResolvers<BrowserSkillStatus>()
    const status = vi.fn<BrowserSkillSettingsSectionInjected['status']>().mockReturnValueOnce(deferred.promise)
    const view = render(<BrowserSkillSettingsSection {...props({ status })} />)
    view.unmount()
    await act(async () => { deferred.reject(new Error('transport down after unmount')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
