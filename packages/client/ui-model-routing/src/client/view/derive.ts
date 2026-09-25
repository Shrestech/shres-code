/**
 * Pure derivations over the `modelRoutingStats` snapshot, the `modelRouting`
 * projection, and one logged decision: the view state, the verdict, the KPI
 * tiles, the drill-down's gate path, and its option rows. Components render
 * these values and compute nothing themselves.
 */
import type {
  ModelRoutingDecision, ModelRoutingDecisionDetail, ModelRoutingGateView, ModelRoutingStatsSnapshot,
} from '@shres-code/shres-code-model-router/client'
import type { JudgmentEngineView } from '@shres-code/shres-code-api-remotes/client'
import type { RoutingJudge } from '../engine-source.ts'
import type { RoutingKey } from '../locales.ts'
import { formatMs, formatPercent, formatScore, formatTokens } from './format.ts'

/** Translate over this package's dictionary. */
export type RoutingTranslate = (key: RoutingKey, params?: Record<string, unknown>) => string

/**
 * What the view shows around the statistics: `never-used` (Off and no
 * decisions: the empty-state card), `no-engine` (On, and the latest decision
 * found no engine), `base-unlisted` (On, and the manual model is not a
 * route-from model), or `normal`.
 */
export type RoutingViewState = 'never-used' | 'no-engine' | 'base-unlisted' | 'normal'

/**
 * Classify the view state from the mode, the router's judge, and the latest decision.
 * @param stats - the session's statistics.
 * @param active - whether routing is in force for the session.
 * @param judge - the judge the router's asks go to.
 * @returns the view state.
 */
export function routingViewState(stats: ModelRoutingStatsSnapshot, active: boolean, judge: RoutingJudge): RoutingViewState {
  if (!active && stats.counts.decisions === 0) return 'never-used'
  if (!active) return 'normal'
  if (judge.kind === 'none') return 'no-engine'
  const reason = stats.recent[0]?.reason
  if (reason === 'engine-absent' || reason === 'engine-disabled') return 'no-engine'
  if (reason === 'base-unlisted') return 'base-unlisted'
  return 'normal'
}

/**
 * Whether routing is on and the latest decision refused the selected engine
 * because its calibration is only verbalized and no operating point accepts
 * it, so every step keeps the strong model.
 * @param stats - the session's statistics.
 * @param active - whether routing is in force for the session.
 * @returns true when the view reports the refusal.
 */
export function engineUncalibratedRecorded(stats: ModelRoutingStatsSnapshot, active: boolean): boolean {
  return active && stats.recent[0]?.reason === 'engine-uncalibrated'
}

/**
 * Whether the recent decisions record an engine that could not answer, which
 * the view reports as a notice beside the statistics.
 * @param stats - the session's statistics.
 * @returns true when a recent decision's reason is engine-unavailable or breaker-open.
 */
export function engineTroubleRecorded(stats: ModelRoutingStatsSnapshot): boolean {
  return stats.recent.some(row => row.reason === 'engine-unavailable' || row.reason === 'breaker-open')
}

/**
 * The provider/model the session routes from: the strong model, when one served calls.
 * @param stats - the session's statistics.
 * @returns `provider/model`, or undefined.
 */
export function strongRoute(stats: ModelRoutingStatsSnapshot): string | undefined {
  const strong = stats.models.find(model => model.role === 'strong')
  return strong === undefined ? undefined : `${strong.provider}/${strong.model}`
}

/** The verdict banner's two lines. */
export interface RoutingVerdict {
  /** One sentence stating what routing did. */
  headline: string
  /** The evidence behind it, and the Off suffix when routing is Off now. */
  detail: string
}

/**
 * Compute the verdict sentence from the statistics.
 * @param stats - the session's statistics.
 * @param gate - the configured gate, or null while it loads.
 * @param active - whether routing is in force for the session.
 * @param t - the view's translate.
 * @returns the verdict, or undefined when the session has no decisions.
 */
