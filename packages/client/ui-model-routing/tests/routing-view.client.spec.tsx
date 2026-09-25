// @vitest-environment jsdom
/**
 * The Routing view over the `modelRoutingStats` and `modelRouting`
 * projections: the read-only status line, the states, the verdict and KPI
 * tiles, G1 to G6 with their text alternatives, Table views, and focusable
 * marks, the recent decisions with paging, the drill-down (loading, failure,
 * retry, every section), the handoffs to Trajectory and the one from
 * Trajectory, and two sessions rendering independent views.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type {
  ModelRoutingDecisionDetail, ModelRoutingGateView, ModelRoutingProjection, ModelRoutingStatsSnapshot,
} from '@shres-code/shres-code-model-router/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import { RoutingView, type RoutingViewProps } from '../src/client/view/RoutingView.tsx'
import { activeStats, decisionDetail, emptyStats, GATE, liveStats, OFF, ON } from './fixtures/routing-stats.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn)

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface Setup {
  stats?: ModelRoutingStatsSnapshot | undefined
  routing?: ModelRoutingProjection | undefined
  available?: boolean
  loadGate?: () => Promise<ModelRoutingGateView>
  loadDecision?: (seq: number) => Promise<ModelRoutingDecisionDetail>
  reveal?: RoutingViewProps['reveal']
  canReveal?: RoutingViewProps['canReveal']
  inspect?: unknown
  onInspectDone?: () => void
}

function props(options: Setup): RoutingViewProps {
  const store = createSnapshotStore<{ values: Record<string, unknown> }>({
    values: { modelRoutingStats: 'stats' in options ? options.stats : liveStats(), modelRouting: 'routing' in options ? options.routing : ON },
  })
  const useProjection = (key: string, selector?: (value: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (value => value))(s.values[key]))
  return {
    useProjection,
    available: options.available ?? true,
    loadGate: options.loadGate ?? (() => Promise.resolve(GATE)),
    loadDecision: options.loadDecision ?? ((seq: number) => Promise.resolve({ ...decisionDetail(), seq })),
    reveal: options.reveal,
    canReveal: options.canReveal,
    inspect: options.inspect ?? null,
    onInspectDone: options.onInspectDone,
    t,
  } as unknown as RoutingViewProps
}

function setup(options: Setup = {}) {
  return render(<RoutingView {...props(options)} />)
}

const gateLoaded = () => screen.findByText(/switching requires 0\.80/)

describe('RoutingView availability and states', () => {
  it('renders a notice for a subagent session or a host without routing', () => {
    setup({ available: false })
    expect(screen.getByText(en['view.unavailable'])).toBeTruthy()
    cleanup()
    setup({ routing: undefined })
    expect(screen.getByText(en['view.unavailable'])).toBeTruthy()
    cleanup()
    setup({ stats: undefined })
    expect(screen.getByText(en['view.unavailable'])).toBeTruthy()
  })

  it('shows the empty-state card and the mode read-only when routing was never used', () => {
    setup({ stats: emptyStats(), routing: OFF })
    expect(screen.getByText(en['state.neverUsed'])).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.queryByText(en['kpi.decisions'])).toBeNull()
    // The view carries no mode control: the inline Auto pill is not a button.
    expect(screen.queryByRole('button', { name: /Auto/ })).toBeNull()
  })

  it('warns when no engine is available, the base is unlisted, or the engine failed', () => {
    const stats = liveStats()
    setup({ stats: { ...stats, recent: [{ ...stats.recent[0]!, reason: 'engine-absent' }] } })
    expect(screen.getByText(en['state.noEngine'])).toBeTruthy()
    cleanup()
    setup({ stats: { ...stats, recent: [{ ...stats.recent[0]!, reason: 'base-unlisted' }] } })
    expect(screen.getByText("Routing can't run from claude-session/claude-opus-5-5: it is not in Route from.")).toBeTruthy()
    cleanup()
    setup({ stats: { ...emptyStats(), counts: { ...emptyStats().counts, decisions: 1 }, recent: [{ ...stats.recent[0]!, reason: 'base-unlisted' }] } })
    expect(screen.getByText("Routing can't run from this model: it is not in Route from.")).toBeTruthy()
    cleanup()
    setup({ stats: activeStats() })
    expect(screen.getByText(en['state.engineTrouble'])).toBeTruthy()
  })

  it('shows the verdict with the Off suffix and the KPI tiles', async () => {
    setup({ routing: OFF })
    await gateLoaded()
    expect(screen.getByText('Routing kept the strong model on all 22 decisions.')).toBeTruthy()
    expect(screen.getByText(/Routing is Off for this session now/)).toBeTruthy()
    const tile = document.querySelector('[data-kpi="latency"]')!
    expect(tile.textContent).toBe('Judge latency1000 ms P50P95 1 s · deadline 1.5 s')
  })

  it('reports a gate that failed to load and retries it', async () => {
    const loadGate = vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce('plain')
      .mockResolvedValue(GATE)
    setup({ loadGate })
    expect((await screen.findByRole('alert')).textContent).toContain('The routing thresholds could not be loaded: nope.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect((await screen.findByRole('alert')).textContent).toContain('could not be loaded: plain.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await gateLoaded()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a gate that settles after the view unmounted', async () => {
    const first = deferred<ModelRoutingGateView>()
    const second = deferred<ModelRoutingGateView>()
    const view = setup({ loadGate: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) })
    view.unmount()
    await act(async () => { first.resolve(GATE) })
    const again = setup({ loadGate: () => second.promise })
    again.unmount()
    await act(async () => { second.reject(new Error('late')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('RoutingView charts', () => {
  it('gives every graph a text alternative and a Table view', async () => {
    setup()
    await gateLoaded()
    const timeline = screen.getByRole('img', { name: /^Model timeline 93 steps by model: claude-opus-5-5 45, glm-5\.3 45, gpt-6-astra 3\. 22 decisions\.$/ })
    expect(timeline).toBeTruthy()
    for (const title of ['Why routing kept the strong model', 'Decision reasons', 'Tokens by model', 'Cold prefills by cause', 'Judge latency']) {
      expect(screen.getByRole('img', { name: new RegExp(`^${title} `) })).toBeTruthy()
    }
    const card = screen.getByRole('region', { name: 'Model timeline' })
    const toggle = within(card).getByRole('button', { name: 'Table' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(within(card).queryByRole('img')).toBeNull()
    expect(within(card).getByRole('columnheader', { name: 'Model' })).toBeTruthy()
    expect(within(card).getAllByRole('cell', { name: '■ claude-opus-5-5' }).length).toBeGreaterThan(0)
    fireEvent.click(toggle)
    expect(within(card).getByRole('img', { name: /^Model timeline / })).toBeTruthy()
  })

  it('writes a focused or hovered mark to the detail line and opens a decision from the keyboard', async () => {
    const loadDecision = vi.fn((seq: number) => Promise.resolve({ ...decisionDetail(), seq }))
    setup({ loadDecision })
    await gateLoaded()
    const card = screen.getByRole('region', { name: 'Why routing kept the strong model' })
    const dot = within(card).getAllByRole('img', { name: /^Consult 1:/ })[0]!
    fireEvent.focus(dot)
    expect(card.querySelector('[aria-live="polite"]')?.textContent).toBe('Consult 1: best candidate 0.02')
    const bar = screen.getByRole('img', { name: 'current-preferred (Judge kept strong): 15' })
    fireEvent.mouseEnter(bar)
    expect(screen.getByRole('region', { name: 'Decision reasons' }).querySelector('[aria-live="polite"]')?.textContent).toBe('current-preferred (Judge kept strong): 15')
    const decision = screen.getAllByRole('button', { name: 'kept-strong, current-preferred, best candidate 0.02' })[0]!
    fireEvent.keyDown(decision, { key: 'a' })
    expect(loadDecision).not.toHaveBeenCalled()
    fireEvent.keyDown(decision, { key: 'Enter' })
    await screen.findByRole('dialog')
    expect(loadDecision).toHaveBeenCalledWith(1000)
  })

  it('renders thresholds only once the gate loads, and empty graphs for a session without data', () => {
    const stats: ModelRoutingStatsSnapshot = { ...emptyStats(), counts: { ...emptyStats().counts, decisions: 1 } }
    setup({ stats, loadGate: () => new Promise(() => {}) })
    for (const key of ['g1.empty', 'g2.empty', 'g3.empty', 'g4.empty', 'g6.empty', 'exits.empty'] as const) {
      expect(screen.getByText(en[key])).toBeTruthy()
    }
    expect(screen.getByText('Idle expiry uses 300 s: this provider does not declare a cache lifetime.')).toBeTruthy()
    expect(screen.getByText('Routing kept the strong model on all 1 decisions.')).toBeTruthy()
  })

  it('draws the active session: every colour slot, markers, routed causes, streak exits, and a failed-only latency', async () => {
    const stats = activeStats()
    setup({ stats: { ...stats, streakLengths: { median: null, max: 3 }, confidence: { ...stats.confidence, margins: [] } } })
    await screen.findByText(/Routing served 38\.0% of steps/)
    expect(screen.getByRole('img', { name: /One entry per turn/ })).toBeTruthy()
    expect(screen.getByText('Idle expiry uses the model cache lifetime of 3600 s.')).toBeTruthy()
    expect(screen.getByText('Streak length: median 0 steps, longest 3.')).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'gate-failed' })).toBeTruthy()
    expect(screen.getByText('failed 20')).toBeTruthy()
    for (const glyph of ['▼', '▲', '✕']) expect(screen.getByText(glyph)).toBeTruthy()
    cleanup()
    const failedOnly: ModelRoutingStatsSnapshot = {
      ...stats,
      // A counts list shorter than the bounds draws the missing buckets as zero.
      latency: { ...stats.latency, counts: [0], failed: 3, p50: null, p95: null, includesFailed: false },
    }
    setup({ stats: failedOnly, loadGate: () => Promise.resolve({ ...GATE, judgmentDeadlineMs: 60_000 }) })
    await screen.findAllByText('deadline')
    expect(screen.getByText('Judge latency, log scale (answered asks)')).toBeTruthy()
  })
})

describe('RoutingView decisions and drill-down', () => {
  it('pages the recent decisions', () => {
    setup({ stats: activeStats() })
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Older' }))
    expect(screen.getByText('Page 2 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Newer' }))
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
  })

  it('opens a decision, shows every section, reveals its state on request, and closes on Escape', async () => {
    setup()
    await gateLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 21.1' }))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Turn 2.1 · low-confidence')
    expect(within(drawer).getByText('First failing check: Confidence ≥ threshold.')).toBeTruthy()
    expect(within(drawer).getByText('2026-09-25 07:38:12 UTC')).toBeTruthy()
    expect(within(drawer).getByText('typesafe · jev-1.13.0')).toBeTruthy()
    expect(within(drawer).getByText('765 ms (deadline 1.5 s)')).toBeTruthy()
    expect(within(drawer).getByText('DEADLINE')).toBeTruthy()
    expect(within(drawer).getByText('Which route should handle this turn?')).toBeTruthy()
    expect(within(drawer).getByText('keep-current (chosen)')).toBeTruthy()
    expect(within(drawer).getByText('ollama-cloud / deepseek-v4.1-flash:cloud · low')).toBeTruthy()
    expect(within(drawer).getByText('context-too-small')).toBeTruthy()
    expect(within(drawer).getByText('18 characters, 612 tokens')).toBeTruthy()
    expect(within(drawer).getByText('conversation-v1 · 2 prior turns')).toBeTruthy()
    expect(within(drawer).getByText('3 included · 1 omitted')).toBeTruthy()
    expect(within(drawer).getByText('gate-failed')).toBeTruthy()
    expect(within(drawer).getByText('enter below 2 · exit at 3')).toBeTruthy()
    // Decisions record no thresholds, so the gate compares with the configuration now.
    expect(within(drawer).getByText('Threshold now · uncalibrated')).toBeTruthy()
    expect(within(drawer).getByText('threshold now 0.80')).toBeTruthy()
    expect(within(drawer).getByText('threshold now 0.10')).toBeTruthy()
    expect(within(drawer).queryByText('USER: fix the typo')).toBeNull()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Show state text' }))
    expect(within(drawer).getByText('USER: fix the typo')).toBeTruthy()
    fireEvent.keyDown(drawer, { key: 'Tab' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(drawer, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders a decision that made no judgment', async () => {
    const bare = decisionDetail({
      outcome: 'downgraded', reason: 'gate-passed', engine: undefined, model: undefined, latencyMs: undefined,
      engineFailure: undefined, judgmentQuestions: undefined, route: undefined, candidateEligibility: undefined,
      judgmentInput: undefined, stateProjection: undefined, difficulty: undefined, objective: undefined,
      sticky: { active: true, stepsElapsed: 2, routeErrorLimit: 3 } as never,
    })
    setup({ loadDecision: () => Promise.resolve(bare) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('No check stopped this decision.')
    expect(within(drawer).queryByText(en['drill.question'])).toBeNull()
    expect(within(drawer).queryByText(en['drill.options'])).toBeNull()
    expect(within(drawer).queryByRole('button', { name: 'Show state text' })).toBeNull()
    expect(within(drawer).getAllByText('—').length).toBeGreaterThan(3)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reads the challenger confidence and an unmeasured state size', async () => {
    const onlyKeep = decisionDetail({
      route: { choice: 'keep-current', confidence: 1, probabilities: { 'keep-current': 1 } },
      judgmentInput: undefined,
    })
    setup({ loadDecision: () => Promise.resolve(onlyKeep) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('at most 12000 characters (the exact size is not recorded)')
    cleanup()
    const chosen = decisionDetail({ route: { choice: 'flash', confidence: 0.91, probabilities: { flash: 0.91, 'keep-current': 0.09 } } })
    setup({ loadDecision: () => Promise.resolve(chosen) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    // The chosen candidate's confidence reads on the gate scale and in the options table.
    expect(await within(await screen.findByRole('dialog')).findAllByText('0.91')).toHaveLength(2)
  })

  it('reports a decision that failed to load and retries it', async () => {
    const loadDecision = vi.fn()
      .mockRejectedValueOnce(new Error('gone'))
      .mockRejectedValueOnce('closed')
      .mockResolvedValue(decisionDetail())
    setup({ loadDecision })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const drawer = await screen.findByRole('dialog')
    expect((await within(drawer).findByRole('alert')).textContent).toContain('The decision could not be loaded: gone.')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }))
    expect((await within(drawer).findByRole('alert')).textContent).toContain('closed')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }))
    await within(drawer).findByText('Turn 2.1 · low-confidence')
  })

  it('drops a decision that settles after the drawer closed', async () => {
    const pending = deferred<ModelRoutingDecisionDetail>()
    const failing = deferred<ModelRoutingDecisionDetail>()
    const loadDecision = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(failing.promise)
    setup({ loadDecision })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    expect(within(screen.getByRole('dialog')).getByText('Loading decision 1021…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => { pending.resolve(decisionDetail()) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => { failing.reject(new Error('late')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('RoutingView handoffs', () => {
  it('reveals a decision, a step, and the drill-down in Trajectory', async () => {
    const reveal = vi.fn()
    setup({ reveal, canReveal: view => view === 'trajectory' })
    await gateLoaded()
    fireEvent.click(screen.getAllByRole('button', { name: 'Trajectory →' })[0]!)
    expect(reveal).toHaveBeenLastCalledWith({ view: 'trajectory', target: { kind: 'event', seq: 1021 } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Turn 1\.1: / })[0]!)
    expect(reveal).toHaveBeenLastCalledWith({ view: 'trajectory', target: { kind: 'event', seq: 100 } })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Show in Trajectory →' }))
    expect(reveal).toHaveBeenLastCalledWith({ view: 'trajectory', target: { kind: 'event', seq: 1021 } })
  })

  it('offers no Trajectory link when Trajectory is not registered', async () => {
    setup({ reveal: vi.fn(), canReveal: () => false })
    await gateLoaded()
    expect(screen.queryByRole('button', { name: 'Trajectory →' })).toBeNull()
    expect(screen.getAllByRole('img', { name: /^Turn 1\.1: / }).length).toBeGreaterThan(0)
  })

  it('opens the drill-down Trajectory asked for and acknowledges it, ignoring call targets', async () => {
    const onInspectDone = vi.fn()
    const loadDecision = vi.fn((seq: number) => Promise.resolve({ ...decisionDetail(), seq }))
    setup({ inspect: { view: 'routing', target: { kind: 'call', callId: 'c1' } }, onInspectDone, loadDecision })
    expect(onInspectDone).not.toHaveBeenCalled()
    cleanup()
    setup({ inspect: { view: 'routing', target: { kind: 'event', seq: 1005 } }, onInspectDone, loadDecision })
    await screen.findByRole('dialog')
    expect(loadDecision).toHaveBeenCalledWith(1005)
    expect(onInspectDone).toHaveBeenCalledTimes(1)
  })

  it('renders two sessions as independent views', async () => {
    render(
      <>
        <div data-testid="one"><RoutingView {...props({ stats: liveStats() })} /></div>
        <div data-testid="two"><RoutingView {...props({ stats: activeStats() })} /></div>
      </>,
    )
    const one = screen.getByTestId('one')
    const two = screen.getByTestId('two')
    await within(one).findByText(/switching requires 0\.80/)
    expect(within(one).getByText('Routing kept the strong model on all 22 decisions.')).toBeTruthy()
    expect(within(two).getByText(/Routing served 38\.0% of steps/)).toBeTruthy()
    fireEvent.click(within(one).getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    expect(await within(one).findByRole('dialog')).toBeTruthy()
    expect(within(two).queryByRole('dialog')).toBeNull()
  })
})
