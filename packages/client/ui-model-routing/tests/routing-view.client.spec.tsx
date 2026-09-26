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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type {
  ModelRoutingDecisionDetail, ModelRoutingGateView, ModelRoutingProjection, ModelRoutingStatsSnapshot,
} from '@shres-code/shres-code-model-router/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import { RoutingView, type RoutingViewProps } from '../src/client/view/RoutingView.tsx'
import type { RoutingEngineState } from '../src/client/engine-source.ts'
import { engines, LOCAL, REMOTE } from './fixtures/engines.client.ts'
import { activeStats, decisionDetail, emptyStats, GATE, liveStats, OFF, ON } from './fixtures/routing-stats.client.ts'

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
  routerStatus?: 'loading' | 'ready' | 'unavailable'
  openRoutingSettings?: () => Promise<void>
  engine?: RoutingEngineState
  openState?: 'cold' | 'loading' | 'open' | 'error'
}

function props(options: Setup): RoutingViewProps {
  const store = createSnapshotStore<{ values: Record<string, unknown> }>({
    values: { modelRoutingStats: 'stats' in options ? options.stats : liveStats(), modelRouting: 'routing' in options ? options.routing : ON },
  })
  const useProjection = (key: string, selector?: (value: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (value => value))(s.values[key]))
  const scope = { status: options.routerStatus ?? 'ready' }
  const session = { openState: options.openState ?? 'open' }
  // One engine value per render tree, as the plugin's engine source delivers it.
  const engine = options.engine ?? { kind: 'ready', snapshot: engines('laya') }
  return {
    useProjection,
    useRouterSettings: (selector: (value: typeof scope) => unknown) => selector(scope),
    useSession: (selector: (value: typeof session) => unknown) => selector(session),
    useRoutingEngine: (selector: (value: RoutingEngineState) => unknown) => selector(engine),
    available: options.available ?? true,
    loadGate: options.loadGate ?? (() => Promise.resolve(GATE)),
    ...options.openRoutingSettings === undefined ? {} : { openRoutingSettings: options.openRoutingSettings },
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

describe('RoutingView in shadow', () => {
  it('reads Shadow in the status line, states the would-have verdict, and prefixes the pool tile', () => {
    const stats = {
      ...liveStats(),
      shadow: { decisions: 22, downgraded: 9, streaks: 2 },
    }
    setup({ stats, routing: { mode: 'shadow', active: true, pending: false } })
    expect(screen.getByText(en['status.shadow'])).toBeTruthy()
    expect(screen.getByText(en['status.shadow.detail'])).toBeTruthy()
    expect(screen.getByText('In shadow, routing would have served 40.9% of judged steps on pool models across 2 streaks.')).toBeTruthy()
    expect(screen.getByText('Would have Steps on pool models')).toBeTruthy()
    // The measured tiles keep their measured names.
    expect(screen.getByText('Strong tokens moved off')).toBeTruthy()
  })

  it('holds a skeleton while the host has not answered whether it composes the router', () => {
    setup({ routerStatus: 'loading' })
    expect(screen.getByText(en['view.loading'])).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText(en['view.unavailable'])).toBeNull()
  })

  it('holds a skeleton until the session\'s projections arrive with its tail page', () => {
    for (const openState of ['cold', 'loading'] as const) {
      setup({ routing: undefined, openState })
      expect(screen.getByText(en['view.loading'])).toBeTruthy()
      cleanup()
    }
  })

  it('says routing is unavailable once the session settled without the projection, or for a subagent session', () => {
    setup({ routing: undefined, openState: 'open' })
    expect(screen.getByText(en['view.unavailable'])).toBeTruthy()
    cleanup()
    setup({ stats: undefined, openState: 'error' })
    expect(screen.getByText(en['view.unavailable'])).toBeTruthy()
    cleanup()
    setup({ available: false })
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
    expect(tile.textContent).toBe('Judge latency1000 ms P50P95 1 s · deadline 1.5 s · 1 s per turn')
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

  it('reads gate() again when the engine facts change, keeping the loaded gate meanwhile', async () => {
    const later = deferred<ModelRoutingGateView>()
    const loadGate = vi.fn().mockResolvedValueOnce(GATE).mockReturnValueOnce(later.promise)
    const first = props({ loadGate })
    const view = render(<RoutingView {...first} />)
    await gateLoaded()
    const snapshot = engines('typesafe')
    view.rerender(<RoutingView {...first} useRoutingEngine={selector => selector({ kind: 'ready', snapshot })} />)
    expect(loadGate).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/switching requires 0\.80/)).toBeTruthy()
    const refused = { ...GATE, engines: [{ engine: 'typesafe', calibration: { kind: 'refused' as const } }] }
    await act(async () => { later.resolve(refused) })
    expect(statusLine().textContent).toContain('Not used for routing')
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
    expect(screen.getByText('Idle expiry uses an assumed 5-minute cache lifetime: the log does not record the lifetime in force.')).toBeTruthy()
    expect(screen.getByText('Routing kept the strong model on all 1 decisions.')).toBeTruthy()
  })

  it('draws the active session: every colour slot, markers, routed causes, streak exits, and a failed-only latency', async () => {
    const stats = activeStats()
    setup({ stats: { ...stats, streakLengths: { median: null, max: 3 }, confidence: { ...stats.confidence, margins: [] } } })
    await screen.findByText(/Routing served 38\.0% of steps/)
    expect(screen.getByRole('img', { name: /Each entry covers one or more whole turns/ })).toBeTruthy()
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(expect.arrayContaining(['1–3', '4.1', '5–6']))
    // The decision that recorded the lifetime names the model, so G5 labels it with its source.
    expect(screen.getByText('claude-session/claude-opus-5-5: idle past 3600 s (adapter)')).toBeTruthy()
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

  it('shows the facts a decision recorded about its judgment call', async () => {
    const recorded = decisionDetail({
      engineId: 'typesafe',
      eligibilityMs: 70,
      judgeUsage: { inputTokens: 1_200, outputTokens: 30, cacheReadTokens: 300 },
      inputChars: 9_000,
      thresholds: { downgradeThreshold: 0.7, downgradeMargin: 0.05, source: 'operating-point', calibratedBy: 'prereg-7' },
    })
    setup({ loadDecision: () => Promise.resolve(recorded) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('typesafe')
    expect(within(drawer).getByText('70 ms')).toBeTruthy()
    expect(within(drawer).getByText('1.5k in · 30 out')).toBeTruthy()
    expect(within(drawer).getByText('9000 characters across the alternatives')).toBeTruthy()
    expect(within(drawer).getByText('Threshold at the time · the engine\'s operating point · calibrated by prereg-7')).toBeTruthy()
    expect(within(drawer).getByText('threshold at the time 0.70')).toBeTruthy()
    expect(within(drawer).getByText(en['drill.difficulty.now'])).toBeTruthy()
    cleanup()
    const withDifficulty = decisionDetail({
      thresholds: { downgradeThreshold: 0.7, downgradeMargin: 0.05, entryScoreCeiling: 1, escalateBackScoreThreshold: 2.5, source: 'global' },
    })
    setup({ loadDecision: () => Promise.resolve(withDifficulty) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const recordedDrawer = await screen.findByRole('dialog')
    await within(recordedDrawer).findByText('enter below 1 · exit at 2.5')
    expect(within(recordedDrawer).queryByText(en['drill.difficulty.now'])).toBeNull()
  })

  it('reads a warm-up and a state size recorded without its text', async () => {
    const warmUp = decisionDetail({
      outcome: 'kept-strong', reason: 'engine-unavailable', route: undefined, judgmentInput: undefined,
      engineFailure: { code: 'UNAVAILABLE', engineState: 'not-installed' }, inputChars: 4_000,
    })
    setup({ loadDecision: () => Promise.resolve(warmUp) })
    fireEvent.click(screen.getByRole('button', { name: 'Open the reasoning of turn 22.1' }))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('UNAVAILABLE · judge warming up (not installed), not called and not counted as a failure')
    expect(within(drawer).getByText('4000 characters')).toBeTruthy()
    expect(within(drawer).queryByText(en['drill.state.offered'])).toBeNull()
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

/** The read-only status line: the paragraph that states the mode and the judge. */
function statusLine(): HTMLElement {
  const line = [...document.querySelectorAll('p')].find(node => (node.textContent ?? '').includes('Judge (all sessions):'))
  if (line === undefined) throw new Error('no status line')
  return line
}

describe('RoutingView judge facts', () => {
  it('names the judge, its state, its egress, and the router\'s calibration for it in the status line', async () => {
    const judged = { ...GATE, engines: [{ engine: 'laya', calibration: { kind: 'global' as const } }, { engine: 'typesafe', calibration: { kind: 'calibrated' as const, by: 'prereg-1' } }] }
    setup({ loadGate: () => Promise.resolve(judged) })
    await gateLoaded()
    const status = statusLine()
    expect(status.textContent).toContain('Laya (local, MLX)')
    expect(status.textContent).toContain('Ready')
    expect(status.textContent).toContain('Local')
    expect(status.textContent).toContain('Uncalibrated')
    expect(status.textContent).toContain('change it in Settings › Model routing')
    cleanup()
    setup({ engine: { kind: 'ready', snapshot: engines('typesafe') }, loadGate: () => Promise.resolve(judged) })
    await gateLoaded()
    const remote = statusLine()
    expect(remote.textContent).toContain('Jev (TypeSafe)')
    expect(remote.textContent).toContain('Remote · egress')
    expect(remote.textContent).not.toContain('Uncalibrated')
  })

  it('reports a judge the router refuses: never asked, no egress warning', async () => {
    const verbalizedRemote = { ...REMOTE, calibration: 'verbalized' as const }
    const snapshot = engines('typesafe', { engines: [LOCAL, verbalizedRemote] })
    const openRoutingSettings = vi.fn(() => Promise.resolve())
    const refused = { ...GATE, engines: [{ engine: 'typesafe', calibration: { kind: 'refused' as const } }] }
    setup({ engine: { kind: 'ready', snapshot }, openRoutingSettings, loadGate: () => Promise.resolve(refused) })
    await screen.findByText('The judge, Jev (TypeSafe), is not used for routing: it only verbalizes its confidence and no operating point accepts it, so it is never asked and every step keeps the strong model.')
    expect(statusLine().textContent).toContain('Not used for routing')
    expect(screen.queryByText(/leave this machine/)).toBeNull()
    expect(screen.queryByText(en['state.engineUncalibrated'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings › Model routing' }))
    expect(openRoutingSettings).toHaveBeenCalledTimes(1)
    cleanup()
    const accepted = {
      ...GATE,
      operatingPoints: [{ engine: 'typesafe', downgradeThreshold: 0.7, downgradeMargin: 0.1, acceptVerbalized: true }],
      engines: [{ engine: 'typesafe', calibration: { kind: 'point' as const } }],
    }
    setup({ engine: { kind: 'ready', snapshot }, loadGate: () => Promise.resolve(accepted) })
    await screen.findByText(/each consult sends up to 12,000 characters of this session to api\.typesafe\.ai/)
    expect(statusLine().textContent).not.toContain('Not used for routing')
  })

  it('shows a rejected Settings open as an alert, and clears it on the next attempt', async () => {
    const openRoutingSettings = vi.fn()
      .mockRejectedValueOnce(new Error('no settings.section "model-routing" is registered'))
      .mockRejectedValueOnce('plain')
      .mockResolvedValue(undefined)
    setup({ openRoutingSettings })
    fireEvent.click(screen.getByRole('button', { name: 'Settings › Model routing' }))
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Settings › Model routing could not open: no settings.section "model-routing" is registered')
    fireEvent.click(screen.getByRole('button', { name: 'Settings › Model routing' }))
    expect((await screen.findByText(/could not open: plain/)).getAttribute('role')).toBe('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Settings › Model routing' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('names Settings › Model routing as text while that page does not exist or is not known to', () => {
    // The page registers only while the engine registry is served.
    for (const engine of [{ kind: 'no-dispatcher' }, { kind: 'loading' }, { kind: 'failed', message: 'down' }] as RoutingEngineState[]) {
      setup({ engine, openRoutingSettings: vi.fn(() => Promise.resolve()) })
      expect(statusLine().textContent).toContain('change it in Settings › Model routing')
      expect(screen.queryByRole('button', { name: 'Settings › Model routing' })).toBeNull()
      cleanup()
    }
  })

  it('names Settings › Model routing as text when the view cannot open it', () => {
    setup({ engine: { kind: 'no-dispatcher' } })
    expect(statusLine().textContent).toContain('change it in Settings › Model routing')
    expect(screen.queryByRole('button', { name: 'Settings › Model routing' })).toBeNull()
    expect(screen.getByText('Open Settings › Model routing')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Settings › Model routing' })).toBeNull()
  })

  it('opens Settings › Model routing from the status line and the judge notices', () => {
    const openRoutingSettings = vi.fn(() => Promise.resolve())
    setup({ openRoutingSettings })
    fireEvent.click(screen.getByRole('button', { name: 'Settings › Model routing' }))
    expect(openRoutingSettings).toHaveBeenCalledTimes(1)
    cleanup()
    // Judgment switched off: no judge, but the page exists.
    const disabled = engines('laya', { selection: { enabled: false, engine: 'laya', overrides: {} } })
    setup({ openRoutingSettings, engine: { kind: 'ready', snapshot: disabled } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings › Model routing' }))
    cleanup()
    const starting = engines('laya', { engines: [{ ...LOCAL, state: 'starting' }, REMOTE] })
    setup({ openRoutingSettings, engine: { kind: 'ready', snapshot: starting } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings › Model routing' }))
    expect(openRoutingSettings).toHaveBeenCalledTimes(3)
  })

  it('names why there is no judge, and a judge that is still being read', () => {
    const cases: [RoutingEngineState, string][] = [
      [{ kind: 'loading' }, 'checking…'],
      [{ kind: 'failed', message: 'socket closed' }, 'not known (socket closed)'],
      [{ kind: 'no-dispatcher' }, 'none composed on this host'],
    ]
    for (const [engine, text] of cases) {
      setup({ engine })
      expect(statusLine().textContent).toContain(text)
      cleanup()
    }
  })

  it('warns that excerpts leave the machine while routing is on with a remote judge', async () => {
    setup({ engine: { kind: 'ready', snapshot: engines('typesafe') } })
    expect(screen.getByText(/each consult sends part of this session to api\.typesafe\.ai/)).toBeTruthy()
    await screen.findByText(/each consult sends up to 12,000 characters of this session to api\.typesafe\.ai/)
    cleanup()
    const { destination: _dropped, ...noDestination } = REMOTE
    const unnamed = engines('typesafe', { engines: [LOCAL, noDestination] })
    setup({ engine: { kind: 'ready', snapshot: unnamed }, loadGate: () => new Promise(() => {}) })
    expect(screen.getByText(/each consult sends part of this session to Jev \(TypeSafe\)/)).toBeTruthy()
    cleanup()
    setup({ engine: { kind: 'ready', snapshot: engines('typesafe') }, routing: OFF })
    expect(screen.queryByText(/leave this machine/)).toBeNull()
    cleanup()
    setup()
    expect(screen.queryByText(/leave this machine/)).toBeNull()
  })

  it('reports a selected judge that cannot answer now', () => {
    const starting = engines('laya', { engines: [{ ...LOCAL, state: 'starting' }, REMOTE] })
    setup({ engine: { kind: 'ready', snapshot: starting } })
    expect(screen.getByText('The judge, Laya (local, MLX), is Starting; steps keep the strong model until it is ready.')).toBeTruthy()
    cleanup()
    const missing = engines('laya', { engines: [{ ...LOCAL, state: 'not-installed', detail: 'run /laya install' }, REMOTE] })
    setup({ engine: { kind: 'ready', snapshot: missing } })
    expect(screen.getByText('The judge, Laya (local, MLX), is Not installed (run /laya install); steps keep the strong model until it is ready.')).toBeTruthy()
  })

  it('draws the threshold line at the current judge\'s operating point, naming its calibration', async () => {
    const points = { ...GATE, operatingPoints: [{ engine: 'laya', downgradeThreshold: 0.6, downgradeMargin: 0.2, calibratedBy: 'prereg-1', acceptVerbalized: false }] }
    setup({ loadGate: () => Promise.resolve(points) })
    expect((await screen.findAllByText('threshold now 0.60 (calibrated by prereg-1)')).length).toBeGreaterThan(0)
  })

  it('reports an engine refused as uncalibrated, and notes on the confidence and latency graphs', async () => {
    const recent = activeStats().recent
    const stats = {
      ...activeStats(),
      recent: [{ ...recent[0]!, reason: 'engine-uncalibrated' }, ...recent.slice(1)],
      thresholds: [{ downgradeThreshold: 0.7, downgradeMargin: 0.1, source: 'operating-point' as const, calibratedBy: null, consults: 4 }],
    }
    // A judge the router asks, so the recorded refusal is what the notice reports.
    setup({ stats, routing: ON, engine: { kind: 'ready', snapshot: engines('typesafe') } })
    // The note compares with the gate, so it appears once the gate has loaded.
    await screen.findByText('The line is the threshold now. 4 consults recorded other thresholds at the time: confidence ≥ 0.70, margin ≥ 0.10.')
    expect(screen.getByText(en['state.engineUncalibrated'])).toBeTruthy()
    expect(screen.getByText(/Decisions added 40 ms per turn before their steps could start/)).toBeTruthy()
  })

  it('shows the no-engine state when routing is on and no judge is composed', async () => {
    setup({ engine: { kind: 'no-dispatcher' } })
    expect(screen.getByText(en['state.noEngine'])).toBeTruthy()
    // Without a judge the global floors are the gate now.
    await gateLoaded()
  })

  it('counts off-machine characters only for remote judges', async () => {
    const byRemote = { ...liveStats(), egress: [{ engine: 'typesafe', asks: 22, chars: 264_000, bound: 'at-most' as const }] }
    setup({ stats: byRemote })
    await gateLoaded()
    expect(document.querySelector('[data-kpi="egress"]')!.textContent).toContain('≤ 264k')
    cleanup()
    const byLocal = { ...liveStats(), egress: [{ engine: 'laya', asks: 22, chars: 264_000, bound: 'exact' as const }] }
    setup({ stats: byLocal })
    expect(document.querySelector('[data-kpi="egress"]')!.textContent).toContain('local engine only')
  })
})
