/**
 * Settings › Model routing › Workspace overview: routing across one
 * workspace's sessions over a range, read from the Host's workspace rollup.
 * It informs the configuration above it; per-session detail stays in each
 * session's Routing view, which a table row opens.
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ModelRoutingStatsRange, ModelRoutingWorkspaceStats } from '@shres-code/shres-code-model-router/client'
import type { OverviewController, OverviewState } from './overview.ts'
import { OVERVIEW_POLL_MS } from './overview.ts'
import { messageOf } from './model.ts'
import type { ModelRoutingKey } from './locales.ts'
import css from './OverviewCard.module.css'

/** The locale seat's resolver, narrowed to this page's keys. */
type Translate = (key: ModelRoutingKey, params?: Record<string, string | number>) => string

/** The range options, in the order the toggle shows them. */
const RANGES: readonly ModelRoutingStatsRange[] = ['24h', '7d', 'all']

/** Chart class and legend key of each reason group. */
const GROUPS = {
  switched: { className: 'groupSwitched', label: 'group.switched' },
  'judge-no': { className: 'groupJudge', label: 'group.judgeNo' },
  'fail-closed': { className: 'groupClosed', label: 'group.failClosed' },
  engine: { className: 'groupEngine', label: 'group.engine' },
} as const satisfies Record<ModelRoutingWorkspaceStats['reasons'][number]['group'], { className: string; label: ModelRoutingKey }>

const COUNT = new Intl.NumberFormat('en-US')
const TOKENS = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })
const CLOCK = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * A share as a percent, or a dash without a whole.
 * @param part - the counted part.
 * @param whole - the whole.
 * @returns the percent text.
 */
export function share(part: number, whole: number): string {
  return whole === 0 ? '—' : PERCENT.format(part / whole)
}

/**
 * The time of day a read finished, in the page's time zone.
 * @param ms - epoch milliseconds.
 * @returns the clock text.
 */
export function clockOf(ms: number): string {
  return CLOCK.format(ms)
}

/** Props of {@link OverviewCard}. */
export interface OverviewCardProps {
  controller: OverviewController
  /** The reader's snapshot. */
  overview: OverviewState
  /** The workspace to read: the current session's, else the most recent one. */
  workspace: { id: string; title: string } | undefined
  /** Session list rows, for the table's session titles. */
  titles: Readonly<Record<string, { displayTitle: string } | undefined>>
  /**
   * Open a session's Routing view; throws when it cannot. Absent while no
   * conversation service can reveal it, and the rows then offer no link.
   */
  openRoutingView: ((sessionId: string) => void) | undefined
  /** Leave Settings for the workspace. */
  close: () => void
  t: Translate
}

/** Render the overview card. */
export function OverviewCard({ controller, overview, workspace, titles, openRoutingView, close, t }: OverviewCardProps): ReactNode {
  const headingId = useId()
  const [openFailure, setOpenFailure] = useState<string | null>(null)
  const workspaceId = workspace?.id
  useEffect(() => (workspaceId === undefined ? undefined : controller.watch(workspaceId)), [controller, workspaceId])

  const open = openRoutingView === undefined
    ? undefined
    : (sessionId: string): void => {
      try {
        openRoutingView(sessionId)
      } catch (error) {
        setOpenFailure(messageOf(error))
        return
      }
      setOpenFailure(null)
      close()
    }
  const stats = overview.workspaceId === workspaceId ? overview.stats : null

  return (
    <section className={css['card']} aria-labelledby={headingId}>
      <div className={css['head']}>
        <div className={css['titles']}>
          <h3 id={headingId} className={css['title']}>{t('overview.title')}</h3>
          <p className={css['sub']}>
            {workspace === undefined ? t('overview.introNoWorkspace') : t('overview.intro', { workspace: workspace.title })}
          </p>
        </div>
        <div className={css['segmented']} role="radiogroup" aria-label={t('overview.range')}>
          {RANGES.map(range => (
            <button
              key={range}
              type="button"
              role="radio"
              aria-checked={overview.range === range}
              className={clsx(css['segment'], overview.range === range && css['segmentOn'])}
              onClick={() => { controller.setRange(range) }}
            >
              {t(`overview.range.${range}`)}
            </button>
          ))}
        </div>
      </div>
      {workspace === undefined ? <p className={css['muted']}>{t('overview.noWorkspace')}</p> : null}
      {workspace !== undefined && stats === null && overview.status !== 'error'
        ? <p className={css['muted']} role="status">{t('overview.loading')}</p>
        : null}
      {workspace !== undefined && overview.status === 'error' && overview.error !== null
        ? (
          <p className={css['warning']} role="alert">
            {t('overview.failed', { message: overview.error })}{' '}
            <button type="button" className={css['link']} onClick={() => { void controller.refresh() }}>{t('retry')}</button>
          </p>
        )
        : null}
      {openFailure === null ? null : <p className={css['warning']} role="alert">{t('overview.openFailed', { message: openFailure })}</p>}
      {stats === null ? null : <OverviewBody stats={stats} titles={titles} open={open} t={t} />}
    </section>
  )
}

