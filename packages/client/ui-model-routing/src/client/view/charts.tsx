/**
 * The Routing view's graphs, G1 to G6 plus the streak-exit table, as
 * hand-built SVG. Every graph renders inside {@link ChartCard}: an SVG with a
 * `<title>` and a data-generated `<desc>`, a Table toggle that shows the
 * same data as an HTML table, and that table kept visually hidden otherwise so
 * screen readers read it by default. Marks are focusable; focus and hover
 * write the mark's text to the card's detail line.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import type {
  ModelRoutingGateView, ModelRoutingStatsModel, ModelRoutingStatsSnapshot,
} from '@shres-code/shres-code-model-router/client'
import type { RoutingTranslate } from './derive.ts'
import { formatMs, formatPercent, formatScore, formatTokens } from './format.ts'
import css from './charts.module.css'

/**
 * Chart class of a model's colour slot.
 * @param model - the model, or undefined for an index outside the model list.
 * @returns the CSS module class filling that slot's colour.
 */
export function slotClass(model: ModelRoutingStatsModel | undefined): string | undefined {
  switch (model?.colorSlot) {
    case 'strong': return css.slotStrong
    case 1: return css.slot1
    case 2: return css.slot2
    case 3: return css.slot3
    case 4: return css.slot4
    case 5: return css.slot5
    default: return css.slotOther
  }
}

/** Marker glyph of a model's colour slot, so colour is never the only channel. */
function slotGlyph(model: ModelRoutingStatsModel | undefined): string {
  switch (model?.colorSlot) {
    case 'strong': return '■'
    case 1: return '●'
    case 2: return '▲'
    case 3: return '◆'
    case 4: return '▼'
    case 5: return '★'
    default: return '□'
  }
}

/** A model's display name with its marker glyph. */
function modelLabel(model: ModelRoutingStatsModel | undefined): string {
  return model === undefined ? '?' : `${slotGlyph(model)} ${model.model}`
}

/** Props of one chart card. */
interface ChartCardProps {
  /** Card title. */
  title: string
  /** One-sentence explanation under the title. */
  subtitle: string
  /** The same data as an HTML table. */
  table: ReactNode
  /** The graph, or an empty-state sentence. */
  children: ReactNode
  /** Detail of the focused or hovered mark, when any. */
  detail?: string | undefined
  /** The view's translate. */
  t: RoutingTranslate
}

/**
 * One graph card with its Table toggle.
 * @param props - title, subtitle, table, graph, detail, and translate.
 * @returns the card.
 */
export function ChartCard({ title, subtitle, table, children, detail, t }: ChartCardProps) {
  const [showTable, setShowTable] = useState(false)
  const headingId = useId()
  return (
    <section className={css.card} aria-labelledby={headingId}>
      <div className={css.cardHead}>
        <div className={css.cardTitles}>
          <h3 id={headingId} className={css.cardTitle}>{title}</h3>
          <p className={css.cardSubtitle}>{subtitle}</p>
        </div>
        <button type="button" className={css.tableToggle} aria-pressed={showTable} onClick={() => { setShowTable(!showTable) }}>
          {t('chart.table')}
        </button>
      </div>
      {showTable
        ? <div className={css.tableWrap}>{table}</div>
        : (
          <>
            {children}
            <p className={css.detail} aria-live="polite">{detail ?? ''}</p>
            <div className={css.visuallyHidden}>{table}</div>
          </>
        )}
    </section>
  )
}

/** Props of one SVG graph. */
interface ChartSvgProps {
  /** Accessible title. */
  title: string
  /** Text alternative generated from the data. */
  description: string
  /** viewBox width. */
  width: number
  /** viewBox height. */
  height: number
  /** Marks and axes. */
  children: ReactNode
}

