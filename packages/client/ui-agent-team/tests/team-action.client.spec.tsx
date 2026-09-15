// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamAction, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sessionId = 'team-root' as never

function roster(members: unknown[]) {
  return { sessionId, isTeam: true, members } as never
}

function renderTeam(over: Partial<TeamActionProps> = {}) {
  const load = vi.fn(async () => roster([]))
  const openTeammate = vi.fn()
  const props = {
    sessionId,
    load: over.load ?? load,
    openTeammate: over.openTeammate ?? openTeammate,
    t: (key: keyof typeof en) => en[key],
    ...over,
  } as TeamActionProps
  const result = render(<TeamAction {...props} />)
  return { load, openTeammate, container: result.container }
}

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
})