export function routingVerdict(
  stats: ModelRoutingStatsSnapshot,
  gate: ModelRoutingGateView | null,
  active: boolean,
  t: RoutingTranslate,
): RoutingVerdict | undefined {
  const { counts } = stats
  if (counts.decisions === 0) return undefined
  const parts: string[] = []
  let headline: string
  if (counts.downgradedSteps === 0) {
    headline = t('verdict.kept', { decisions: counts.decisions })
    const best = stats.confidence.max
    if (best !== null) {
      parts.push(gate === null
        ? t('verdict.best', { best: formatScore(best) })
        : t('verdict.best.threshold', { best: formatScore(best), threshold: formatScore(gate.downgradeThreshold) }))
    }
    const top = stats.keptReasons[0]
    if (top !== undefined) parts.push(t('verdict.top', { reason: top.reason, count: top.count }))
  } else {
    const served = stats.models.filter(model => model.role === 'candidate' && model.steps > 0).map(model => model.model)
    headline = t(counts.streaks === 1 ? 'verdict.served.one' : 'verdict.served', {
      share: formatPercent(counts.downgradedSteps / counts.steps),
      models: served.join(', '),
      streaks: counts.streaks,
    })
  }
  if (!active) parts.push(t('verdict.off'))
  return { headline, detail: parts.join(' ') }
}

/** One KPI tile. */
export interface RoutingKpi {
  /** Stable id, for keys and tests. */
  id: string
  /** Tile label. */
  label: string
  /** Headline value. */
  value: string
  /** Unit rendered small beside the value, when any. */
  unit?: string
  /** The line under the value. */
  detail: string
}

/**
 * Compute the eight KPI tiles. The last tile, characters sent off the
 * machine, needs each engine's egress class; without it the tile reports
 * that the egress is unknown.
 * @param stats - the session's statistics.
 * @param gate - the configured gate, or null while it loads.
 * @param egressOf - the egress class of an engine name, when the engine registry reports it.
 * @param t - the view's translate.
 * @returns the tiles in display order.
 */
export function routingKpis(
  stats: ModelRoutingStatsSnapshot,
  gate: ModelRoutingGateView | null,
  egressOf: ((engine: string) => 'none' | 'local' | 'remote' | undefined) | undefined,
  t: RoutingTranslate,
): RoutingKpi[] {
  const { counts, latency, moved } = stats
  const top = stats.keptReasons[0]
  const switchCost = stats.cold
    .filter(row => row.cause === 'routed-switch' || row.cause === 'routed-return' || row.cause === 'manual-switch')
    .reduce((sum, row) => sum + row.tokens, 0)
  const latencyDetail = [
    latency.p95 === null ? undefined : t('kpi.latency.p95', { p95: formatMs(latency.p95) }),
    latency.p50 === null || latency.withEligibility > 0 ? undefined : t('kpi.latency.judgeOnly'),
    gate === null ? undefined : t('kpi.latency.deadline', { deadline: formatMs(gate.judgmentDeadlineMs) }),
    stats.judge.calls === 0 ? undefined : t('kpi.latency.tokens', { tokens: formatTokens(stats.judge.promptTokens + stats.judge.outputTokens) }),
  ].filter((part): part is string => part !== undefined)
  return [
    {
      id: 'decisions',
      label: t('kpi.decisions'),
      value: String(counts.decisions),
      detail: t(counts.warmUps === 0 ? 'kpi.decisions.detail' : 'kpi.decisions.detail.warmUps', {
        consults: counts.consults, failed: counts.judgeFailed, warmUps: counts.warmUps,
      }),
    },
    {
      id: 'pool-steps',
      label: t('kpi.pool'),
      value: formatPercent(counts.steps === 0 ? 0 : counts.downgradedSteps / counts.steps),
      detail: t(counts.streaks === 1 ? 'kpi.pool.detail.one' : 'kpi.pool.detail', { steps: counts.downgradedSteps, total: counts.steps, streaks: counts.streaks }),
    },
    {
      id: 'kept-strong',
      label: t('kpi.kept'),
      value: String(counts.keptStrong),
      detail: top === undefined ? t('kpi.none') : t('kpi.kept.detail', { reason: top.reason, count: top.count }),
    },
    {
      id: 'route-failed',
      label: t('kpi.routeFailed'),
      value: String(counts.routeFailed),
      detail: t('kpi.routeFailed.detail'),
    },
    {
      id: 'latency',
      label: t('kpi.latency'),
      value: latency.p50 === null ? t('kpi.none') : String(latency.p50),
      ...latency.p50 === null ? {} : { unit: t('kpi.latency.unit') },
      detail: latencyDetail.length === 0 ? t('kpi.latency.empty') : latencyDetail.join(' · '),
    },
    {
      id: 'moved',
      label: t('kpi.moved'),
      value: formatTokens(Math.max(0, moved.tokensOffStrong - moved.returnReprefill)),
      detail: t('kpi.moved.detail', {
        moved: formatTokens(moved.tokensOffStrong),
        reprefill: formatTokens(moved.returnReprefill),
        objective: moved.objective ?? t('kpi.moved.noObjective'),
      }),
    },
    {
      id: 'switch-cost',
      label: t('kpi.switchCost'),
      value: formatTokens(switchCost),
      detail: t('kpi.switchCost.detail'),
    },
    egressKpi(stats, egressOf, t),
  ]
}