/** One graph's SVG: `role="img"` labelled by its title and text alternative. */
function ChartSvg({ title, description, width, height, children }: ChartSvgProps) {
  const titleId = useId()
  const descId = useId()
  return (
    <svg className={css.svg} role="img" aria-labelledby={`${titleId} ${descId}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet">
      <title id={titleId}>{title}</title>
      <desc id={descId}>{description}</desc>
      {children}
    </svg>
  )
}

/** Props of one focusable mark. */
interface MarkProps {
  /** The mark's text: its tooltip, accessible name, and detail line. */
  label: string
  /** Called on focus and hover. */
  onDetail: (label: string) => void
  /** Called on click, Enter, or Space; absent for a mark with no action. */
  onActivate?: (() => void) | undefined
  /** The mark's shapes. */
  children: ReactNode
}

/** A focusable graph mark. */
function Mark({ label, onDetail, onActivate, children }: MarkProps) {
  const onKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (onActivate === undefined || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onActivate()
  }
  return (
    <g
      className={clsx(css.mark, onActivate !== undefined && css.markAction)}
      tabIndex={0}
      role={onActivate === undefined ? 'img' : 'button'}
      aria-label={label}
      onFocus={() => { onDetail(label) }}
      onMouseEnter={() => { onDetail(label) }}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      <title>{label}</title>
      {children}
    </g>
  )
}

/** Props shared by the graphs. */
interface GraphProps {
  /** The session's statistics. */
  stats: ModelRoutingStatsSnapshot
  /** The configured gate, or null while it loads. */
  gate: ModelRoutingGateView | null
  /** The view's translate. */
  t: RoutingTranslate
}

const TIMELINE_WIDTH = 720
const TIMELINE_LEFT = 64
const MARK_GLYPH = { down: '▼', return: '▲', manual: '◆', failed: '✕', idle: '◌' } as const

/**
 * G1, the model timeline: one bar per step coloured by its model, markers for
 * switches, and one dot per decision at its best-candidate confidence.
 * @param props - statistics, gate, translate, and the two handoffs.
 * @returns the card.
 */
export function ModelTimeline({ stats, gate, t, onStep, onDecision }: GraphProps & {
  /** Reveal a step (its last assistant/message seq) in Trajectory, when Trajectory is available. */
  onStep?: ((seq: number) => void) | undefined
  /** Open a decision's drill-down. */
  onDecision: (seq: number) => void
}) {
  const [detail, setDetail] = useState<string>()
  const { steps, marks, decisions } = stats.timeline
  const plot = TIMELINE_WIDTH - TIMELINE_LEFT - 8
  const width = steps.length === 0 ? 0 : plot / steps.length
  const x = (index: number): number => TIMELINE_LEFT + index * width
  const confidenceY = (value: number): number => 104 - value * 40
  const threshold = gate?.downgradeThreshold
  const turnLabels = timelineTurnLabels(steps)
  const table = (
    <table className={css.table}>
      <thead><tr><th scope="col">{t('chart.col.step')}</th><th scope="col">{t('chart.col.model')}</th><th scope="col">{t('chart.col.marks')}</th></tr></thead>
      <tbody>
        {steps.map((step, index) => (
          <tr key={`${step.turn}.${step.step}.${index}`}>
            <td>{`${step.turn}.${step.step}`}</td>
            <td>{modelLabel(stats.models[step.model])}</td>
            <td>{marks.filter(mark => mark.i === index).map(mark => t(`mark.${mark.kind}`)).join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  const description = t('g1.desc', {
    steps: steps.length,
    models: stats.models.map(model => `${model.model} ${model.steps}`).join(', '),
    decisions: decisions.length,
    aggregated: stats.timeline.aggregated ? t('g1.aggregated') : '',
  })
  return (
    <ChartCard title={t('g1.title')} subtitle={t('g1.subtitle')} table={table} detail={detail} t={t}>
      {steps.length === 0
        ? <p className={css.empty}>{t('g1.empty')}</p>
        : (
          <ChartSvg title={t('g1.title')} description={description} width={TIMELINE_WIDTH} height={132}>
            <text className={css.axisText} x={0} y={34}>{t('g1.lane.model')}</text>
            <text className={css.axisText} x={0} y={88}>{t('g1.lane.confidence')}</text>
            {steps.map((step, index) => {
              const model = stats.models[step.model]
              const label = t('g1.step', { turn: step.turn, step: step.step, model: model?.model ?? '?' })
              return (
                <Mark key={`s${index}`} label={label} onDetail={setDetail} onActivate={onStep === undefined ? undefined : () => { onStep(step.seq) }}>
                  <rect className={slotClass(model)} x={x(index)} y={24} width={Math.max(width - 1, 1)} height={16} />
                </Mark>
              )
            })}
            {marks.map((mark, index) => (
              <text key={`m${index}`} className={css.markerGlyph} x={x(mark.i) + width / 2} y={18} textAnchor="middle">{MARK_GLYPH[mark.kind]}</text>
            ))}
            <line className={css.gridLine} x1={TIMELINE_LEFT} x2={TIMELINE_WIDTH - 8} y1={104} y2={104} />
            {threshold !== undefined && (
              <>
                <line
                  className={css.thresholdLine}
                  x1={TIMELINE_LEFT}
                  x2={TIMELINE_WIDTH - 8}
                  y1={confidenceY(threshold)}
                  y2={confidenceY(threshold)}
                />
                <text className={css.thresholdText} x={TIMELINE_WIDTH - 8} y={confidenceY(threshold) - 3} textAnchor="end">{t('chart.threshold', { value: formatScore(threshold) })}</text>
              </>
            )}
            {decisions.flatMap(entry => (entry.best === null ? [] : [{ ...entry, best: entry.best }])).map((entry) => {
              const best = entry.best
              const label = t('g1.decision', { outcome: entry.outcome, reason: entry.reason, best: formatScore(best) })
              return (
                <Mark key={`d${entry.seq}`} label={label} onDetail={setDetail} onActivate={() => { onDecision(entry.seq) }}>
                  <circle className={clsx(css.dot, entry.outcome === 'downgraded' ? css.dotDown : entry.outcome === 'error' ? css.dotError : css.dotKept)} cx={x(entry.i) + width / 2} cy={confidenceY(best)} r={3} />
                </Mark>
              )
            })}
            {turnLabels.map(label => (
              <text key={`t${label.turn}`} className={css.axisText} x={x(label.i)} y={126}>{`T${label.turn}`}</text>
            ))}
          </ChartSvg>
        )}
    </ChartCard>
  )
}

/**
 * Turn labels for the timeline axis, at most twelve, at each labelled turn's first step.
 * @param steps - the timeline steps.
 * @returns the labelled turns and their first step index.
 */
export function timelineTurnLabels(steps: ModelRoutingStatsSnapshot['timeline']['steps']): { turn: number; i: number }[] {
  const firsts: { turn: number; i: number }[] = []
  steps.forEach((step, index) => {
    if (firsts.at(-1)?.turn !== step.turn) firsts.push({ turn: step.turn, i: index })
  })
  const every = Math.max(1, Math.ceil(firsts.length / 12))
  return firsts.filter((_, index) => index % every === 0)
}

const CONFIDENCE_WIDTH = 480
const CONFIDENCE_LEFT = 16
const CONFIDENCE_PLOT = CONFIDENCE_WIDTH - CONFIDENCE_LEFT - 16

/**
 * G2, why routing kept the strong model: each consult's best-candidate
 * confidence in a beeswarm against the threshold, plus a margin strip.
 * @param props - statistics, gate, and translate.
 * @returns the card.
 */
export function ConfidenceChart({ stats, gate, t }: GraphProps) {
  const [detail, setDetail] = useState<string>()
  const { values, margins } = stats.confidence
  const x = (value: number): number => CONFIDENCE_LEFT + Math.min(1, Math.max(0, value)) * CONFIDENCE_PLOT
  const stacks = new Map<number, number>()
  const dots = values.map((value, index) => {
    const column = Math.round(value * 50)
    const level = stacks.get(column) ?? 0
    stacks.set(column, level + 1)
    return { value, index, y: 92 - level * 7 }
  })
  const threshold = gate?.downgradeThreshold
  const marginThreshold = gate?.downgradeMargin
  const table = (
    <table className={css.table}>
      <thead><tr><th scope="col">{t('chart.col.consult')}</th><th scope="col">{t('chart.col.best')}</th><th scope="col">{t('chart.col.margin')}</th></tr></thead>
      <tbody>
        {values.map((value, index) => (
          <tr key={index}><td>{index + 1}</td><td>{formatScore(value)}</td><td>{margins[index] === undefined ? '' : formatScore(margins[index])}</td></tr>
        ))}
      </tbody>
    </table>
  )
  const description = t('g2.desc', {
    consults: stats.confidence.total,
    max: stats.confidence.max === null ? t('kpi.none') : formatScore(stats.confidence.max),
    threshold: threshold === undefined ? t('kpi.none') : formatScore(threshold),
  })
  return (
    <ChartCard title={t('g2.title')} subtitle={t('g2.subtitle')} table={table} detail={detail} t={t}>
      {values.length === 0
        ? <p className={css.empty}>{t('g2.empty')}</p>
        : (
          <ChartSvg title={t('g2.title')} description={description} width={CONFIDENCE_WIDTH} height={150}>
            {threshold !== undefined && (
              <>
                <rect className={css.switchZone} x={x(threshold)} y={10} width={x(1) - x(threshold)} height={90} />
                <text className={css.thresholdText} x={x(threshold) + 4} y={20}>{t('g2.zone')}</text>
                <line className={css.thresholdLine} x1={x(threshold)} x2={x(threshold)} y1={8} y2={100} />
                <text className={css.thresholdText} x={x(threshold)} y={8} textAnchor="end">{t('chart.threshold', { value: formatScore(threshold) })}</text>
              </>
            )}
            <line className={css.gridLine} x1={x(0)} x2={x(1)} y1={100} y2={100} />
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map(tick => (
              <text key={tick} className={css.axisText} x={x(tick)} y={112} textAnchor="middle">{tick.toFixed(1)}</text>
            ))}
            {dots.map(dot => (
              <Mark key={`c${dot.index}`} label={t('g2.dot', { index: dot.index + 1, value: formatScore(dot.value) })} onDetail={setDetail}>
                <circle className={clsx(css.dot, css.dotKept)} cx={x(dot.value)} cy={dot.y} r={3} />
              </Mark>
            ))}
            <text className={css.axisText} x={CONFIDENCE_LEFT} y={132}>{t('g2.margin')}</text>
            {marginThreshold !== undefined && (
              <line className={css.thresholdLine} x1={x(marginThreshold)} x2={x(marginThreshold)} y1={124} y2={146} />
            )}
            {margins.map((margin, index) => (
              <circle key={`g${index}`} className={clsx(css.dot, css.dotMargin)} cx={x(margin)} cy={140} r={2} />
            ))}
          </ChartSvg>
        )}
    </ChartCard>
  )
}

const BAR_WIDTH = 480
const BAR_LEFT = 150
const BAR_PLOT = BAR_WIDTH - BAR_LEFT - 70

/** Chart class of a reason group. */
function groupClass(group: string): string | undefined {
  switch (group) {
    case 'switched': return css.groupSwitched
    case 'judge-no': return css.groupJudge
    case 'engine': return css.groupEngine
    default: return css.groupClosed
  }
}

/**
 * G3, decision reasons: one bar per reason, largest first, coloured by group.
 * @param props - statistics, gate, and translate.
 * @returns the card.
 */
export function ReasonsChart({ stats, t }: GraphProps) {
  const [detail, setDetail] = useState<string>()
  const rows = stats.reasons
  const max = Math.max(1, ...rows.map(row => row.count))
  const table = (
    <table className={css.table}>
      <thead><tr><th scope="col">{t('chart.col.reason')}</th><th scope="col">{t('chart.col.group')}</th><th scope="col">{t('chart.col.count')}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.reason}><td>{row.reason}</td><td>{t(`group.${row.group}`)}</td><td>{row.count}</td></tr>)}</tbody>
    </table>
  )
  const description = t('g3.desc', { reasons: rows.map(row => `${row.reason} ${row.count}`).join(', ') })
  return (
    <ChartCard title={t('g3.title')} subtitle={t('g3.subtitle')} table={table} detail={detail} t={t}>
      {rows.length === 0
        ? <p className={css.empty}>{t('g3.empty')}</p>
        : (
          <>
            <ChartSvg title={t('g3.title')} description={description} width={BAR_WIDTH} height={rows.length * 22 + 8}>
              {rows.map((row, index) => (
                <Mark key={row.reason} label={t('g3.bar', { reason: row.reason, group: t(`group.${row.group}`), count: row.count })} onDetail={setDetail}>
                  <text className={css.axisText} x={BAR_LEFT - 8} y={index * 22 + 16} textAnchor="end">{row.reason}</text>
                  <rect
                    className={groupClass(row.group)}
                    x={BAR_LEFT}
                    y={index * 22 + 6}
                    width={(row.count / max) * BAR_PLOT}
                    height={12}
                  />
                  <text className={css.valueText} x={BAR_LEFT + (row.count / max) * BAR_PLOT + 6} y={index * 22 + 16}>{row.count}</text>
                </Mark>
              ))}
            </ChartSvg>
            <ul className={css.legend}>
              {(['switched', 'judge-no', 'fail-closed', 'engine'] as const).map(group => (
                <li key={group}><span className={clsx(css.swatch, groupClass(group))} aria-hidden="true" />{t(`group.${group}`)}</li>
              ))}
            </ul>
          </>
        )}
    </ChartCard>
  )
}

/** Token classes of G4, in segment order. */
const TOKEN_CLASSES = ['cacheRead', 'cacheWrite', 'uncached', 'unreported', 'output'] as const

/** Sum of a model's token classes. */
function modelTotal(model: ModelRoutingStatsModel): number {
  return model.cacheRead + model.cacheWrite + model.uncached + model.unreported + model.output
}

/**
 * G4, tokens by model: one stacked bar per model by token class; the cache
 * write segment is outlined because it is the cost of a cold prefix.
 * @param props - statistics, gate, and translate.
 * @returns the card.
 */
export function TokensChart({ stats, t }: GraphProps) {
  const [detail, setDetail] = useState<string>()
  const models = stats.models
  const totalSteps = Math.max(1, stats.counts.steps)
  const max = Math.max(1, ...models.map(modelTotal))
  const table = (
    <table className={css.table}>
      <thead>
        <tr>
          <th scope="col">{t('chart.col.model')}</th><th scope="col">{t('chart.col.stepsShare')}</th>
          {TOKEN_CLASSES.map(name => <th key={name} scope="col">{t(`token.${name}`)}</th>)}
          <th scope="col">{t('chart.col.total')}</th>
        </tr>
      </thead>
      <tbody>
        {models.map(model => (
          <tr key={`${model.provider}/${model.model}`}>
            <td>{modelLabel(model)}</td><td>{formatPercent(model.steps / totalSteps)}</td>
            {TOKEN_CLASSES.map(name => <td key={name}>{formatTokens(model[name])}</td>)}
            <td>{formatTokens(modelTotal(model))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  const description = t('g4.desc', { models: models.map(model => `${model.model} ${formatTokens(modelTotal(model))}`).join(', ') })
  return (
    <ChartCard title={t('g4.title')} subtitle={t('g4.subtitle')} table={table} detail={detail} t={t}>
      {models.length === 0
        ? <p className={css.empty}>{t('g4.empty')}</p>
        : (
          <>
            <ChartSvg title={t('g4.title')} description={description} width={BAR_WIDTH} height={models.length * 30 + 8}>
              {models.map((model, index) => {
                let offset = BAR_LEFT
                const y = index * 30 + 6
                return (
                  <g key={`${model.provider}/${model.model}`}>
                    <text className={css.axisText} x={BAR_LEFT - 8} y={y + 10} textAnchor="end">{modelLabel(model)}</text>
                    <text className={css.axisText} x={BAR_LEFT - 8} y={y + 22} textAnchor="end">{t('g4.stepsShare', { share: formatPercent(model.steps / totalSteps) })}</text>
                    {TOKEN_CLASSES.map((name) => {
                      const size = (model[name] / max) * BAR_PLOT
                      const left = offset
                      offset += size
                      return (
                        <Mark key={name} label={t('g4.segment', { model: model.model, kind: t(`token.${name}`), tokens: formatTokens(model[name]) })} onDetail={setDetail}>
                          <rect className={clsx(slotClass(model), css[`token_${name}`], name === 'cacheWrite' && css.cacheWrite)} x={left} y={y} width={size} height={14} />
                        </Mark>
                      )
                    })}
                    <text className={css.valueText} x={offset + 6} y={y + 11}>{formatTokens(modelTotal(model))}</text>
                  </g>
                )
              })}
            </ChartSvg>
            <p className={css.note}>{t('g4.note')}</p>
          </>
        )}
    </ChartCard>
  )
}

/** Cold-prefill causes a routing or manual switch caused. */
const ROUTED_CAUSES = new Set(['routed-switch', 'routed-return'])

/**
 * G5, cold prefills by cause: tokens re-written to cache per cause, with the count.
 * @param props - statistics, gate, and translate.
 * @returns the card.
 */
export function ColdChart({ stats, t }: GraphProps) {
  const [detail, setDetail] = useState<string>()
  const rows = stats.cold
  const max = Math.max(1, ...rows.map(row => row.tokens))
  const table = (
    <table className={css.table}>
      <thead><tr><th scope="col">{t('chart.col.cause')}</th><th scope="col">{t('chart.col.count')}</th><th scope="col">{t('chart.col.tokens')}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.cause}><td>{t(`cold.${row.cause}`)}</td><td>{row.count}</td><td>{formatTokens(row.tokens)}</td></tr>)}</tbody>
    </table>
  )
  const description = t('g5.desc', { causes: rows.filter(row => row.count > 0).map(row => `${t(`cold.${row.cause}`)} ${formatTokens(row.tokens)}`).join(', ') || t('g5.none') })
  const ttl = stats.coldTtl.fallback ? t('g5.ttl.fallback', { ttl: formatMs(stats.coldTtl.ms) }) : t('g5.ttl', { ttl: formatMs(stats.coldTtl.ms) })
  return (
    <ChartCard title={t('g5.title')} subtitle={t('g5.subtitle')} table={table} detail={detail} t={t}>
      <ChartSvg title={t('g5.title')} description={description} width={BAR_WIDTH} height={rows.length * 20 + 8}>
        {rows.map((row, index) => (
          <Mark key={row.cause} label={t('g5.bar', { cause: t(`cold.${row.cause}`), tokens: formatTokens(row.tokens), count: row.count })} onDetail={setDetail}>
            <text className={css.axisText} x={BAR_LEFT - 8} y={index * 20 + 14} textAnchor="end">{t(`cold.${row.cause}`)}</text>
            {row.count === 0
              ? <text className={css.valueText} x={BAR_LEFT} y={index * 20 + 14}>{t('g5.zero')}</text>
              : (
                <>
                  <rect
                    className={ROUTED_CAUSES.has(row.cause) ? css.slot1 : css.neutralBar}
                    x={BAR_LEFT}
                    y={index * 20 + 5}
                    width={(row.tokens / max) * BAR_PLOT}
                    height={11}
                  />
                  <text className={css.valueText} x={BAR_LEFT + (row.tokens / max) * BAR_PLOT + 6} y={index * 20 + 14}>{`${formatTokens(row.tokens)} · ${row.count}×`}</text>
                </>
              )}
          </Mark>
        ))}
      </ChartSvg>
      <p className={css.note}>{ttl}</p>
    </ChartCard>
  )
}

const LATENCY_WIDTH = 480
const LATENCY_LEFT = 16
const LATENCY_FAILED = 40

/** Short axis label of a latency bucket bound. */
function bucketLabel(ms: number): string {
  return ms < 1_000 ? String(ms) : `${ms / 1_000}s`
}

/**
 * G6, judge latency: a histogram over log buckets with P50 and P95 markers,
 * the deadline line, and failed asks as a separate bar.
 * @param props - statistics, gate, and translate.
 * @returns the card.
 */
export function LatencyChart({ stats, gate, t }: GraphProps) {
  const [detail, setDetail] = useState<string>()
  const { bucketsMs, counts, failed, p50, p95, includesFailed } = stats.latency
  const bars = bucketsMs.map((bound, index) => ({ bound, count: counts[index] ?? 0 }))
  const answered = bars.reduce((sum, bar) => sum + bar.count, 0)
  const plot = LATENCY_WIDTH - LATENCY_LEFT - LATENCY_FAILED - 8
  const width = plot / Math.max(1, bucketsMs.length)
  const max = Math.max(1, failed, ...counts)
  const barHeight = (count: number): number => (count / max) * 80
  const bucketX = (ms: number): number => {
    const index = bucketsMs.findIndex(bound => ms <= bound)
    return LATENCY_LEFT + (index === -1 ? bucketsMs.length : index + 0.5) * width
  }
  const table = (
    <table className={css.table}>
      <thead><tr><th scope="col">{t('chart.col.bucket')}</th><th scope="col">{t('chart.col.count')}</th></tr></thead>
      <tbody>
        {bars.map(bar => <tr key={bar.bound}><td>{t('g6.bucket', { bound: formatMs(bar.bound) })}</td><td>{bar.count}</td></tr>)}
        <tr><td>{t('g6.failed')}</td><td>{failed}</td></tr>
      </tbody>
    </table>
  )
  const description = t('g6.desc', {
    p50: p50 === null ? t('kpi.none') : formatMs(p50),
    p95: p95 === null ? t('kpi.none') : formatMs(p95),
    answered,
    failed,
  })
  return (
    <ChartCard title={t('g6.title')} subtitle={t('g6.subtitle')} table={table} detail={detail} t={t}>
      {answered + failed === 0
        ? <p className={css.empty}>{t('g6.empty')}</p>
        : (
          <ChartSvg title={t('g6.title')} description={description} width={LATENCY_WIDTH} height={130}>
            <line className={css.gridLine} x1={LATENCY_LEFT} x2={LATENCY_WIDTH - 8} y1={100} y2={100} />
            {bars.map((bar, index) => (
              <Mark key={bar.bound} label={t('g6.bar', { bound: formatMs(bar.bound), count: bar.count })} onDetail={setDetail}>
                <rect
                  className={css.slot1}
                  x={LATENCY_LEFT + index * width + 1}
                  y={100 - barHeight(bar.count)}
                  width={Math.max(width - 2, 1)}
                  height={barHeight(bar.count)}
                />
                {index % 3 === 0 && <text className={css.axisText} x={LATENCY_LEFT + (index + 0.5) * width} y={114} textAnchor="middle">{bucketLabel(bar.bound)}</text>}
              </Mark>
            ))}
            <Mark label={t('g6.failedBar', { count: failed })} onDetail={setDetail}>
              <rect
                className={css.failedBar}
                x={LATENCY_WIDTH - LATENCY_FAILED}
                y={100 - barHeight(failed)}
                width={LATENCY_FAILED - 12}
                height={barHeight(failed)}
              />
              <text className={css.axisText} x={LATENCY_WIDTH - LATENCY_FAILED / 2 - 6} y={114} textAnchor="middle">{t('g6.failedShort', { count: failed })}</text>
            </Mark>
            {p50 !== null && <line className={css.percentileLine} x1={bucketX(p50)} x2={bucketX(p50)} y1={16} y2={100} />}
            {p50 !== null && <text className={css.valueText} x={bucketX(p50) - 3} y={14} textAnchor="end">{t('g6.p50', { value: formatMs(p50) })}</text>}
            {p95 !== null && <line className={css.percentileLine} x1={bucketX(p95)} x2={bucketX(p95)} y1={24} y2={100} />}
            {p95 !== null && <text className={css.valueText} x={bucketX(p95) + 3} y={22}>{t('g6.p95', { value: formatMs(p95) })}</text>}
            {gate !== null && (
              <>
                <line
                  className={css.thresholdLine}
                  x1={bucketX(gate.judgmentDeadlineMs)}
                  x2={bucketX(gate.judgmentDeadlineMs)}
                  y1={30}
                  y2={100}
                />
                <text className={css.thresholdText} x={bucketX(gate.judgmentDeadlineMs) + 3} y={96}>{t('g6.deadline')}</text>
              </>
            )}
            <text className={css.axisText} x={LATENCY_LEFT} y={128}>{t(includesFailed ? 'g6.axis.all' : 'g6.axis.answered')}</text>
          </ChartSvg>
        )}
    </ChartCard>
  )
}

/**
 * How downgrade streaks ended: the `sticky.brokenBy` histogram as a table.
 * @param props - statistics, gate, and translate.
 * @returns the card.
 */
export function StreakExits({ stats, t }: GraphProps) {
  const headingId = useId()
  return (
    <section className={css.card} aria-labelledby={headingId}>
      <div className={css.cardHead}>
        <div className={css.cardTitles}>
          <h3 id={headingId} className={css.cardTitle}>{t('exits.title')}</h3>
          <p className={css.cardSubtitle}>{t('exits.subtitle')}</p>
        </div>
      </div>
      {stats.exits.length === 0
        ? <p className={css.empty}>{t('exits.empty')}</p>
        : (
          <table className={css.table}>
            <thead><tr><th scope="col">{t('chart.col.exit')}</th><th scope="col">{t('chart.col.count')}</th></tr></thead>
            <tbody>{stats.exits.map(row => <tr key={row.brokenBy}><td>{row.brokenBy}</td><td>{row.count}</td></tr>)}</tbody>
          </table>
        )}
      {stats.streakLengths.max !== null && (
        <p className={css.note}>{t('exits.lengths', { median: stats.streakLengths.median ?? 0, max: stats.streakLengths.max })}</p>
      )}
    </section>
  )
}
