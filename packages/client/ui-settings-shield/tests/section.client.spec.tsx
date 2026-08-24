// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShieldSection, type ShieldSettings } from '../src/client/ShieldSection.tsx'
import type { ShieldSnapshot } from '@shres-code/shres-code-api-remotes/client'
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

function emptyStats(cwd: string | null = null): ShieldSnapshot['stats'] {
  return {
    cwd,
    screened: 0,
    observed: 0,
    asked: 0,
    askedGranted: 0,
    askedDenied: 0,
    blocked: 0,
    byChannel: {},
    byRule: {},
    otherRules: { observed: 0, asked: 0, blocked: 0 },
    recent: [],
  }
}

function consoleSnapshot(partial: Partial<ShieldSnapshot> = {}): ShieldSnapshot {
  return {
    status: { active: true, reason: 'active' },
    stats: emptyStats('/repo'),
    ...partial,
  }
}

function repoLabel(cwd: string): string {
  return `${en.console} · ${cwd}`
}

async function readyConsole(cwd = '/repo'): Promise<void> {
  expect(await screen.findByText((_, node) => node?.textContent === repoLabel(cwd))).toBeTruthy()
}

function mount(
  snap: SettingsScopeSnapshot<ShieldSettings>,
  set = vi.fn(async () => {}),
  loadSnapshot: (sessionId?: string) => Promise<ShieldSnapshot> = () => Promise.resolve(consoleSnapshot()),
  currentSessionId: string | null = 's-test',
) {
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
      loadSnapshot={loadSnapshot}
      useSessions={select => select({ current: currentSessionId ?? undefined } as never)}
      useWorkspaces={() => undefined as never}
      close={vi.fn()}
    />,
  )
  return { set }
}