/**
 * The off-machine tile, which needs each engine's egress class: unknown until
 * the registry is read, and for asks to an engine the registry does not list,
 * which the tile counts apart from the remote characters it can attribute.
 */
function egressKpi(
  stats: ModelRoutingStatsSnapshot,
  egressOf: ((engine: string) => 'none' | 'local' | 'remote' | undefined) | undefined,
  t: RoutingTranslate,
): RoutingKpi {
  const label = t('kpi.egress')
  if (egressOf === undefined) return { id: 'egress', label, value: t('kpi.none'), detail: t('kpi.egress.unknown') }
  const classes = stats.egress.map(row => ({ row, egress: egressOf(row.engine) }))
  const unlisted = classes.filter(entry => entry.egress === undefined).reduce((sum, entry) => sum + entry.row.asks, 0)
  const remote = classes.filter(entry => entry.egress === 'remote').map(entry => entry.row)
  const unlistedDetail = t('kpi.egress.unlisted', { asks: unlisted })
  if (remote.length === 0) {
    return unlisted === 0
      ? { id: 'egress', label, value: '0', detail: t('kpi.egress.local') }
      : { id: 'egress', label, value: t('kpi.none'), detail: unlistedDetail }
  }
  const chars = remote.reduce((sum, row) => sum + row.chars, 0)
  const asks = remote.reduce((sum, row) => sum + row.asks, 0)
  const atMost = remote.some(row => row.bound === 'at-most')
  const detail = t(atMost ? 'kpi.egress.atMost' : 'kpi.egress.exact', { asks })
  return {
    id: 'egress',
    label,
    value: atMost ? `≤ ${formatTokens(chars)}` : formatTokens(chars),
    unit: t('kpi.egress.unit'),
    detail: unlisted === 0 ? detail : `${detail} · ${unlistedDetail}`,
  }
}

/** One check of a decision's ordered gate path. */
export type GateCheckId =
  | 'pool' | 'base-listed' | 'cooldown' | 'engine' | 'eligibility' | 'judge' | 'difficulty'
  | 'keep-current' | 'confidence' | 'margin' | 'hold'

/**
 * The gate path in the order the router applies it: the pool and the state
 * size, the listed base, the re-entry cooldown, the engine (present, enabled,
 * breaker closed, calibrated), candidate eligibility, the judgment call, and
 * the answer's checks.
 */
export const GATE_CHECKS: readonly GateCheckId[] = [
  'pool', 'base-listed', 'cooldown', 'engine', 'eligibility', 'judge', 'difficulty', 'keep-current', 'confidence', 'margin', 'hold',
]

/**
 * The check each logged reason stops at. `sticky-hold` and
 * `judgment-failure-held` hold a streak instead of stopping it, and
 * `gate-passed` passes every check. A reason outside this table (the union
 * is extensible through later router versions) marks no check.
 */