/** The numbers of one read. */
function OverviewBody({ stats, titles, open, t }: {
  stats: ModelRoutingWorkspaceStats
  titles: OverviewCardProps['titles']
  open: ((sessionId: string) => void) | undefined
  t: Translate
}): ReactNode {
  const { sessions, counts } = stats
  const kpis: readonly { key: string; label: string; value: string; detail: string }[] = [
    {
      key: 'sessions',
      label: t('overview.kpi.sessions'),
      value: COUNT.format(sessions.included),
      detail: t('overview.kpi.sessionsDetail', { members: COUNT.format(sessions.members) }),
    },
    {
      key: 'decisions',
      label: t('overview.kpi.decisions'),
      value: COUNT.format(counts.decisions),
      detail: t('overview.kpi.decisionsDetail', { consults: COUNT.format(counts.consults) }),
    },
    {
      key: 'pool',
      label: t('overview.kpi.pool'),
      value: share(counts.downgradedSteps, counts.steps),
      detail: t('overview.kpi.poolDetail', { pool: COUNT.format(counts.downgradedSteps), steps: COUNT.format(counts.steps) }),
    },
    {
      key: 'cold',
      label: t('overview.kpi.cold'),
      value: TOKENS.format(stats.routedSwitches.tokens),
      detail: t('overview.kpi.coldDetail', { count: COUNT.format(stats.routedSwitches.count) }),
    },
  ]
  return (
    <>
      <dl className={css['kpis']}>
        {kpis.map(kpi => (
          <div key={kpi.key} className={css['kpi']}>
            <dt className={css['kpiLabel']}>{kpi.label}</dt>
            <dd className={css['kpiValue']}>{kpi.value}</dd>
            <dd className={css['kpiDetail']}>{kpi.detail}</dd>
          </div>
        ))}
      </dl>
      {sessions.included === 0
        ? <p className={css['muted']}>{t('overview.empty')}</p>
        : (
          <div className={css['pair']}>
            <ReasonsChart reasons={stats.reasons} t={t} />
            <SessionTable rows={stats.rows} titles={titles} open={open} t={t} />
          </div>
        )}
      <p className={css['sub']}>
        {t('overview.footer', {
          time: clockOf(stats.computedAt),
          included: COUNT.format(sessions.included),
          inRange: COUNT.format(sessions.inRange),
          seconds: OVERVIEW_POLL_MS / 1000,
        })}
      </p>
      {sessions.capped ? <p className={css['sub']}>{t('overview.capped', { included: COUNT.format(sessions.included) })}</p> : null}
      {sessions.summarized < sessions.members
        ? <p className={css['sub']}>{t('overview.unsummarized', { count: COUNT.format(sessions.members - sessions.summarized) })}</p>
        : null}
    </>
  )
}

/** Height of one reason row in the chart, in SVG units. */
const ROW = 22
/** Width of the reason labels, in SVG units. */
const LABEL = 150
/** Chart width, in SVG units. */
const WIDTH = 480

