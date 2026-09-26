// @vitest-environment jsdom
/**
 * The workspace overview: the reader polls while the page is visible and
 * stops on disposal, a stale read never lands on a newer selection, and the
 * card renders the read's numbers, offers a row's Routing view handoff, and
 * names its failure with a retry.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { ModelRoutingStatsRange, ModelRoutingWorkspaceStats } from '@shres-code/shres-code-model-router/client'
import { OverviewCard } from '../src/client/OverviewCard.tsx'
import type { OverviewCardProps } from '../src/client/OverviewCard.tsx'
import { createOverviewController, overviewWorkspace, OVERVIEW_POLL_MS } from '../src/client/overview.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** The locale seat's resolver, as the section spec renders it. */
function t(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name]))
}

/** A workspace rollup as the Host returns it. */
const STATS: ModelRoutingWorkspaceStats = {
  workspaceId: 'w1',
  range: '24h',
  computedAt: Date.parse('2026-09-26T10:00:00Z'),
  sessions: { members: 3, summarized: 2, inRange: 2, included: 2, capped: false },
  counts: {
    decisions: 12, consults: 9, downgradedSteps: 7, steps: 40, streaks: 3, keptStrong: 2,
    routeFailed: 1, judgeFailed: 0, deadlineHits: 0, warmUps: 0, turnsWithDecisions: 8, warmSkipped: 1,
  },
  reasons: [
    { reason: 'gate-passed', group: 'switched', count: 6 },
    { reason: 'low-confidence', group: 'judge-no', count: 3 },
    { reason: 'engine-unavailable', group: 'engine', count: 2 },
  ],
  routedSwitches: { count: 4, tokens: 51_200 },
  rows: [
    { sessionId: 's1', lastDecisionAt: 20, decisions: 8, steps: 30, downgradedSteps: 5 },
    { sessionId: 's2', lastDecisionAt: 10, decisions: 4, steps: 10, downgradedSteps: 2 },
  ],
}

const OK = { ok: true as const, value: STATS }