const FAILING_CHECK: Readonly<Record<string, GateCheckId>> = {
  'no-candidates': 'pool',
  'state-too-large': 'pool',
  'base-unlisted': 'base-listed',
  'reentry-cooldown': 'cooldown',
  'engine-absent': 'engine',
  'engine-disabled': 'engine',
  'breaker-open': 'engine',
  'engine-uncalibrated': 'engine',
  'candidate-ineligible': 'eligibility',
  'candidate-equals-base': 'eligibility',
  'thinking-mode-incompatible': 'eligibility',
  'model-unavailable': 'eligibility',
  'engine-unavailable': 'judge',
  'invalid-answer': 'judge',
  'judgment-error': 'judge',
  'unknown-candidate': 'judge',
  'judgment-input-too-large': 'judge',
  'judgment-failure-held': 'judge',
  'difficulty-too-high': 'difficulty',
  'escalated': 'difficulty',
  'current-preferred': 'keep-current',
  'low-confidence': 'confidence',
  'thin-margin': 'margin',
  'gate-failed': 'hold',
  'hold-cap': 'hold',
  'manual-deviation': 'hold',
  'route-errors': 'hold',
  'route-failed': 'hold',
  'mode-off': 'hold',
  'sticky-hold': 'hold',
}

/** Reasons that keep a held streak rather than ending it at their check. */
const HELD_REASONS = new Set(['sticky-hold', 'judgment-failure-held'])

/** One row of the drill-down's gate path. */
export interface GateCheck {
  /** The check. */
  id: GateCheckId
  /** `pass` before the stopping check, `fail` at it, `held` for a held streak, `skip` after it. */
  status: 'pass' | 'fail' | 'held' | 'skip'
  /** Whether this is the first failing check, which the drill-down highlights. */
  first: boolean
}

/**
 * The ordered gate path of one decision, with its first failing check. The
 * router checks the engine before assessing candidates and again immediately
 * before asking, and refuses an answering engine after the answer, so an
 * engine refusal on a decision that recorded the assessment stopped at the
 * judgment call rather than before eligibility.
 * @param reason - the decision's logged reason.
 * @param assessed - whether the decision recorded a candidate eligibility assessment.
 * @returns one row per check in router order.
 */
export function gatePath(reason: string, assessed: boolean): GateCheck[] {
  if (reason === 'gate-passed') return GATE_CHECKS.map(id => ({ id, status: 'pass', first: false }))
  const listed = FAILING_CHECK[reason]
  const stop = listed === 'engine' && assessed ? 'judge' : listed
  if (stop === undefined) return GATE_CHECKS.map(id => ({ id, status: 'skip', first: false }))
  const held = HELD_REASONS.has(reason)
  const index = GATE_CHECKS.indexOf(stop)
  return GATE_CHECKS.map((id, position) => {
    if (position < index) return { id, status: 'pass', first: false }
    if (position === index) return { id, status: held ? 'held' : 'fail', first: !held }
    if (held && id === 'hold') return { id, status: 'held', first: false }
    return { id, status: 'skip', first: false }
  })
}

/** One row of the drill-down's route options table. */
export interface RouteOptionRow {
  /** Option key: a candidate id or `keep-current`. */
  option: string
  /** `provider / model` (and effort) of a candidate, or undefined for keep-current. */
  route?: string
  /** The candidate's description or the option rubric. */
  description?: string
  /** The judge's probability for the option. */
  probability: number
  /** Whether the judge chose this option. */
  chosen: boolean
}

/**
 * The route question's text, from the logged judgment questions.
 * @param decision - the logged decision.
 * @returns the choice question's instructions, or undefined when no judgment was asked.
 */
export function routeQuestion(decision: ModelRoutingDecision): string | undefined {
  return decision.judgmentQuestions?.find(question => question.kind === 'choice')?.instructions
}

/**
 * The route options with their probabilities, most probable first.
 * @param decision - the logged decision.
 * @returns one row per option the judge scored; empty when it answered no route.
 */
export function routeOptions(decision: ModelRoutingDecision): RouteOptionRow[] {
  const route = decision.route
  if (route === undefined) return []
  const question = decision.judgmentQuestions?.find(entry => entry.kind === 'choice')
  const candidates = decision.candidateEligibility?.candidates ?? []
  return Object.entries(route.probabilities)
    .map(([option, probability]): RouteOptionRow => {
      const candidate = candidates.find(entry => entry.id === option)
      const rubric = question?.kind === 'choice'
        ? question.options.find(entry => entry.option === option)?.description
        : undefined
      const description = candidate?.description ?? rubric
      return {
        option,
        ...candidate === undefined ? {} : {
          route: [`${candidate.provider} / ${candidate.model}`, candidate.reasoningEffort].filter(Boolean).join(' · '),
        },
        ...description === undefined ? {} : { description },
        probability,
        chosen: option === route.choice,
      }
    })
    .sort((left, right) => right.probability - left.probability)
}