/** G3 across sessions: decisions per reason, coloured by what decided them. */
function ReasonsChart({ reasons, t }: { reasons: ModelRoutingWorkspaceStats['reasons']; t: Translate }): ReactNode {
  const [showTable, setShowTable] = useState(false)
  const headingId = useId()
  const most = Math.max(...reasons.map(entry => entry.count))
  const barSpace = WIDTH - LABEL - 40
  const summary = reasons.map(entry => `${entry.reason} ${String(entry.count)}`).join(', ')
  return (
    <div className={css['panel']}>
      <div className={css['panelHead']}>
        <h4 id={headingId} className={css['panelTitle']}>{t('overview.reasons.title')}</h4>
        <button type="button" className={css['toggle']} aria-pressed={showTable} onClick={() => { setShowTable(!showTable) }}>
          {t('overview.table')}
        </button>
      </div>
      {showTable
        ? (
          <table className={css['table']} aria-labelledby={headingId}>
            <thead><tr><th>{t('overview.reasons.reason')}</th><th>{t('overview.reasons.group')}</th><th className={css['num']}>{t('overview.reasons.count')}</th></tr></thead>
            <tbody>
              {reasons.map(entry => (
                <tr key={entry.reason}>
                  <td>{entry.reason}</td>
                  <td>{t(GROUPS[entry.group].label)}</td>
                  <td className={css['num']}>{COUNT.format(entry.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
        : (
          <>
            <svg className={css['chart']} viewBox={`0 0 ${String(WIDTH)} ${String(reasons.length * ROW + 8)}`} role="img" aria-label={t('overview.reasons.alt', { summary })}>
              {reasons.map((entry, at) => {
                const width = barSpace * entry.count / most
                return (
                  <g key={entry.reason}>
                    <text x={LABEL - 8} y={18 + at * ROW} textAnchor="end" className={css['axis']}>{entry.reason}</text>
                    <rect x={LABEL} y={7 + at * ROW} width={width} height={14} rx={3} className={css[GROUPS[entry.group].className]} />
                    <text x={LABEL + width + 6} y={18 + at * ROW} className={css['value']}>{COUNT.format(entry.count)}</text>
                  </g>
                )
              })}
            </svg>
            <ul className={css['legend']}>
              {Object.values(GROUPS).map(group => (
                <li key={group.label}><span className={clsx(css['swatch'], css[group.className])} aria-hidden="true" />{t(group.label)}</li>
              ))}
            </ul>
          </>
        )}
    </div>
  )
}

/** The rolled-up sessions, most recent decision first. */
function SessionTable({ rows, titles, open, t }: {
  rows: ModelRoutingWorkspaceStats['rows']
  titles: OverviewCardProps['titles']
  open: ((sessionId: string) => void) | undefined
  t: Translate
}): ReactNode {
  return (
    <div className={clsx(css['panel'], css['tableWrap'])}>
      <table className={css['table']}>
        <caption className={css['caption']}>{t('overview.sessions.caption')}</caption>
        <thead>
          <tr>
            <th>{t('overview.sessions.session')}</th>
            <th className={css['num']}>{t('overview.sessions.pool')}</th>
            <th className={css['num']}>{t('overview.sessions.decisions')}</th>
            {open === undefined ? null : <th><span className={css['hidden']}>{t('overview.sessions.open')}</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const title = titles[row.sessionId]?.displayTitle ?? row.sessionId
            return (
              <tr key={row.sessionId}>
                <td className={css['session']} title={title}>{title}</td>
                <td className={css['num']} title={t('overview.sessions.poolDetail', { pool: COUNT.format(row.downgradedSteps), steps: COUNT.format(row.steps) })}>
                  {share(row.downgradedSteps, row.steps)}
                </td>
                <td className={css['num']}>{COUNT.format(row.decisions)}</td>
                {open === undefined
                  ? null
                  : (
                    <td>
                      <button type="button" className={css['link']} aria-label={t('overview.sessions.openNamed', { session: title })} onClick={() => { open(row.sessionId) }}>
                        {t('overview.sessions.open')}
                      </button>
                    </td>
                  )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
