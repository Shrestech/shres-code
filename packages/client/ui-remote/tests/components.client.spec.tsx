// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RemoteEntryView, RemoteInspectView, TunnelStateView } from '@shres-code/shres-code-api-remotes/client'
import type { SnapshotSelectorHook, Translate } from '@shres-code/shres-code-client-ui-slots'
import { ConnectedBadge, type ConnectedBadgeProps } from '../src/client/ConnectedBadge.tsx'
import { en, type RemoteKey } from '../src/client/locales.ts'
import { RemoteRow, type RemoteRowProps } from '../src/client/RemoteRow.tsx'
import { RemotesSection, type RemotesSectionProps } from '../src/client/RemotesSection.tsx'
import { busyKey, createRemoteViewStore, type RemoteViewState, type RemoveResult } from '../src/client/store.ts'
import { TrustModal, type TrustModalProps } from '../src/client/TrustModal.tsx'

afterEach(cleanup)

/** English-dictionary translate stub with {name} interpolation, matching the locale service. */
const t: Translate<RemoteKey> = (key, params) => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

/** Stub for the global hooks the runtime share derives (this UI reads none). */
const neverHook = (() => { throw new Error('the group must not read global hooks') }) as never

function entry(alias: string): RemoteEntryView {
  return {
    id: alias as RemoteEntryView['id'],
    target: `ci@${alias}.remote.example` as RemoteEntryView['target'],
    remotePort: 3080,
    fingerprint: null,
    lastConnectedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

function tunnel(alias: string, state: TunnelStateView['state']): TunnelStateView {
  return {
    alias: alias as TunnelStateView['alias'],
    state,
    localPort: state === 'open' ? 4123 : null,
    version: '0.1.0-rc.5',
    fingerprint: 'f'.repeat(16),
    error: null,
    since: '2026-09-01T00:00:00.000Z',
  }
}

/** A view hook over a seeded store snapshot (static: rerender to observe). */
function useViewOf(state: RemoteViewState): SnapshotSelectorHook<RemoteViewState> {
  return sel => sel(state)
}

describe('ConnectedBadge', () => {
  it('renders nothing without open tunnels', () => {
    const { container } = render(<ConnectedBadge open={[]} t={t} onOpen={vi.fn()} onDisconnect={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('lists open tunnels and drives open-tab and disconnect', () => {
    const onOpen = vi.fn()
    const onDisconnect = vi.fn()
    const props: ConnectedBadgeProps = {
      open: [{ alias: 'prod', target: 'ci@prod.remote.example', localPort: 4123 }],
      t, onOpen, onDisconnect,
    }
    render(<ConnectedBadge {...props} />)
    expect(screen.getByText('prod')).toBeTruthy()
    expect(screen.getByText('ci@prod.remote.example')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open tab' }))
    expect(onOpen).toHaveBeenCalledWith(4123)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(onDisconnect).toHaveBeenCalledWith('prod')
  })
})

describe('RemoteRow', () => {
  function rowProps(overrides: Partial<RemoteRowProps> = {}): RemoteRowProps {
    return {
      entry: entry('prod'),
      tunnel: undefined,
      busy: false,
      t,
      onConnect: vi.fn(),
      onEdit: vi.fn(),
      onRemove: vi.fn(async (): Promise<RemoveResult> => ({ ok: true, removed: true })),
      onOpenTab: vi.fn(),
      ...overrides,
    }
  }

  it('shows alias, target, and the tunnel-state dot; row click connects', () => {
    const onConnect = vi.fn()
    render(<RemoteRow {...rowProps({ tunnel: tunnel('prod', 'open'), onConnect })} />)
    expect(screen.getByText('prod')).toBeTruthy()
    expect(screen.getByText('ci@prod.remote.example')).toBeTruthy()
    expect(screen.getByLabelText('Connected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect prod' }))
    expect(onConnect).toHaveBeenCalledWith('prod')
  })

  it('marks the dot with the error state', () => {
    render(<RemoteRow {...rowProps({ tunnel: { ...tunnel('prod', 'error'), error: 'forward died' } })} />)
    expect(screen.getByLabelText('Connection error')).toBeTruthy()
  })

  it('kebab: open-tab requires a local port, edit opens the form, remove arms the confirm', async () => {
    const onOpenTab = vi.fn()
    const onEdit = vi.fn()
    const view = render(<RemoteRow {...rowProps({ onOpenTab, onEdit })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    const openItem = screen.getByText('Open in new tab').closest('button') as HTMLButtonElement
    expect(openItem.disabled).toBe(true)
    fireEvent.click(screen.getByText('Edit'))
    expect(onEdit).toHaveBeenCalledWith('prod')
    expect(screen.queryByText('Remove remote prod?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Remove'))
    expect(screen.getByRole('alertdialog', { name: 'Remove remote prod?' })).toBeTruthy()
    // Cancel disarms without calling the removal.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(view.container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onOpenTab).not.toHaveBeenCalled()
  })

  it('confirming remove on success disarms the dialog', async () => {
    const onRemove = vi.fn(async (): Promise<RemoveResult> => ({ ok: true, removed: true }))
    render(<RemoteRow {...rowProps({ onRemove })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Remove'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => { expect(onRemove).toHaveBeenCalledWith('prod') })
    await vi.waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull() })
  })

  it('closes the kebab when the menu dismisses', () => {
    render(<RemoteRow {...rowProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    expect(screen.getByText('Edit')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('open-tab hands the status-provided local port to the opener', () => {
    const onOpenTab = vi.fn()
    render(<RemoteRow {...rowProps({ tunnel: tunnel('prod', 'open'), onOpenTab })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Open in new tab'))
    expect(onOpenTab).toHaveBeenCalledWith(4123)
  })

  it('surfaces the connected-refusal and wire-failure removal outcomes inline', async () => {
    const refusal = rowProps({ onRemove: vi.fn(async (): Promise<RemoveResult> => ({ ok: false, kind: 'connected' })) })
    const view = render(<RemoteRow {...refusal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Remove'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() =>{  expect(screen.getByText('Disconnect prod before removing it.')).toBeTruthy() })
    view.unmount()

    const failure = rowProps({ onRemove: vi.fn(async (): Promise<RemoveResult> => ({ ok: false, kind: 'error', message: 'registry locked' })) })
    render(<RemoteRow {...failure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Remove'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() =>{  expect(screen.getByText('registry locked')).toBeTruthy() })
  })
})

describe('TrustModal', () => {
  const baseInspect = {
    target: 'ci@prod.remote.example' as RemoteInspectView['target'],
    daemonVersion: '0.1.0-rc.5',
    installationId: 'abcdef1234567890abcdef',
    localVersion: '0.1.0-rc.5',
    firstConnect: true,
    trustedFingerprint: null,
  }

  function modalProps(overrides: Partial<TrustModalProps> = {}): TrustModalProps {
    return {
      modal: { phase: 'closed' },
      connectBusy: false,
      t,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      onRetry: vi.fn(),
      ...overrides,
    }
  }

  it('renders nothing while the machine is closed', () => {
    render(<TrustModal {...modalProps()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the inspecting and connecting phases as copy', () => {
    const view = render(<TrustModal {...modalProps({ modal: { phase: 'inspecting', alias: 'prod' } })} />)
    expect(screen.getByRole('dialog', { name: 'Connect to prod' })).toBeTruthy()
    expect(screen.getByText('Checking the remote…')).toBeTruthy()
    view.rerender(<TrustModal {...modalProps({ modal: { phase: 'connecting', alias: 'prod' } })} />)
    expect(screen.getByText('Connecting…')).toBeTruthy()
  })

  it('first connect: TOFU copy, short id with full value in title, strict confirm', () => {
    const onConfirm = vi.fn()
    render(<TrustModal {...modalProps({ modal: { phase: 'confirm', alias: 'prod', inspect: baseInspect }, onConfirm })} />)
    expect(screen.getByText('ci@prod.remote.example')).toBeTruthy()
    expect(screen.getByText('0.1.0-rc.5 — matches this app')).toBeTruthy()
    expect(screen.getByText('abcdef123456…')).toBeTruthy()
    expect(screen.getByText('abcdef123456…').title).toBe('abcdef1234567890abcdef')
    expect(screen.getByText('First connection to this remote — connecting trusts the installation id below.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }))
    expect(onConfirm).toHaveBeenCalledWith('prod', { allowVersionSkew: false, forceFingerprint: false })
  })

  it('version skew flips the primary to Connect anyway with the skew decision', () => {
    const onConfirm = vi.fn()
    render(<TrustModal {...modalProps({
      modal: { phase: 'confirm', alias: 'prod', inspect: { ...baseInspect, daemonVersion: '9.8.7' } },
      onConfirm,
    })} />)
    expect(screen.getByText('9.8.7 — this app runs 0.1.0-rc.5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect anyway' }))
    expect(onConfirm).toHaveBeenCalledWith('prod', { allowVersionSkew: true, forceFingerprint: false })
  })

  it('a changed installation id shows the re-trust warning and forces the fingerprint', () => {
    const onConfirm = vi.fn()
    render(<TrustModal {...modalProps({
      modal: {
        phase: 'confirm',
        alias: 'prod',
        inspect: { ...baseInspect, firstConnect: false, trustedFingerprint: '1111111111111111' },
      },
      onConfirm,
    })} />)
    expect(screen.getByText('The remote’s installation changed since the last connection.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }))
    expect(onConfirm).toHaveBeenCalledWith('prod', { allowVersionSkew: false, forceFingerprint: true })
  })

  it('a version-mismatch connect outcome re-enters confirm with the observed version', () => {
    const onConfirm = vi.fn()
    render(<TrustModal {...modalProps({
      modal: {
        phase: 'confirm',
        alias: 'prod',
        inspect: { ...baseInspect, daemonVersion: null },
        outcome: { status: 'version-mismatch', observed: '9.8.7', local: '0.1.0-rc.5' },
      },
      onConfirm,
    })} />)
    expect(screen.getByText('9.8.7 — this app runs 0.1.0-rc.5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect anyway' }))
    expect(onConfirm).toHaveBeenCalledWith('prod', { allowVersionSkew: true, forceFingerprint: false })
  })

  it('a fingerprint-mismatch connect outcome displays the observed id for the re-trust', () => {
    render(<TrustModal {...modalProps({
      modal: {
        phase: 'confirm',
        alias: 'prod',
        inspect: { ...baseInspect, firstConnect: false, installationId: null, trustedFingerprint: '1111111111111111' },
        outcome: { status: 'fingerprint-mismatch', observed: 'abcdef1234567890abcdef', trusted: '1111111111111111' },
      },
    })} />)
    expect(screen.getByText('abcdef123456…')).toBeTruthy()
    expect(screen.getByText('The remote’s installation changed since the last connection.')).toBeTruthy()
  })

  it('a matching recorded id renders the match copy', () => {
    render(<TrustModal {...modalProps({
      modal: {
        phase: 'confirm',
        alias: 'prod',
        inspect: { ...baseInspect, firstConnect: false, trustedFingerprint: 'abcdef1234567890abcdef' },
      },
    })} />)
    expect(screen.getByText('Matches the installation this app trusts.')).toBeTruthy()
  })

  it('a short installation id renders in full', () => {
    render(<TrustModal {...modalProps({
      modal: { phase: 'confirm', alias: 'prod', inspect: { ...baseInspect, installationId: 'abc' } },
    })} />)
    expect(screen.getByLabelText('abc').textContent).toBe('abc')
  })

  it('a confirm without an installation id omits the fingerprint value', () => {
    render(<TrustModal {...modalProps({
      modal: { phase: 'confirm', alias: 'prod', inspect: { ...baseInspect, installationId: null } },
    })} />)
    expect(screen.queryByTitle('0123456789abcdef')).toBeNull()
    expect(screen.getByText('First connection to this remote — connecting trusts the installation id below.')).toBeTruthy()
  })

  it('an absent probe answer renders the no-daemon line', () => {
    render(<TrustModal {...modalProps({
      modal: { phase: 'confirm', alias: 'prod', inspect: { ...baseInspect, daemonVersion: null } },
    })} />)
    expect(screen.getByText('No daemon answered on the remote port.')).toBeTruthy()
  })

  it('a failed phase offers retry and cancel', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    render(<TrustModal {...modalProps({ modal: { phase: 'failed', alias: 'prod', message: 'ssh hung up' }, onRetry, onCancel })} />)
    expect(screen.getByText('Connection failed')).toBeTruthy()
    expect(screen.getByText('ssh hung up')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('prod')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('RemotesSection', () => {
  function sectionHarness(stateOverrides: (view: ReturnType<typeof createRemoteViewStore>) => void = () => {}) {
    const view = createRemoteViewStore()
    stateOverrides(view)
    const props = {
      wide: true,
      expandSidebar: vi.fn(),
      useSessions: neverHook,
      useWorkspaces: neverHook,
      useView: useViewOf(view.getSnapshot()),
      connect: vi.fn(async () => {}),
      confirmConnect: vi.fn(async () => {}),
      cancelModal: vi.fn(),
      disconnect: vi.fn(async () => {}),
      openTab: vi.fn(),
      addRemote: vi.fn(async (draft: { alias: string; target: string; remotePort: number }) =>
        ({ ok: true as const, entry: entry(draft.alias) })),
      editRemote: vi.fn(async () => ({ ok: true as const, entry: entry('prod') })),
      removeRemote: vi.fn(async (): Promise<RemoveResult> => ({ ok: true, removed: true })),
      setFolded: vi.fn(),
      t,
    } as unknown as RemotesSectionProps
    return { props, view }
  }

  it('renders nothing on the rail', () => {
    const { props } = sectionHarness((view) => { view.setEntries([entry('prod')]) })
    const { container } = render(<RemotesSection {...props} wide={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the folded header, rows, and the add affordance', () => {
    const { props } = sectionHarness((view) => { view.setEntries([entry('lab'), entry('prod')]) })
    render(<RemotesSection {...props} />)
    expect(screen.getByText('Remotes')).toBeTruthy()
    expect(screen.getByText('lab')).toBeTruthy()
    expect(screen.getByText('prod')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add remote…' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Connected remotes' })).toBeNull()
  })

  it('folding hides the body through the store flag', () => {
    const { props } = sectionHarness((view) => {
      view.setEntries([entry('prod')])
      view.setFolded(true)
    })
    render(<RemotesSection {...props} />)
    expect(screen.queryByText('prod')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add remote…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show remotes' }))
    expect(props.setFolded).toHaveBeenCalledWith(false)
  })

  it('shows the connected badge for open tunnels and drives its actions', () => {
    const { props } = sectionHarness((view) => {
      view.setEntries([entry('prod')])
      view.applyTunnel(tunnel('prod', 'open'))
    })
    render(<RemotesSection {...props} />)
    expect(screen.getByRole('list', { name: 'Connected remotes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open tab' }))
    expect(props.openTab).toHaveBeenCalledWith(4123)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(props.disconnect).toHaveBeenCalledWith('prod')
  })

  it('renders the degraded hint instead of assuming rows', () => {
    const { props } = sectionHarness((view) => { view.setDegraded(true) })
    render(<RemotesSection {...props} />)
    expect(screen.getByText('Remotes are managed on the machine running the app.')).toBeTruthy()
  })

  it('row click and kebab edit route into the injected flows', () => {
    const { props } = sectionHarness((view) => { view.setEntries([entry('prod')]) })
    render(<RemotesSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect prod' }))
    expect(props.connect).toHaveBeenCalledWith('prod')
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Edit'))
    // The edit form opens prefilled with the alias locked.
    const aliasInput = screen.getByLabelText('Alias') as HTMLInputElement
    expect(aliasInput.value).toBe('prod')
    expect(aliasInput.disabled).toBe(true)
  })

  it('the add form submits the draft and closes on success', async () => {
    const { props } = sectionHarness()
    render(<RemotesSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add remote…' }))
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'lab' } })
    fireEvent.change(screen.getByLabelText('Target (user@host)'), { target: { value: 'ci@lab.remote.example' } })
    const portInput = screen.getByLabelText('Daemon port (shres web on the remote, default 3080)') as HTMLInputElement
    expect(portInput.value).toBe('3080')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() =>{  expect(props.addRemote).toHaveBeenCalledWith({ alias: 'lab', target: 'ci@lab.remote.example', remotePort: 3080 }) })
    await vi.waitFor(() =>{  expect(screen.queryByLabelText('Alias')).toBeNull() })
  })

  it('the add form keeps the draft and shows a wire failure', async () => {
    const { props } = sectionHarness()
    ;(props.addRemote as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, message: 'alias already exists' })
    render(<RemotesSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add remote…' }))
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'prod' } })
    fireEvent.change(screen.getByLabelText('Target (user@host)'), { target: { value: 'ci@prod.remote.example' } })
    const portInput = screen.getByLabelText('Daemon port (shres web on the remote, default 3080)') as HTMLInputElement
    expect(portInput.value).toBe('3080')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() =>{  expect(screen.getByText('alias already exists')).toBeTruthy() })
    // Cancel closes the form without another submit.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Alias')).toBeNull()
    expect(props.addRemote).toHaveBeenCalledOnce()
  })

  it('renders the shared trust modal through the machine state', () => {
    const { props } = sectionHarness((view) => {
      view.setModal({ phase: 'confirm', alias: 'prod', inspect: {
        target: 'ci@prod.remote.example' as RemoteInspectView['target'],
        daemonVersion: '0.1.0-rc.5',
        installationId: 'abcdef1234567890abcdef',
        localVersion: '0.1.0-rc.5',
        firstConnect: true,
        trustedFingerprint: null,
      } })
    })
    render(<RemotesSection {...props} />)
    expect(screen.getByRole('dialog', { name: 'Connect to prod' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }))
    expect(props.confirmConnect).toHaveBeenCalledWith('prod', { allowVersionSkew: false, forceFingerprint: false })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.cancelModal).toHaveBeenCalledOnce()
  })

  it('the edit form submits through editRemote and closes on success', async () => {
    const { props } = sectionHarness((view) => { view.setEntries([entry('prod')]) })
    render(<RemotesSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remote actions for prod' }))
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByLabelText('Target (user@host)'), { target: { value: 'ci@prod.remote.example' } })
    fireEvent.change(screen.getByLabelText('Daemon port (shres web on the remote, default 3080)'), { target: { value: '4080' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => {
      expect(props.editRemote).toHaveBeenCalledWith('prod', { alias: 'prod', target: 'ci@prod.remote.example', remotePort: 4080 })
    })
    await vi.waitFor(() => { expect(screen.queryByLabelText('Alias')).toBeNull() })
  })

  it('retry on a failed modal re-runs connect', () => {
    const { props } = sectionHarness((view) => {
      view.setModal({ phase: 'failed', alias: 'prod', message: 'ssh hung up' })
    })
    render(<RemotesSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(props.connect).toHaveBeenCalledWith('prod')
  })

  it('shows the per-row connect busy flag', () => {
    const { props } = sectionHarness((view) => {
      view.setEntries([entry('prod')])
      view.setBusy(busyKey('connect', 'prod'), true)
    })
    render(<RemotesSection {...props} />)
    expect(screen.getByRole('button', { name: 'Connect prod' }).querySelector('[aria-hidden="true"]')).toBeTruthy()
  })
})