/**
 * The top-two probability margin of one route answer.
 * @param decision - the logged decision.
 * @returns the margin, or undefined without a route answer.
 */
export function routeMargin(decision: ModelRoutingDecision): number | undefined {
  if (decision.route === undefined) return undefined
  const sorted = Object.values(decision.route.probabilities).sort((left, right) => right - left)
  return (sorted[0] ?? 0) - (sorted[1] ?? 0)
}

/** The gate configuration now for one engine, with the calibration of its floors. */
export type EngineGate = ModelRoutingGateView & {
  /** The preregistration that set the floors, when the engine's operating point names one. */
  calibratedBy?: string
  /** Whether the floors are the engine's operating point or the global defaults. */
  origin: 'operating-point' | 'global'
}

/**
 * The gate configuration now for one engine: its operating point's floors
 * replace the global ones when the configuration names that engine.
 * @param gate - the configured gate.
 * @param engineId - the engine's registry id, when known.
 * @returns the gate the engine is judged by now.
 */
export function gateFor(gate: ModelRoutingGateView, engineId: string | undefined): EngineGate {
  const point = engineId === undefined ? undefined : gate.operatingPoints.find(candidate => candidate.engine === engineId)
  if (point === undefined) return { ...gate, origin: 'global' }
  return {
    ...gate,
    downgradeThreshold: point.downgradeThreshold,
    downgradeMargin: point.downgradeMargin,
    origin: 'operating-point',
    ...point.calibratedBy === undefined ? {} : { calibratedBy: point.calibratedBy },
  }
}

/**
 * The thresholds one drill-down compares a decision with, and where they come
 * from: `recorded` values are the ones in force when the decision was made;
 * `now` values are the configuration in force when the view read it, which
 * can differ from the decision's own when the configuration or the engine's
 * operating point changed since.
 */
export interface DecisionThresholds {
  /** Whether the confidence and margin floors were recorded on the decision or read from the configuration now. */
  source: 'recorded' | 'now'
  /**
   * Whether the difficulty scores were recorded on the decision, which it
   * does when the consult asked the difficulty question, or read from the
   * configuration now.
   */
  difficultySource: 'recorded' | 'now'
  /** Where the floors came from: the engine's operating point or the global defaults. */
  origin: 'operating-point' | 'global'
  /** The preregistration that set the floors; absent means they are uncalibrated. */
  calibratedBy?: string
  /** Route-confidence floor. */
  downgradeThreshold: number
  /** Top-two margin floor. */
  downgradeMargin: number
  /** Difficulty at or above which a streak is not entered. */
  entryScoreCeiling: number
  /** Difficulty at or above which a held streak escalates back. */
  escalateBackScoreThreshold: number
}

/**
 * Resolve the thresholds a drill-down compares one decision with: the
 * thresholds the decision recorded as applied, else the configuration in
 * force now from the `modelRouting.decision` read's gate, for the engine the
 * decision names when it recorded one. A decision records the difficulty
 * scores only when its consult asked the difficulty question; otherwise they
 * too come from the gate.
 * @param detail - the decision detail.
 * @returns the thresholds and their sources.
 */
export function decisionThresholds(detail: ModelRoutingDecisionDetail): DecisionThresholds {
  const recorded = detail.decision.thresholds
  const entry = recorded?.entryScoreCeiling
  const escalate = recorded?.escalateBackScoreThreshold
  const difficulty = entry !== undefined && escalate !== undefined
    ? { difficultySource: 'recorded' as const, entryScoreCeiling: entry, escalateBackScoreThreshold: escalate }
    : {
      difficultySource: 'now' as const,
      entryScoreCeiling: detail.gate.entryScoreCeiling,
      escalateBackScoreThreshold: detail.gate.escalateBackScoreThreshold,
    }
  if (recorded === undefined) {
    const now = gateFor(detail.gate, detail.decision.engineId)
    return {
      source: 'now',
      origin: now.origin,
      ...now.calibratedBy === undefined ? {} : { calibratedBy: now.calibratedBy },
      downgradeThreshold: now.downgradeThreshold,
      downgradeMargin: now.downgradeMargin,
      ...difficulty,
    }
  }
  return {
    source: 'recorded',
    origin: recorded.source,
    ...recorded.calibratedBy === undefined ? {} : { calibratedBy: recorded.calibratedBy },
    downgradeThreshold: recorded.downgradeThreshold,
    downgradeMargin: recorded.downgradeMargin,
    ...difficulty,
  }
}