describe('ShieldSection', () => {
  it('toggles the activate switch and publishes the mark lockup', async () => {
    const { set } = mount(snapshot({ value: { enabled: true, posture: 'ask' } }))
    await readyConsole()
    fireEvent.click(screen.getByRole('switch', { name: en.disable }))
    expect(set).toHaveBeenCalledWith('enabled', false)
    expect(document.documentElement.dataset.shresShield).toBe('off')
    expect(screen.getByText(en.active)).toBeTruthy()
  })

  it('writes posture on change', async () => {
    const { set } = mount(snapshot({}))
    await readyConsole()
    fireEvent.change(screen.getByLabelText(en.posture), { target: { value: 'enforce' } })
    expect(set).toHaveBeenCalledWith('posture', 'enforce')
  })

  it('applies a typed license', async () => {
    const { set } = mount(snapshot({}))
    await readyConsole()
    fireEvent.change(screen.getByLabelText(en.license), { target: { value: ' paid-key ' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(set).toHaveBeenCalledWith('license', 'paid-key')
  })

  it('shows empty stats as zeros and an em-dash repo path', async () => {
    mount(snapshot({}), vi.fn(async () => {}), () => Promise.resolve(consoleSnapshot({
      stats: emptyStats(null),
    })))
    expect(await screen.findByText((_, node) => node?.textContent === repoLabel('—'))).toBeTruthy()
    const counts = [...screen.getByRole('region', { name: en.console }).querySelectorAll('dd')]
      .map(node => node.textContent)
    expect(counts).toEqual(['0', '0', '0', '0'])
    expect(screen.getByText(en.noFindings)).toBeTruthy()
    expect(screen.getByText(en.noPatterns)).toBeTruthy()
    expect(screen.getByText((_, node) => node?.textContent === `${en.definitions} · —`)).toBeTruthy()
  })

  it('lists top byRule patterns from the snapshot', async () => {
    mount(
      snapshot({}),
      vi.fn(async () => {}),
      () => Promise.resolve(consoleSnapshot({
        stats: {
          ...emptyStats('/repo'),
          screened: 4,
          byRule: {
            'deny-keylogger': { observed: 0, asked: 0, blocked: 3 },
            'ask-rm-rf': { observed: 0, asked: 2, blocked: 0 },
          },
        },
      })),
    )
    expect(await screen.findByText('deny-keylogger · blocked 3 · asked 0 · observed 0')).toBeTruthy()
    expect(screen.getByText('ask-rm-rf · blocked 0 · asked 2 · observed 0')).toBeTruthy()
    expect(screen.getByText(en.patterns)).toBeTruthy()
  })

  it('keeps persisted counts visible when Shield is disabled', async () => {
    mount(
      snapshot({ value: { enabled: false, posture: 'ask' } }),
      vi.fn(async () => {}),
      () => Promise.resolve(consoleSnapshot({
        status: { active: false, reason: 'disabled' },
        stats: {
          ...emptyStats('/repo'),
          screened: 12,
          asked: 3,
          blocked: 1,
          observed: 4,
        },
      })),
    )
    expect(await screen.findByText('12')).toBeTruthy()
    expect(screen.getByText(en.inactive)).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.activate })).toBeTruthy()
  })

  it('shows settings loading without blanking a ready console', async () => {
    mount(
      snapshot({ status: 'loading', value: undefined, writable: false }),
      vi.fn(async () => {}),
      () => Promise.resolve(consoleSnapshot({ stats: { ...emptyStats('/repo'), screened: 8 } })),
    )
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(await screen.findByText('8')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('shows a generic console failure while the form stays usable', async () => {
    mount(snapshot({}), vi.fn(async () => {}), () => Promise.reject(new Error('transport')))
    expect((await screen.findByRole('alert')).textContent).toBe(en.snapshotUnavailable)
    expect(screen.queryByText('transport')).toBeNull()
    expect(screen.getByRole('switch', { name: en.disable })).toBeTruthy()
  })

  it('retries a failed snapshot load', async () => {
    const loadSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('transport'))
      .mockResolvedValueOnce(consoleSnapshot({ stats: { ...emptyStats('/repo'), screened: 5 } }))
    mount(snapshot({}), vi.fn(async () => {}), loadSnapshot)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByText('5')).toBeTruthy()
  })

  it('ignores a snapshot that resolves after unmount', async () => {
    const deferred = Promise.withResolvers<ShieldSnapshot>()
    const view = render(
      <ShieldSection
        scope={{
          getSnapshot: () => snapshot({}),
          subscribe: () => () => {},
          set: vi.fn(async () => {}),
          unset: vi.fn(async () => {}),
        } as unknown as SettingsScope<ShieldSettings>}
        useSnapshot={select => select(snapshot({}))}
        t={key => en[key]}
        loadSnapshot={() => deferred.promise}
        useSessions={select => select({ current: 's-test' } as never)}
        useWorkspaces={() => undefined as never}
        close={vi.fn()}
      />,
    )
    expect(screen.getByText(en.snapshotLoading)).toBeTruthy()
    view.unmount()
    await act(async () => {
      deferred.resolve(consoleSnapshot({ stats: { ...emptyStats('/late'), screened: 9 } }))
    })
    expect(screen.queryByText('9')).toBeNull()
  })

  it('lists recent findings and a definition stamp', async () => {
    mount(snapshot({}), vi.fn(async () => {}), () => Promise.resolve(consoleSnapshot({
      stats: {
        ...emptyStats('/repo'),
        recent: [{
          at: 1_700_000_000_000,
          verdict: 'deny',
          rule: 'sig.literal',
          channel: 'tool_result',
          sha16: '0123456789abcdef',
          host: 'example.com',
        }],
      },
      definitions: { version: 'v12', updatedAt: 1_700_000_100_000, stale: false },
    })))
    expect(await screen.findByText(/Blocked · tool_result · sig.literal · example.com/)).toBeTruthy()
    expect(screen.getByText((_, node) => node?.textContent === `${en.definitions} · v12 · ${new Date(1_700_000_100_000).toISOString()}`)).toBeTruthy()
  })

  it('shows the definition version when updatedAt is null', async () => {
    mount(snapshot({}), vi.fn(async () => {}), () => Promise.resolve(consoleSnapshot({
      definitions: { version: 'v12', updatedAt: null, stale: true },
    })))
    expect(await screen.findByText((_, node) => node?.textContent === `${en.definitions} · v12 · —`)).toBeTruthy()
  })

  it('passes the current session id to snapshot and hides a foreign cwd without one', async () => {
    const loadSnapshot = vi.fn((sessionId?: string) => Promise.resolve(consoleSnapshot({
      stats: emptyStats(sessionId === undefined ? '/other' : '/repo'),
    })))
    mount(snapshot({}), vi.fn(async () => {}), loadSnapshot, 's-current')
    await readyConsole('/repo')
    expect(loadSnapshot).toHaveBeenCalledWith('s-current')
    cleanup()
    mount(snapshot({}), vi.fn(async () => {}), loadSnapshot, null)
    expect(await screen.findByText((_, node) => node?.textContent === repoLabel('—'))).toBeTruthy()
    expect(loadSnapshot).toHaveBeenLastCalledWith(undefined)
  })

  it('lists an asked finding and a stored license placeholder', async () => {
    mount(
      snapshot({ value: { posture: 'ask', license: 'stored-key' } }),
      vi.fn(async () => {}),
      () => Promise.resolve(consoleSnapshot({
        stats: {
          ...emptyStats('/repo'),
          recent: [{
            at: 1_700_000_000_000,
            verdict: 'ask',
            rule: 'sig.ask',
            channel: 'tool_args',
            sha16: 'dddddddddddddddd',
          }],
        },
      })),
    )
    expect(await screen.findByText(/Asked · tool_args · sig.ask · /)).toBeTruthy()
    expect((screen.getByLabelText(en.license) as HTMLInputElement).placeholder).toBe(en.licenseStored)
  })

  it('shows applying while a license write is in flight', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const set = vi.fn(() => pending)
    mount(snapshot({}), set)
    await readyConsole()
    fireEvent.change(screen.getByLabelText(en.license), { target: { value: 'next-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(await screen.findByRole('button', { name: en.applying })).toBeTruthy()
    await act(async () => { finish() })
    expect(await screen.findByRole('button', { name: en.apply })).toBeTruthy()
  })

  it('ignores a snapshot that rejects after unmount', async () => {
    const deferred = Promise.withResolvers<ShieldSnapshot>()
    const view = render(
      <ShieldSection
        scope={{
          getSnapshot: () => snapshot({}),
          subscribe: () => () => {},
          set: vi.fn(async () => {}),
          unset: vi.fn(async () => {}),
        } as unknown as SettingsScope<ShieldSettings>}
        useSnapshot={select => select(snapshot({}))}
        t={key => en[key]}
        loadSnapshot={() => deferred.promise}
        useSessions={select => select({ current: 's-test' } as never)}
        useWorkspaces={() => undefined as never}
        close={vi.fn()}
      />,
    )
    view.unmount()
    await act(async () => { deferred.reject(new Error('late')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lists an observe finding without a host', async () => {
    mount(snapshot({}), vi.fn(async () => {}), () => Promise.resolve(consoleSnapshot({
      stats: {
        ...emptyStats('/repo'),
        recent: [{
          at: 1_700_000_000_000,
          verdict: 'observe',
          rule: 'sig.note',
          channel: 'user_message',
          sha16: 'cccccccccccccccc',
        }],
      },
    })))
    expect(await screen.findByText(/Observed · user_message · sig.note · /)).toBeTruthy()
  })

  it('keeps counts visible when the settings document is read-only', async () => {
    mount(
      snapshot({ writable: false, value: { enabled: true, posture: 'ask' } }),
      vi.fn(async () => {}),
      () => Promise.resolve(consoleSnapshot({ stats: { ...emptyStats('/repo'), screened: 2 } })),
    )
    expect(await screen.findByText('2')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect((screen.getByRole('switch', { name: en.disable }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores an unknown posture value', async () => {
    const { set } = mount(snapshot({}))
    await readyConsole()
    fireEvent.change(screen.getByLabelText(en.posture), { target: { value: 'nope' } })
    expect(set).not.toHaveBeenCalled()
  })

  it('exempts the current repo through the repos map', async () => {
    const { set } = mount(snapshot({}))
    await readyConsole('/repo')
    fireEvent.click(screen.getByRole('switch', { name: en.repoExemptAction }))
    expect(set).toHaveBeenCalledWith('repos', { '/repo': { enabled: false } })
  })

  it('restores screening by removing the current repo entry', async () => {
    const { set } = mount(snapshot({ value: { posture: 'ask', repos: { '/repo': { enabled: false } } } }))
    await readyConsole('/repo')
    fireEvent.click(screen.getByRole('switch', { name: en.repoRestore }))
    expect(set).toHaveBeenCalledWith('repos', {})
  })

  it('lists exempt repos sorted with a remove action', async () => {
    const { set } = mount(snapshot({
      value: { posture: 'ask', repos: { '/repo/b': { enabled: false }, '/repo/a': { enabled: false } } },
    }))
    await readyConsole('/repo')
    const rows = screen.getByRole('list')
    const items = [...rows.querySelectorAll('li')].map(li => li.querySelector('span')?.textContent)
    expect(items).toEqual(['/repo/a', '/repo/b'])
    fireEvent.click([...rows.querySelectorAll('button')][1] as HTMLElement)
    expect(set).toHaveBeenCalledWith('repos', { '/repo/a': { enabled: false } })
  })

  it('shows the empty exemption state and disables the repo switch without a cwd', async () => {
    mount(snapshot({}), vi.fn(async () => {}), () => Promise.resolve(consoleSnapshot({
      stats: emptyStats(null),
    })))
    expect(await screen.findByText(en.noRepos)).toBeTruthy()
    expect(screen.getByText(en.repoUnknown)).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: en.repoExemptAction }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
  })

  it('marks the current repo exempt in its own toggle while the master stays on', async () => {
    mount(snapshot({ value: { enabled: true, posture: 'ask', repos: { '/repo': { enabled: false } } } }))
    expect(await screen.findByText(en.repoExempt)).toBeTruthy()
    expect(screen.getByText(en.active)).toBeTruthy()
  })

  it('publishes the mark from the per-session snapshot status', async () => {
    mount(
      snapshot({}),
      vi.fn(async () => {}),
      () => Promise.resolve(consoleSnapshot({
        status: { active: false, reason: 'repo-disabled' },
        stats: emptyStats('/repo'),
      })),
    )
    await waitFor(() => {
      expect(document.documentElement.dataset.shresShield).toBe('off')
    })
  })

  it('explains when the host seat is not mounted and the console also fails', async () => {
    mount(
      snapshot({ status: 'unavailable', value: undefined, writable: false }),
      vi.fn(async () => {}),
      () => Promise.reject(new Error('missing')),
    )
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    })
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
