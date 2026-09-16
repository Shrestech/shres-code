// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rosterFromView, TeamAction, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sessionId = 'team-root' as never

function roster(members: unknown[], id: string = sessionId) {
  return { sessionId: id, isTeam: true, members } as never
}

const t = ((key: keyof typeof en) => en[key]) as TeamActionProps['t']

function renderTeam(over: Partial<TeamActionProps> = {}) {
  const load = vi.fn(async () => roster([]))
  const openTeammate = vi.fn()
  const props = {
    sessionId,
    load: over.load ?? load,
    openTeammate: over.openTeammate ?? openTeammate,
    t,
    ...over,
  } as TeamActionProps
  const result = render(<TeamAction {...props} />)
  return { load, openTeammate, ...result }
}

describe('rosterFromView', () => {
  it('returns the roster value and throws on a failed view call', () => {
    const value = { sessionId, isTeam: true, members: [] }
    expect(rosterFromView({ result: { ok: true, value } } as never)).toEqual(value)
    expect(() => rosterFromView({
      result: { ok: false, error: { message: 'view failed' } },
    } as never)).toThrow(/view failed/)
  })
})

describe('TeamAction', () => {
  it('renders nothing for sessions that are not Team Leads', async () => {
    const load = vi.fn(async () => ({ sessionId, isTeam: false, members: [] }) as never)
    const { container } = renderTeam({ load: load as never })
    await waitFor(() => {
      expect(load).toHaveBeenCalled()
    })
    expect(container.querySelector('button')).toBeNull()
  })

  it('lists roster rows and opens a teammate conversation from its row', async () => {
    const members = [
      { name: 'lead', role: 'lead', status: 'running', id: '', diagnostics: [] },
      { name: 'aegis', role: 'teammate', status: 'idle', id: 'aegis-child', model: 'kimi-k3', diagnostics: [] },
    ]
    const load = vi.fn(async () => roster(members))
    const { openTeammate } = renderTeam({ load: load as never })
    fireEvent.click(await screen.findByText(en.teamAction))
    expect(screen.getByText(en.teamPanelTitle)).toBeTruthy()
    expect(screen.getByText('aegis')).toBeTruthy()
    fireEvent.click(screen.getByText(en.teamOpenConversation))
    expect(openTeammate).toHaveBeenCalledWith(sessionId, expect.objectContaining({ name: 'aegis' }))
  })

  it('keeps the Lead row and unprovisioned rows non-navigable and shows diagnostics', async () => {
    const members = [
      { name: 'lead', role: 'lead', status: 'running', id: '', diagnostics: [] },
      { name: 'aegis', role: 'teammate', status: 'unstarted', id: 'unprovisioned:aegis', diagnostics: [] },
      { name: 'docs-reviewer', role: 'teammate', status: 'failed', id: 'docs-child', diagnostics: ['spawn rejected'] },
    ]
    const openTeammate = vi.fn()
    const load = vi.fn(async () => roster(members))
    renderTeam({ load: load as never, openTeammate: openTeammate as never })
    fireEvent.click(await screen.findByText(en.teamAction))
    expect(screen.getByText(/spawn rejected/)).toBeTruthy()
    const openButtons = screen.queryAllByText(en.teamOpenConversation)
    expect(openButtons).toHaveLength(0)
    expect(openTeammate).not.toHaveBeenCalled()
  })

  it('shows the empty copy for a Lead with no teammates', async () => {
    renderTeam()
    fireEvent.click(await screen.findByText(en.teamAction))
    expect(screen.getByText(en.teamEmpty)).toBeTruthy()
  })

  it('reloads the roster when the panel opens', async () => {
    const members = [
      { name: 'lead', role: 'lead', status: 'running', id: '', diagnostics: [] },
    ]
    const load = vi.fn(async () => roster(members))
    renderTeam({ load: load as never })
    const trigger = await screen.findByText(en.teamAction)
    expect(load).toHaveBeenCalledTimes(1)
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2)
    })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(3)
    })
  })

  it('shows retry after a first-load failure and hides when retry reports a non-team session', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('view failed'))
      .mockRejectedValueOnce(new Error('view failed'))
      .mockResolvedValueOnce({ sessionId, isTeam: false, members: [] })
    const { container } = renderTeam({ load: load as never })
    fireEvent.click(await screen.findByText(en.teamAction))
    expect(screen.getByText(en.teamLoadFailed)).toBeTruthy()
    fireEvent.click(screen.getByText(en.teamRetry))
    await waitFor(() => {
      expect(container.querySelector('button')).toBeNull()
    })
  })

  it('keeps the last roster when a later reload fails', async () => {
    const members = [
      { name: 'lead', role: 'lead', status: 'running', id: '', diagnostics: [] },
      { name: 'aegis', role: 'teammate', status: 'idle', id: 'aegis-child', diagnostics: [] },
    ]
    const load = vi.fn()
      .mockResolvedValueOnce(roster(members))
      .mockRejectedValueOnce(new Error('view failed'))
    renderTeam({ load: load as never })
    fireEvent.click(await screen.findByText(en.teamAction))
    await waitFor(() => {
      expect(screen.getByText('aegis')).toBeTruthy()
    })
    await waitFor(() => {
      expect(screen.getByText(en.teamLoadFailed)).toBeTruthy()
    })
    expect(screen.getByText('aegis')).toBeTruthy()
  })

  it('ignores a stale roster read after the session changes', async () => {
    let resolveFirst!: (value: never) => void
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValue(roster(
        [{ name: 'lead', role: 'lead', status: 'running', id: '', diagnostics: [] }],
        'other-root',
      ))
    const { rerender } = renderTeam({ load: load as never })
    rerender(
      <TeamAction {...{
        sessionId: 'other-root' as never,
        load: load as never,
        openTeammate: vi.fn(),
        t,
      } as TeamActionProps} />,
    )
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2)
    })
    resolveFirst(roster(
      [{ name: 'stale', role: 'teammate', status: 'idle', id: 'stale-child', diagnostics: [] }],
    ))
    await screen.findByText(en.teamAction)
    fireEvent.click(screen.getByText(en.teamAction))
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.getByText('lead')).toBeTruthy()
  })

  it('ignores a stale load rejection after the session changes', async () => {
    let rejectFirst!: (error: Error) => void
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirst = reject
      }))
      .mockResolvedValue({ sessionId: 'other-root', isTeam: false, members: [] })
    const { rerender, container } = renderTeam({ load: load as never })
    rerender(
      <TeamAction {...{
        sessionId: 'other-root' as never,
        load: load as never,
        openTeammate: vi.fn(),
        t,
      } as TeamActionProps} />,
    )
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2)
    })
    rejectFirst(new Error('stale fail'))
    await waitFor(() => {
      expect(container.querySelector('button')).toBeNull()
    })
    expect(screen.queryByText(en.teamLoadFailed)).toBeNull()
  })
})
