/**
 * Routing view derivations: number formats, the view state, the verdict, the
 * eight KPI tiles (including the egress tile before and after the engine
 * registry reports egress), the ordered gate path with its first failing
 * check, and the drill-down's route question, options, and margin.
 */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import {
  engineTroubleRecorded, gatePath, routeMargin, routeOptions, routeQuestion, routingKpis,
  routingVerdict, routingViewState, strongRoute, type RoutingTranslate,
} from '../src/client/view/derive.ts'
import { formatMs, formatPercent, formatScore, formatTokens } from '../src/client/view/format.ts'
import { activeStats, decisionDetail, emptyStats, GATE, liveStats } from './fixtures/routing-stats.ts'

const t = makeTranslate(en, commonEn) as RoutingTranslate

describe('formats', () => {
  it('formats tokens with three significant digits', () => {
    expect([999, 5_400, 30_600, 91_800, 235_000, 3_530_000, 10_700_000].map(formatTokens))
      .toEqual(['999', '5.4k', '30.6k', '91.8k', '235k', '3.53M', '10.7M'])
  })

  it('formats shares, scores, and latencies', () => {
    expect(formatPercent(0.38)).toBe('38.0%')
    expect(formatScore(0.391)).toBe('0.39')
    expect(formatMs(709)).toBe('709 ms')
    expect(formatMs(1_500)).toBe('1.5 s')
  })
})

describe('routingViewState', () => {
  it('is never-used when routing is off and nothing was decided', () => {
    expect(routingViewState(emptyStats(), false)).toBe('never-used')
  })

  it('is normal when routing is off with history', () => {
    expect(routingViewState(liveStats(), false)).toBe('normal')
  })

  it('reports a missing engine and an unlisted base from the latest decision', () => {
    const stats = liveStats()
    const withLatest = (reason: string) => ({ ...stats, recent: [{ ...stats.recent[0]!, reason }] })
    expect(routingViewState(withLatest('engine-absent'), true)).toBe('no-engine')
    expect(routingViewState(withLatest('engine-disabled'), true)).toBe('no-engine')
    expect(routingViewState(withLatest('base-unlisted'), true)).toBe('base-unlisted')
    expect(routingViewState(stats, true)).toBe('normal')
    expect(routingViewState(emptyStats(), true)).toBe('normal')
  })

  it('reports recorded engine trouble and the strong route', () => {
    expect(engineTroubleRecorded(activeStats())).toBe(true)
    expect(engineTroubleRecorded(liveStats())).toBe(false)
    expect(strongRoute(liveStats())).toBe('claude-session/claude-opus-5-5')
    expect(strongRoute(emptyStats())).toBeUndefined()
  })
})

describe('routingVerdict', () => {
  it('states nothing without decisions', () => {
    expect(routingVerdict(emptyStats(), GATE, true, t)).toBeUndefined()
  })

  it('explains an all-kept session against the threshold, with the Off suffix', () => {
    expect(routingVerdict(liveStats(), GATE, false, t)).toEqual({
      headline: 'Routing kept the strong model on all 22 decisions.',
      detail: 'The best candidate reached 0.39 confidence; switching requires 0.80. Most kept-strong decisions were "current-preferred" (15). Routing is Off for this session now; these are the decisions it made while it was On.',
    })
  })

  it('omits the threshold while the gate loads and evidence that does not exist', () => {
    expect(routingVerdict(liveStats(), null, true, t)?.detail).toBe('The best candidate reached 0.39 confidence. Most kept-strong decisions were "current-preferred" (15).')
    const bare = { ...liveStats(), keptReasons: [], confidence: { ...liveStats().confidence, max: null } }
    expect(routingVerdict(bare, GATE, true, t)?.detail).toBe('')
  })

  it('states the served share for an active session', () => {
    expect(routingVerdict(activeStats(), GATE, true, t)?.headline)
      .toBe('Routing served 38.0% of steps on deepseek-v4.1-flash, kimi-k3 across 6 streaks.')
  })
})