/**
 * The drill-down's label for where its thresholds come from.
 * @param thresholds - the resolved thresholds.
 * @param t - the view's translate.
 * @returns the source pill text.
 */
export function thresholdSourceLabel(thresholds: DecisionThresholds, t: RoutingTranslate): string {
  if (thresholds.source === 'now' && thresholds.origin === 'global') return t('drill.source.now')
  const origin = t(thresholds.origin === 'operating-point' ? 'drill.source.origin.point' : 'drill.source.origin.global')
  const when = t(thresholds.source === 'now' ? 'drill.source.when.now' : 'drill.source.when.recorded')
  return thresholds.calibratedBy === undefined
    ? t('drill.source.uncalibrated', { when, origin })
    : t('drill.source.calibrated', { when, origin, calibratedBy: thresholds.calibratedBy })
}

/**
 * The drill-down's tick label for one threshold value, naming its source.
 * @param thresholds - the resolved thresholds.
 * @param value - the threshold value to label.
 * @param t - the view's translate.
 * @returns e.g. `threshold now 0.80` or `threshold at the time 0.80`.
 */
export function thresholdValueLabel(thresholds: DecisionThresholds, value: number, t: RoutingTranslate): string {
  return t(thresholds.source === 'now' ? 'drill.threshold.now' : 'drill.threshold.recorded', { value: formatScore(value) })
}


/** Dot tone of a judge's lifecycle state. */
export type JudgeTone = 'done' | 'warning' | 'ongoing' | 'error'

/** The status line's judge segment. */
export interface JudgeSegment {
  /** The judge's label, or the reason there is none. */
  name: string
  /** The lifecycle state as text, when an engine is selected. */
  state?: string
  /** The state's dot tone, when an engine is selected. */
  tone?: JudgeTone
  /** Where the engine sends the state it judges, when an engine is selected. */
  egress?: JudgmentEngineView['egress']
  /** Whether the engine's answers are uncalibrated, when an engine is selected. */
  uncalibrated?: boolean
}

const STATE_TONE: Readonly<Record<JudgmentEngineView['state'], JudgeTone>> = {
  'ready': 'done',
  'starting': 'ongoing',
  'unavailable': 'error',
  'unconfigured': 'warning',
  'not-installed': 'warning',
  'unsupported-host': 'error',
}

/**
 * The status line's judge segment for the router's judge.
 * @param judge - the resolved judge.
 * @param t - the view's translate.
 * @returns the segment.
 */
export function judgeSegment(judge: RoutingJudge, t: RoutingTranslate): JudgeSegment {
  switch (judge.kind) {
    case 'loading': return { name: t('judge.loading') }
    case 'failed': return { name: t('judge.failed', { message: judge.message }) }
    case 'none': return { name: t(`judge.none.${judge.reason}`) }
    case 'engine': return {
      name: judge.engine.label,
      state: t(`judge.state.${judge.engine.state}`),
      tone: STATE_TONE[judge.engine.state],
      egress: judge.engine.egress,
      uncalibrated: judge.engine.calibration !== 'calibrated',
    }
  }
}

/**
 * The notice for a selected judge that cannot answer now.
 * @param judge - the resolved judge.
 * @param t - the view's translate.
 * @returns the notice, or undefined when the judge is ready or none is selected.
 */
export function judgeTrouble(judge: RoutingJudge, t: RoutingTranslate): string | undefined {
  if (judge.kind !== 'engine' || judge.engine.state === 'ready') return undefined
  const state = t(`judge.state.${judge.engine.state}`)
  return judge.engine.detail === undefined
    ? t('judge.trouble', { name: judge.engine.label, state })
    : t('judge.trouble.detail', { name: judge.engine.label, state, detail: judge.engine.detail })
}

