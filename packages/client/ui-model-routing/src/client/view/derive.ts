/**
 * Pure derivations over the `modelRoutingStats` snapshot, the `modelRouting`
 * projection, and one logged decision: the view state, the verdict, the KPI
 * tiles, the drill-down's gate path, and its option rows. Components render
 * these values and compute nothing themselves.
 */
import type {
  ModelRoutingDecision, ModelRoutingGateView, ModelRoutingStatsSnapshot,
} from '@shres-code/shres-code-model-router/client'
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
 * Classify the view state from the mode and the latest decision.
 * @param stats - the session's statistics.
 * @param active - whether routing is in force for the session.
 * @returns the view state.
 */
export function routingViewState(stats: ModelRoutingStatsSnapshot, active: boolean): RoutingViewState {
  if (!active && stats.counts.decisions === 0) return 'never-used'
  if (!active) return 'normal'
  const reason = stats.recent[0]?.reason
  if (reason === 'engine-absent' || reason === 'engine-disabled') return 'no-engine'
  if (reason === 'base-unlisted') return 'base-unlisted'
  return 'normal'
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
    headline = t('verdict.served', {
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
    gate === null ? undefined : t('kpi.latency.deadline', { deadline: formatMs(gate.judgmentDeadlineMs) }),
  ].filter((part): part is string => part !== undefined)
  return [
    {
      id: 'decisions',
      label: t('kpi.decisions'),
      value: String(counts.decisions),
      detail: t('kpi.decisions.detail', { consults: counts.consults, failed: counts.judgeFailed }),
    },
    {
      id: 'pool-steps',
      label: t('kpi.pool'),
      value: formatPercent(counts.steps === 0 ? 0 : counts.downgradedSteps / counts.steps),
      detail: t('kpi.pool.detail', { steps: counts.downgradedSteps, total: counts.steps, streaks: counts.streaks }),
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

/** The off-machine tile, which needs each engine's egress class. */
function egressKpi(
  stats: ModelRoutingStatsSnapshot,
  egressOf: ((engine: string) => 'none' | 'local' | 'remote' | undefined) | undefined,
  t: RoutingTranslate,
): RoutingKpi {
  const label = t('kpi.egress')
  const classes = stats.egress.map(row => ({ row, egress: egressOf?.(row.engine) }))
  if (classes.some(entry => entry.egress === undefined)) {
    return { id: 'egress', label, value: t('kpi.none'), detail: t('kpi.egress.unknown') }
  }
  const remote = classes.filter(entry => entry.egress === 'remote').map(entry => entry.row)
  if (remote.length === 0) return { id: 'egress', label, value: '0', detail: t('kpi.egress.local') }
  const chars = remote.reduce((sum, row) => sum + row.chars, 0)
  const asks = remote.reduce((sum, row) => sum + row.asks, 0)
  const atMost = remote.some(row => row.bound === 'at-most')
  return {
    id: 'egress',
    label,
    value: atMost ? `≤ ${formatTokens(chars)}` : formatTokens(chars),
    unit: t('kpi.egress.unit'),
    detail: t(atMost ? 'kpi.egress.atMost' : 'kpi.egress.exact', { asks }),
  }
}

/** One check of a decision's ordered gate path. */
export type GateCheckId =
  | 'base-listed' | 'cooldown' | 'eligibility' | 'judge' | 'difficulty'
  | 'keep-current' | 'confidence' | 'margin' | 'hold'

/** The gate path in the order the router applies it. */
export const GATE_CHECKS: readonly GateCheckId[] = [
  'base-listed', 'cooldown', 'eligibility', 'judge', 'difficulty', 'keep-current', 'confidence', 'margin', 'hold',
]

/**
 * The check each logged reason stops at. `sticky-hold` and
 * `judgment-failure-held` hold a streak instead of stopping it, and
 * `gate-passed` passes every check. A reason outside this table (the union
 * is extensible through later router versions) marks no check.
 */
const FAILING_CHECK: Readonly<Record<string, GateCheckId>> = {
  'base-unlisted': 'base-listed',
  'reentry-cooldown': 'cooldown',
  'no-candidates': 'eligibility',
  'candidate-ineligible': 'eligibility',
  'candidate-equals-base': 'eligibility',
  'thinking-mode-incompatible': 'eligibility',
  'model-unavailable': 'eligibility',
  'engine-absent': 'judge',
  'engine-disabled': 'judge',
  'engine-unavailable': 'judge',
  'breaker-open': 'judge',
  'invalid-answer': 'judge',
  'judgment-error': 'judge',
  'unknown-candidate': 'judge',
  'state-too-large': 'judge',
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
 * The ordered gate path of one decision, with its first failing check.
 * @param reason - the decision's logged reason.
 * @returns one row per check in router order.
 */
export function gatePath(reason: string): GateCheck[] {
  if (reason === 'gate-passed') return GATE_CHECKS.map(id => ({ id, status: 'pass', first: false }))
  const stop = FAILING_CHECK[reason]
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