describe('routingKpis', () => {
  it('computes the eight tiles for the live-shaped session', () => {
    const tiles = routingKpis(liveStats(), GATE, () => 'remote', t)
    expect(tiles.map(tile => [tile.id, tile.value, tile.detail])).toEqual([
      ['decisions', '22', '22 judged · 0 failed'],
      ['pool-steps', '0.0%', '0 of 93 steps · 0 streaks'],
      ['kept-strong', '22', 'top: current-preferred (15)'],
      ['route-failed', '0', 'recovered in-turn on the strong model'],
      ['latency', '1000', 'P95 1 s · deadline 1.5 s'],
      ['moved', '0', '0 moved − 0 return re-prefill · quota'],
      ['switch-cost', '235k', 'cold prefills after model changes (routed + manual)'],
      ['egress', '≤ 264k', '22 asks to a remote engine · at most'],
    ])
    expect(tiles.find(tile => tile.id === 'egress')?.unit).toBe('chars')
  })

  it('reports routed switch cost, exact remote egress, and a missing objective', () => {
    const stats = { ...activeStats(), moved: { tokensOffStrong: 10, returnReprefill: 20, objective: null } }
    const tiles = routingKpis(stats, null, () => 'remote', t)
    expect(tiles.find(tile => tile.id === 'switch-cost')?.value).toBe('200k')
    expect(tiles.find(tile => tile.id === 'moved')).toMatchObject({ value: '0', detail: '10 moved − 20 return re-prefill · no objective' })
    expect(tiles.find(tile => tile.id === 'egress')).toMatchObject({ value: '120k', detail: '40 asks to a remote engine' })
    expect(tiles.find(tile => tile.id === 'latency')?.detail).toBe('P95 50 ms')
  })

  it('reports unknown egress before the registry reports it, and local-only egress after', () => {
    expect(routingKpis(liveStats(), GATE, undefined, t).at(-1)).toMatchObject({ value: '—', detail: 'judge egress unknown until the engine registry reports it' })
    expect(routingKpis(liveStats(), GATE, () => undefined, t).at(-1)?.value).toBe('—')
    expect(routingKpis(liveStats(), GATE, () => 'local', t).at(-1)).toMatchObject({ value: '0', detail: 'local engine only' })
  })

  it('reports empty tiles for a session with no calls and no consults', () => {
    const tiles = routingKpis(emptyStats(), null, undefined, t)
    expect(tiles.find(tile => tile.id === 'pool-steps')?.value).toBe('0.0%')
    expect(tiles.find(tile => tile.id === 'kept-strong')?.detail).toBe('—')
    expect(tiles.find(tile => tile.id === 'latency')).toMatchObject({ value: '—', detail: 'no answered consults' })
    expect(tiles.find(tile => tile.id === 'latency')?.unit).toBeUndefined()
  })
})

describe('gatePath', () => {
  it('passes every check for gate-passed', () => {
    expect(gatePath('gate-passed').every(check => check.status === 'pass' && !check.first)).toBe(true)
  })

  it('marks the first failing check and skips the rest', () => {
    const path = gatePath('low-confidence')
    expect(path.map(check => check.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail', 'skip', 'skip'])
    expect(path.filter(check => check.first).map(check => check.id)).toEqual(['confidence'])
    expect(gatePath('base-unlisted')[0]).toEqual({ id: 'base-listed', status: 'fail', first: true })
  })

  it('marks a held streak without a failing check', () => {
    expect(gatePath('sticky-hold').at(-1)).toEqual({ id: 'hold', status: 'held', first: false })
    const failedJudge = gatePath('judgment-failure-held')
    expect(failedJudge.find(check => check.id === 'judge')).toEqual({ id: 'judge', status: 'held', first: false })
    expect(failedJudge.find(check => check.id === 'hold')).toEqual({ id: 'hold', status: 'held', first: false })
    expect(failedJudge.find(check => check.id === 'confidence')?.status).toBe('skip')
  })

  it('skips every check for a reason it does not know', () => {
    expect(gatePath('a-future-reason').every(check => check.status === 'skip')).toBe(true)
  })
})

describe('route question, options, and margin', () => {
  it('reads the choice question and ranks the options', () => {
    const { decision } = decisionDetail()
    expect(routeQuestion(decision)).toBe('Which route should handle this turn?')
    expect(routeOptions(decision)).toEqual([
      { option: 'keep-current', description: 'Keep current (GPT-6 Astra · high)', probability: 0.43, chosen: true },
      { option: 'flash', route: 'ollama-cloud / deepseek-v4.1-flash:cloud · low', description: 'small, well-scoped edits in familiar code', probability: 0.39, chosen: false },
      { option: 'mid-kimi', route: 'moonshotai / kimi-k3', description: 'long-context reading and summaries', probability: 0.02, chosen: false },
    ])
    expect(routeMargin(decision)).toBeCloseTo(0.04)
  })

  it('reports nothing for a decision without a judgment', () => {
    const { decision } = decisionDetail({ route: undefined, judgmentQuestions: undefined, candidateEligibility: undefined })
    expect(routeQuestion(decision)).toBeUndefined()
    expect(routeOptions(decision)).toEqual([])
    expect(routeMargin(decision)).toBeUndefined()
  })

  it('reads options without a question or candidates, and one option has no margin', () => {
    const { decision } = decisionDetail({
      judgmentQuestions: [{ kind: 'score', id: 'difficulty' as never, instructions: 'x', levels: ['a', 'b'] }],
      candidateEligibility: undefined,
      route: { choice: 'flash', confidence: 0.9, probabilities: { flash: 0.9 } },
    })
    expect(routeOptions(decision)).toEqual([{ option: 'flash', probability: 0.9, chosen: true }])
    expect(routeMargin(decision)).toBe(0.9)
    expect(routeMargin(decisionDetail({ route: { choice: 'flash', confidence: 0, probabilities: {} } }).decision)).toBe(0)
  })
})