/**
 * Whether the router refuses the judge: an engine whose calibration is only
 * verbalized is never asked unless its operating point accepts it, which is
 * the router's own rule.
 * @param judge - the resolved judge.
 * @param gate - the configured gate, or null while it loads.
 * @returns true or false, or undefined while the gate is needed and not loaded.
 */
export function judgeRefused(judge: RoutingJudge, gate: ModelRoutingGateView | null): boolean | undefined {
  if (judge.kind !== 'engine' || judge.engine.calibration !== 'verbalized') return false
  if (gate === null) return undefined
  const id = String(judge.engine.id)
  return gate.operatingPoints.find(point => point.engine === id)?.acceptVerbalized !== true
}

/**
 * The notice for a judge the router refuses, which is never asked.
 * @param judge - the resolved judge.
 * @param gate - the configured gate, or null while it loads.
 * @param t - the view's translate.
 * @returns the notice, or undefined when the router asks the judge or the gate is not loaded.
 */
export function judgeNotUsed(judge: RoutingJudge, gate: ModelRoutingGateView | null, t: RoutingTranslate): string | undefined {
  if (judge.kind !== 'engine' || judgeRefused(judge, gate) !== true) return undefined
  return t('judge.notUsed', { name: judge.engine.label })
}

/**
 * The warning shown while routing is on and the judge sends conversation
 * state off this machine.
 * @param judge - the resolved judge.
 * @param active - whether routing is in force for the session.
 * @param gate - the configured gate, whose `stateMaxChars` caps each consult, or null while it loads.
 * @param t - the view's translate.
 * @returns the warning, or undefined when nothing leaves the machine.
 */
export function egressWarning(
  judge: RoutingJudge,
  active: boolean,
  gate: ModelRoutingGateView | null,
  t: RoutingTranslate,
): string | undefined {
  if (!active || judge.kind !== 'engine' || judge.engine.egress !== 'remote') return undefined
  // A refused judge is never asked, and a verbalized one needs the gate to tell.
  if (judgeRefused(judge, gate) !== false) return undefined
  const destination = judge.engine.destination ?? judge.engine.label
  return gate === null
    ? t('egress.warning', { destination })
    : t('egress.warning.chars', { destination, chars: gate.stateMaxChars.toLocaleString('en-US') })
}

/**
 * The G2 note when answered consults recorded confidence or margin floors
 * other than the configuration now, which the chart's threshold line draws.
 * @param stats - the session's statistics.
 * @param gate - the configured gate, or null while it loads.
 * @param t - the view's translate.
 * @returns the note, or undefined when every recorded floor matches or none is recorded.
 */
export function recordedThresholdsNote(
  stats: ModelRoutingStatsSnapshot,
  gate: ModelRoutingGateView | null,
  t: RoutingTranslate,
): string | undefined {
  if (gate === null) return undefined
  const other = stats.thresholds.filter(entry => entry.downgradeThreshold !== gate.downgradeThreshold
    || entry.downgradeMargin !== gate.downgradeMargin)
  if (other.length === 0) return undefined
  return t('g2.recorded', {
    consults: other.reduce((sum, entry) => sum + entry.consults, 0),
    values: other.map(entry => t('g2.recorded.value', {
      threshold: formatScore(entry.downgradeThreshold),
      margin: formatScore(entry.downgradeMargin),
    })).join('; '),
  })
}

/**
 * The G6 note on what an ask's latency covers: the judgment call alone when
 * no decision recorded its eligibility assessment, or which asks include it.
 * @param stats - the session's statistics.
 * @param t - the view's translate.
 * @returns the note, or undefined when every ask includes the assessment or none is timed.
 */
export function latencyScopeNote(stats: ModelRoutingStatsSnapshot, t: RoutingTranslate): string | undefined {
  const timed = stats.latency.counts.reduce((sum, count) => sum + count, 0)
  if (timed === 0 || stats.latency.withEligibility === timed) return undefined
  return stats.latency.withEligibility === 0
    ? t('g6.judgeOnly')
    : t('g6.eligibilityPartial', { with: stats.latency.withEligibility, total: timed })
}
