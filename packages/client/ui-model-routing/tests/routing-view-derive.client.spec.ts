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
  decisionThresholds, egressWarning, engineTroubleRecorded, engineUncalibratedRecorded, gateFor, gatePath, judgeNotUsed, judgeRefused,
  judgeSegment, judgeTrouble,
  latencyScopeNote, recordedThresholdsNote, thresholdSourceLabel, thresholdValueLabel,
  routeMargin, routeOptions, routeQuestion, routingKpis,
  routingVerdict, routingViewState, strongRoute, type RoutingTranslate,
} from '../src/client/view/derive.ts'
import { formatMs, formatPercent, formatScore, formatTokens } from '../src/client/view/format.ts'
import type { RoutingJudge } from '../src/client/engine-source.ts'
import { LOCAL, REMOTE } from './fixtures/engines.client.ts'
import { activeStats, decisionDetail, emptyStats, GATE, liveStats } from './fixtures/routing-stats.client.ts'

const JUDGE: RoutingJudge = { kind: 'engine', engine: LOCAL }

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
    expect(routingViewState(emptyStats(), false, JUDGE)).toBe('never-used')
  })

  it('is normal when routing is off with history', () => {
    expect(routingViewState(liveStats(), false, JUDGE)).toBe('normal')
  })

  it('reports a missing engine and an unlisted base from the latest decision', () => {
    const stats = liveStats()
    const withLatest = (reason: string) => ({ ...stats, recent: [{ ...stats.recent[0]!, reason }] })
    expect(routingViewState(withLatest('engine-absent'), true, JUDGE)).toBe('no-engine')
    expect(routingViewState(withLatest('engine-disabled'), true, JUDGE)).toBe('no-engine')
    expect(routingViewState(withLatest('base-unlisted'), true, JUDGE)).toBe('base-unlisted')
    expect(routingViewState(stats, true, JUDGE)).toBe('normal')
    expect(routingViewState(emptyStats(), true, JUDGE)).toBe('normal')
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
    const one = { ...activeStats(), counts: { ...activeStats().counts, streaks: 1 } }
    expect(routingVerdict(one, GATE, true, t)?.headline)
      .toBe('Routing served 38.0% of steps on deepseek-v4.1-flash, kimi-k3 in one streak.')
    expect(routingKpis(one, GATE, undefined, t).find(tile => tile.id === 'pool-steps')?.detail).toBe('38 of 100 steps · 1 streak')
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
      ['latency', '1000', 'P95 1 s · judge call only · deadline 1.5 s'],
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
    expect(routingKpis(liveStats(), GATE, () => undefined, t).at(-1)).toMatchObject({
      value: '—', detail: '22 asks to an engine this host does not list, so where they went is unknown',
    })
    expect(routingKpis(liveStats(), GATE, () => 'local', t).at(-1)).toMatchObject({ value: '0', detail: 'local engine only' })
  })

  it('counts remote characters it can attribute beside asks to an unlisted engine', () => {
    const stats = {
      ...liveStats(),
      egress: [
        { engine: 'typesafe', asks: 22, chars: 264_000, bound: 'exact' as const },
        { engine: 'retired', asks: 3, chars: 9_000, bound: 'at-most' as const },
      ],
    }
    const egressOf = (engine: string) => (engine === 'typesafe' ? 'remote' as const : undefined)
    expect(routingKpis(stats, GATE, egressOf, t).at(-1)).toMatchObject({
      value: '264k',
      detail: '22 asks to a remote engine · 3 asks to an engine this host does not list, so where they went is unknown',
    })
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
    expect(gatePath('gate-passed', true).every(check => check.status === 'pass' && !check.first)).toBe(true)
  })

  it('marks the first failing check and skips the rest', () => {
    const path = gatePath('low-confidence', true)
    expect(path.map(check => check.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail', 'skip', 'skip'])
    expect(path.filter(check => check.first).map(check => check.id)).toEqual(['confidence'])
    expect(gatePath('base-unlisted', false)[1]).toEqual({ id: 'base-listed', status: 'fail', first: true })
  })

  it('stops at the router\'s own order: the pool first, the engine before eligibility', () => {
    const statusOf = (reason: string, assessed = false) =>
      Object.fromEntries(gatePath(reason, assessed).map(check => [check.id, check.status]))
    expect(statusOf('no-candidates')).toMatchObject({ pool: 'fail', 'base-listed': 'skip' })
    expect(statusOf('state-too-large')).toMatchObject({ pool: 'fail', 'base-listed': 'skip' })
    for (const reason of ['engine-absent', 'engine-disabled', 'breaker-open', 'engine-uncalibrated']) {
      expect(statusOf(reason)).toMatchObject({ cooldown: 'pass', engine: 'fail', eligibility: 'skip', judge: 'skip' })
    }
    expect(statusOf('candidate-ineligible')).toMatchObject({ engine: 'pass', eligibility: 'fail' })
    // Refused after the assessment: re-checked before asking, or the answering engine refused.
    for (const reason of ['engine-absent', 'engine-disabled', 'breaker-open', 'engine-uncalibrated']) {
      expect(statusOf(reason, true)).toMatchObject({ engine: 'pass', eligibility: 'pass', judge: 'fail', difficulty: 'skip' })
    }
    expect(statusOf('candidate-ineligible', true)).toMatchObject({ eligibility: 'fail' })
    expect(statusOf('engine-unavailable')).toMatchObject({ eligibility: 'pass', judge: 'fail' })
  })

  it('marks a held streak without a failing check', () => {
    expect(gatePath('sticky-hold', true).at(-1)).toEqual({ id: 'hold', status: 'held', first: false })
    const failedJudge = gatePath('judgment-failure-held', true)
    expect(failedJudge.find(check => check.id === 'judge')).toEqual({ id: 'judge', status: 'held', first: false })
    expect(failedJudge.find(check => check.id === 'hold')).toEqual({ id: 'hold', status: 'held', first: false })
    expect(failedJudge.find(check => check.id === 'confidence')?.status).toBe('skip')
  })

  it('skips every check for a reason it does not know', () => {
    expect(gatePath('a-future-reason', false).every(check => check.status === 'skip')).toBe(true)
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

describe('decision thresholds', () => {
  it('compares a decision that recorded none with the configuration now, uncalibrated', () => {
    const thresholds = decisionThresholds(decisionDetail())
    expect(thresholds).toEqual({
      source: 'now', origin: 'global', difficultySource: 'now',
      downgradeThreshold: 0.8, downgradeMargin: 0.1, entryScoreCeiling: 2, escalateBackScoreThreshold: 3,
    })
    expect(thresholdSourceLabel(thresholds, t)).toBe('Threshold now · uncalibrated')
    expect(thresholdValueLabel(thresholds, 0.8, t)).toBe('threshold now 0.80')
  })

  it('prefers the thresholds a decision recorded, and the difficulty scores only when it asked the difficulty question', () => {
    const global = decisionThresholds(decisionDetail({ thresholds: { downgradeThreshold: 0.7, downgradeMargin: 0.05, source: 'global' } }))
    expect(global).toEqual({
      source: 'recorded', origin: 'global', difficultySource: 'now',
      downgradeThreshold: 0.7, downgradeMargin: 0.05, entryScoreCeiling: 2, escalateBackScoreThreshold: 3,
    })
    const withDifficulty = decisionThresholds(decisionDetail({
      thresholds: { downgradeThreshold: 0.7, downgradeMargin: 0.05, entryScoreCeiling: 1, escalateBackScoreThreshold: 2.5, source: 'global' },
    }))
    expect(withDifficulty).toMatchObject({ difficultySource: 'recorded', entryScoreCeiling: 1, escalateBackScoreThreshold: 2.5 })
    const onlyEntry = decisionThresholds(decisionDetail({
      thresholds: { downgradeThreshold: 0.7, downgradeMargin: 0.05, entryScoreCeiling: 1, source: 'global' },
    }))
    expect(onlyEntry).toMatchObject({ difficultySource: 'now', entryScoreCeiling: 2, escalateBackScoreThreshold: 3 })
    expect(thresholdSourceLabel(global, t)).toBe('Threshold at the time · global defaults · uncalibrated')
    expect(thresholdValueLabel(global, 0.7, t)).toBe('threshold at the time 0.70')
    const point = decisionThresholds(decisionDetail({
      thresholds: { downgradeThreshold: 0.6, downgradeMargin: 0.1, source: 'operating-point', calibratedBy: 'prereg-7' },
    }))
    expect(point).toMatchObject({ origin: 'operating-point', calibratedBy: 'prereg-7' })
    expect(thresholdSourceLabel(point, t)).toBe('Threshold at the time · the engine\'s operating point · calibrated by prereg-7')
  })
})

describe('operating points', () => {
  const POINTS = {
    ...GATE,
    operatingPoints: [
      { engine: 'laya', downgradeThreshold: 0.6, downgradeMargin: 0.2, calibratedBy: 'prereg-1', acceptVerbalized: false },
      { engine: 'typesafe', downgradeThreshold: 0.7, downgradeMargin: 0.15, acceptVerbalized: true },
    ],
  }

  it('gates an engine by its operating point, else by the global floors', () => {
    expect(gateFor(POINTS, 'laya')).toMatchObject({ downgradeThreshold: 0.6, downgradeMargin: 0.2, origin: 'operating-point', calibratedBy: 'prereg-1' })
    expect(gateFor(POINTS, 'typesafe')).toMatchObject({ downgradeThreshold: 0.7, origin: 'operating-point' })
    expect(gateFor(POINTS, 'typesafe').calibratedBy).toBeUndefined()
    expect(gateFor(POINTS, 'other')).toMatchObject({ downgradeThreshold: 0.8, origin: 'global' })
    expect(gateFor(POINTS, undefined).origin).toBe('global')
  })

  it('falls back to the operating point now of the engine a decision names', () => {
    const calibrated = decisionThresholds({ ...decisionDetail({ engineId: 'laya' }), gate: POINTS })
    expect(calibrated).toMatchObject({ source: 'now', origin: 'operating-point', calibratedBy: 'prereg-1', downgradeThreshold: 0.6 })
    expect(thresholdSourceLabel(calibrated, t)).toBe('Threshold now · the engine\'s operating point · calibrated by prereg-1')
    const uncalibrated = decisionThresholds({ ...decisionDetail({ engineId: 'typesafe' }), gate: POINTS })
    expect(thresholdSourceLabel(uncalibrated, t)).toBe('Threshold now · the engine\'s operating point · uncalibrated')
  })
})

describe('recorded facts in the statistics', () => {
  it('names warm-ups and judge tokens in the tiles', () => {
    const stats = {
      ...liveStats(),
      counts: { ...liveStats().counts, warmUps: 3 },
      judge: { calls: 22, promptTokens: 40_000, outputTokens: 2_000 },
      latency: { ...liveStats().latency, withEligibility: 22 },
    }
    const tiles = routingKpis(stats, GATE, () => 'remote', t)
    expect(tiles.find(tile => tile.id === 'decisions')?.detail).toBe('22 judged · 0 failed · 3 judge warming up')
    expect(tiles.find(tile => tile.id === 'latency')?.detail).toBe('P95 1 s · deadline 1.5 s · 42k judge tokens')
  })

  it('notes consults recorded at other floors than the threshold line draws', () => {
    expect(recordedThresholdsNote(liveStats(), GATE, t)).toBeUndefined()
    const at = (downgradeThreshold: number, downgradeMargin: number, consults: number) =>
      ({ downgradeThreshold, downgradeMargin, source: 'global' as const, calibratedBy: null, consults })
    const same = { ...liveStats(), thresholds: [at(0.8, 0.1, 5)] }
    expect(recordedThresholdsNote(same, GATE, t)).toBeUndefined()
    const other = { ...liveStats(), thresholds: [at(0.8, 0.1, 5), at(0.7, 0.1, 3), at(0.8, 0.2, 1)] }
    expect(recordedThresholdsNote(other, null, t)).toBeUndefined()
    expect(recordedThresholdsNote(other, GATE, t)).toBe(
      'The line is the threshold now. 4 consults recorded other thresholds at the time: confidence ≥ 0.70, margin ≥ 0.10; confidence ≥ 0.80, margin ≥ 0.20.',
    )
  })

  it('says what a latency covers', () => {
    expect(latencyScopeNote(emptyStats(), t)).toBeUndefined()
    expect(latencyScopeNote(liveStats(), t)).toBe('The judgment call only: this log does not record the eligibility assessment before it.')
    const all = { ...liveStats(), latency: { ...liveStats().latency, withEligibility: 22 } }
    expect(latencyScopeNote(all, t)).toBeUndefined()
    const some = { ...liveStats(), latency: { ...liveStats().latency, withEligibility: 5 } }
    expect(latencyScopeNote(some, t)).toBe('Includes the eligibility assessment on 5 of 22 asks; the rest are the judgment call only.')
  })

  it('reports an engine refused as uncalibrated only while routing is on', () => {
    const recent = liveStats().recent
    const refused = { ...liveStats(), recent: [{ ...recent[0]!, reason: 'engine-uncalibrated' }, ...recent.slice(1)] }
    expect(engineUncalibratedRecorded(refused, true)).toBe(true)
    expect(engineUncalibratedRecorded(refused, false)).toBe(false)
    expect(engineUncalibratedRecorded(liveStats(), true)).toBe(false)
  })
})

describe('judge facts', () => {
  it('reads no-engine from a missing judge while routing is on', () => {
    expect(routingViewState(liveStats(), true, { kind: 'none', reason: 'disabled' })).toBe('no-engine')
    expect(routingViewState(liveStats(), false, { kind: 'none', reason: 'disabled' })).toBe('normal')
  })

  it('describes every engine state with a tone', () => {
    const states = ['ready', 'starting', 'unavailable', 'unconfigured', 'not-installed', 'unsupported-host'] as const
    expect(states.map((state) => {
      const segment = judgeSegment({ kind: 'engine', engine: { ...LOCAL, state } }, t)
      return [segment.state, segment.tone]
    })).toEqual([
      ['Ready', 'done'], ['Starting', 'ongoing'], ['Unavailable', 'error'],
      ['Not configured', 'warning'], ['Not installed', 'warning'], ['Not supported on this machine', 'error'],
    ])
    expect(judgeSegment({ kind: 'engine', engine: REMOTE }, t)).toEqual({
      name: 'Jev (TypeSafe)', state: 'Ready', tone: 'done', egress: 'remote', uncalibrated: false,
    })
    expect(judgeSegment({ kind: 'none', reason: 'unregistered' }, t)).toEqual({ name: 'the selected engine is not registered' })
  })

  it('reports trouble only for a selected judge that is not ready', () => {
    expect(judgeTrouble({ kind: 'engine', engine: LOCAL }, t)).toBeUndefined()
    expect(judgeTrouble({ kind: 'none', reason: 'no-dispatcher' }, t)).toBeUndefined()
    expect(judgeTrouble({ kind: 'engine', engine: { ...REMOTE, state: 'unconfigured' } }, t))
      .toBe('The judge, Jev (TypeSafe), is Not configured; steps keep the strong model until it is ready.')
  })

  it('warns about egress only for a remote judge while routing is on', () => {
    const remote: RoutingJudge = { kind: 'engine', engine: REMOTE }
    expect(egressWarning(remote, true, GATE, t)).toBe('Conversation excerpts leave this machine while Auto routing is on: each consult sends up to 12,000 characters of this session to api.typesafe.ai.')
    expect(egressWarning(remote, true, null, t)).toBe('Conversation excerpts leave this machine while Auto routing is on: each consult sends part of this session to api.typesafe.ai.')
    expect(egressWarning(remote, false, GATE, t)).toBeUndefined()
    expect(egressWarning(JUDGE, true, GATE, t)).toBeUndefined()
    expect(egressWarning({ kind: 'loading' }, true, GATE, t)).toBeUndefined()
  })
})

describe('the router\'s refusal of a verbalized judge', () => {
  const verbalized: RoutingJudge = { kind: 'engine', engine: { ...REMOTE, calibration: 'verbalized' } }
  const point = (acceptVerbalized: boolean) => ({
    ...GATE, operatingPoints: [{ engine: 'typesafe', downgradeThreshold: 0.7, downgradeMargin: 0.1, acceptVerbalized }],
  })

  it('refuses a verbalized engine unless its operating point accepts it, as the router does', () => {
    expect(judgeRefused({ kind: 'loading' }, GATE)).toBe(false)
    expect(judgeRefused({ kind: 'engine', engine: REMOTE }, null)).toBe(false)
    expect(judgeRefused(verbalized, null)).toBeUndefined()
    expect(judgeRefused(verbalized, GATE)).toBe(true)
    expect(judgeRefused(verbalized, point(false))).toBe(true)
    expect(judgeRefused(verbalized, point(true))).toBe(false)
  })

  it('names a refused judge and withholds the egress warning until the router would ask it', () => {
    expect(judgeNotUsed(verbalized, GATE, t)).toContain('is not used for routing')
    expect(judgeNotUsed(verbalized, null, t)).toBeUndefined()
    expect(judgeNotUsed({ kind: 'none', reason: 'disabled' }, GATE, t)).toBeUndefined()
    expect(egressWarning(verbalized, true, GATE, t)).toBeUndefined()
    expect(egressWarning(verbalized, true, null, t)).toBeUndefined()
    expect(egressWarning(verbalized, true, point(true), t)).toContain('each consult sends up to 12,000 characters')
  })
})