/** Let the reader's microtask chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

/** jsdom's document visibility, replaceable per test. */
function setVisible(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('overviewWorkspace', () => {
  const list = (items: { workspaceId: string; sessionIds: string[] }[], recentWorkspaceId?: string) =>
    ({ items, recentWorkspaceId }) as never

  it('reads the workspace that accounts the current session, else the recent one', () => {
    const w1 = { workspaceId: 'w1', title: 'One', sessionIds: ['s1'] }
    const w2 = { workspaceId: 'w2', title: 'Two', sessionIds: ['s2'] }
    expect(overviewWorkspace(list([w1, w2], 'w2'), 's2' as never)?.workspaceId).toBe('w2')
    expect(overviewWorkspace(list([w1, w2], 'w2'), 's1' as never)?.workspaceId).toBe('w1')
    expect(overviewWorkspace(list([w1, w2]), 's1' as never)?.workspaceId).toBe('w1')
    expect(overviewWorkspace(list([w1, w2], 'w2'), undefined)?.workspaceId).toBe('w2')
    expect(overviewWorkspace(list([]), undefined)).toBeUndefined()
  })
})

describe('overview controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisible('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
    setVisible('visible')
  })

  it('reads the watched workspace at once, then again every poll while visible', async () => {
    const read = vi.fn(() => Promise.resolve(OK))
    const controller = createOverviewController(read)
    controller.watch('w1')
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({ workspaceId: 'w1', range: '24h' })
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', workspaceId: 'w1', stats: STATS })
    await actAdvance(OVERVIEW_POLL_MS)
    expect(read).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('stops the poll while the page is hidden and reads at once when it returns stale', async () => {
    const read = vi.fn(() => Promise.resolve(OK))
    const controller = createOverviewController(read)
    controller.watch('w1')
    await flush()
    await actAdvance(OVERVIEW_POLL_MS)
    expect(read).toHaveBeenCalledTimes(2)
    setVisible('hidden')
    await actAdvance(OVERVIEW_POLL_MS * 3)
    expect(read).toHaveBeenCalledTimes(2)
    // The last read is older than the interval, so visibility reads at once.
    setVisible('visible')
    await flush()
    expect(read).toHaveBeenCalledTimes(3)
    controller.dispose()
  })

  it('does not read again on visibility when the last read is fresh', async () => {
    const read = vi.fn(() => Promise.resolve(OK))
    const controller = createOverviewController(read)
    controller.watch('w1')
    await flush()
    setVisible('hidden')
    setVisible('visible')
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('replaces a result with the new range, and a stale read never lands', async () => {
    let resolveFirst!: (value: { ok: true; value: ModelRoutingWorkspaceStats }) => void
    const first = new Promise<{ ok: true; value: ModelRoutingWorkspaceStats }>((resolve) => { resolveFirst = resolve })
    const read = vi.fn().mockImplementationOnce(() => first).mockResolvedValueOnce({ ...OK, value: { ...STATS, range: '7d' as ModelRoutingStatsRange } })
    const controller = createOverviewController(read)
    controller.watch('w1')
    controller.setRange('7d')
    expect(controller.store.getSnapshot()).toMatchObject({ range: '7d', stats: null })
    // The read of the 24h selection settles after the switch: ignored.
    resolveFirst(OK)
    await flush()
    expect(controller.store.getSnapshot()).toMatchObject({ range: '7d', status: 'ready', stats: { range: '7d' } })
    expect(read).toHaveBeenLastCalledWith({ workspaceId: 'w1', range: '7d' })
    controller.dispose()
  })

  it('keeps the previous numbers beside a failed read', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'internal', message: 'modelRouting.stats: no workspace "w9"' } })
    const controller = createOverviewController(read)
    controller.watch('w1')
    await flush()
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'modelRouting.stats: no workspace "w9"', stats: STATS })
    controller.dispose()
  })

  it('shows a thrown read as the error, and retry reads again', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(OK)
    const controller = createOverviewController(read)
    controller.watch('w1')
    await flush()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'connection lost' })
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', error: null, stats: STATS })
    controller.dispose()
  })

  it('stops reading after disposal, and a read still in flight is ignored', async () => {
    let resolveFirst!: (value: { ok: true; value: ModelRoutingWorkspaceStats }) => void
    type StatsOutcome = { ok: true; value: ModelRoutingWorkspaceStats }
    const read = vi.fn().mockImplementationOnce(
      () => new Promise<StatsOutcome>((resolve) => { resolveFirst = resolve }),
    )
    const controller = createOverviewController(read)
    const stop = controller.watch('w1')
    controller.dispose()
    stop()
    resolveFirst(OK)
    await flush()
    // The stale result never lands, and nothing reads again.
    expect(controller.store.getSnapshot().stats).toBeNull()
    setVisible('hidden')
    setVisible('visible')
    await actAdvance(OVERVIEW_POLL_MS * 2)
    expect(read).toHaveBeenCalledTimes(1)
  })
})

/** Advance fake timers inside act so store notifications reach subscribers. */
async function actAdvance(ms: number): Promise<void> {
  const { act } = await import('@testing-library/react')
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Session titles, as the shell's session list serves them. */
type OverviewCardTitles = Readonly<Record<string, { displayTitle: string } | undefined>>

/** Card options a test can set. */
function cardProps(controller: ReturnType<typeof createOverviewController>, overrides: {
  workspace?: { id: string; title: string } | undefined
  titles?: OverviewCardTitles
  openRoutingView?: ((sessionId: string) => void) | undefined
  close?: () => void
} = {}) {
  return {
    controller,
    workspace: 'workspace' in overrides ? overrides.workspace : { id: 'w1', title: 'Alpha repo' },
    titles: overrides.titles ?? {},
    openRoutingView: overrides.openRoutingView,
    close: overrides.close ?? (() => {}),
    t: t as never,
  }
}

/**
 * Render the card the way the section's slot renderer does: a bound hook
 * subscribes the card to the reader's snapshot.
 */
function MountCard({ controller, ...props }: Omit<OverviewCardProps, 'overview'> & {
  controller: ReturnType<typeof createOverviewController>
}): ReactNode {
  const useOverview = bindSnapshotSelector(controller.store)
  const overview = useOverview(snapshot => snapshot)
  return <OverviewCard controller={controller} {...props} overview={overview} />
}

describe('OverviewCard', () => {
  it('renders the four KPIs, the reasons chart, and the session table of a ready read', async () => {
    const controller = createOverviewController(() => Promise.resolve(OK))
    render(<MountCard {...cardProps(controller, {
      titles: { s1: { displayTitle: 'Fix the router' }, s2: { displayTitle: 'Write docs' } },
      openRoutingView: vi.fn(),
    })} />)
    await screen.findByText(t('overview.kpi.sessions'))
    expect(screen.getByText('17.5%')).toBeTruthy()
    expect(screen.getByText('51.2K')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Decision reasons across sessions: gate-passed 6, low-confidence 3, engine-unavailable 2' })).toBeTruthy()
    const table = screen.getByRole('table', { name: 'Sessions, most recent decision first' })
    expect(within(table).getByText('Fix the router')).toBeTruthy()
    expect(within(table).getByText('Write docs')).toBeTruthy()
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent.includes('2 of 2 sessions in range') && element.textContent.includes('refreshes every 60 s while visible.'))).toBeTruthy()
  })

  it('hands a row to openRoutingView, closes the page, and reports a failed handoff', async () => {
    const open = vi.fn()
    const close = vi.fn()
    const controller = createOverviewController(() => Promise.resolve(OK))
    render(<MountCard {...cardProps(controller, { titles: { s1: { displayTitle: 'Fix the router' } }, openRoutingView: open, close })} />)
    await screen.findByText(t('overview.kpi.sessions'))
    fireEvent.click(screen.getByRole('button', { name: 'Open the Routing view of Fix the router' }))
    expect(open).toHaveBeenCalledWith('s1')
    expect(close).toHaveBeenCalledTimes(1)
    cleanup()
    const failing = vi.fn(() => { throw new Error('ui-conversation: no conversation view "routing" to reveal') })
    const failingController = createOverviewController(() => Promise.resolve(OK))
    render(<MountCard {...cardProps(failingController, { titles: { s1: { displayTitle: 'Fix the router' } }, openRoutingView: failing, close })} />)
    await screen.findByText(t('overview.kpi.sessions'))
    fireEvent.click(screen.getByRole('button', { name: 'Open the Routing view of Fix the router' }))
    expect(close).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe('The Routing view could not be opened: ui-conversation: no conversation view "routing" to reveal')
  })

  it('offers no row handoff without the conversation service, and no numbers without a workspace', async () => {
    const controller = createOverviewController(() => Promise.resolve(OK))
    render(<MountCard {...cardProps(controller, { openRoutingView: undefined })} />)
    await screen.findByText(t('overview.kpi.sessions'))
    expect(screen.queryByRole('button', { name: /Open the Routing view/ })).toBeNull()
    cleanup()
    const bare = createOverviewController(() => Promise.resolve(OK))
    render(<MountCard {...cardProps(bare, { workspace: undefined })} />)
    expect(screen.getByText(t('overview.noWorkspace'))).toBeTruthy()
    expect(screen.queryByText(t('overview.kpi.sessions'))).toBeNull()
  })

  it('names the failed read and retries it', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(OK)
    const controller = createOverviewController(read)
    render(<MountCard {...cardProps(controller)} />)
    await screen.findByRole('alert')
    // The alert paragraph also carries the Retry button.
    expect(screen.getByRole('alert').textContent).toContain('The workspace overview could not be read: connection lost')
    fireEvent.click(screen.getByRole('button', { name: t('retry') }))
    await waitFor(() => { expect(screen.getByText(t('overview.kpi.sessions'))).toBeTruthy() })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('says when sessions were left out by the cap or never summarized', async () => {
    const capped = { ...STATS, sessions: { ...STATS.sessions, capped: true, inRange: 600 } }
    const controller = createOverviewController(() => Promise.resolve({ ok: true as const, value: capped }))
    render(<MountCard {...cardProps(controller)} />)
    await screen.findByText(t('overview.kpi.sessions'))
    expect(screen.getByText('Only the 2 most recently routed sessions are included.')).toBeTruthy()
    expect(screen.getByText('1 session in this workspace has no statistics until it is opened.')).toBeTruthy()
  })

  it('uses singular count copy for a one-session workspace', async () => {
    const one = {
      ...STATS,
      sessions: { members: 1, summarized: 1, inRange: 1, included: 1, capped: false },
      routedSwitches: { count: 1, tokens: 1200 },
      rows: [STATS.rows[0]!],
    }
    const controller = createOverviewController(() => Promise.resolve({ ok: true as const, value: one }))
    render(<MountCard {...cardProps(controller)} />)
    await screen.findByText(t('overview.kpi.sessions'))
    expect(screen.getByText('of 1 session in this workspace')).toBeTruthy()
    expect(screen.getByText('tokens re-prefilled after 1 routed switch and return')).toBeTruthy()
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent.includes('1 of 1 session in range'))).toBeTruthy()
    expect(screen.queryByText(/sessions in this workspace have no statistics/)).toBeNull()
  })
})
