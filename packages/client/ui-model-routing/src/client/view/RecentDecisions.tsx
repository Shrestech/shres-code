/**
 * The Routing view's recent-decisions table: newest first, fifty rows per
 * page. A row's turn button opens the decision's drill-down; its Trajectory
 * link reveals the decision's ROUTING row in Trajectory.
 */
import { useState } from 'react'
import type { ModelRoutingStatsSnapshot } from '@shres-code/shres-code-model-router/client'
import type { RoutingTranslate } from './derive.ts'
import { formatMs, formatScore } from './format.ts'
import css from './RoutingView.module.css'

/** Rows per page. */
export const RECENT_PAGE_SIZE = 50

/** Props of the recent-decisions table. */
export interface RecentDecisionsProps {
  /** Recent decisions, newest first. */
  rows: ModelRoutingStatsSnapshot['recent']
  /** Total decisions in the session, which may exceed the rows kept. */
  total: number
  /** Open one decision's drill-down. */
  onOpen: (seq: number) => void
  /** Reveal one decision in Trajectory, when Trajectory is available. */
  onTrajectory?: ((seq: number) => void) | undefined
  /** The view's translate. */
  t: RoutingTranslate
}

/**
 * The recent-decisions table with paging.
 * @param props - rows, total, handoffs, and translate.
 * @returns the table section.
 */
export function RecentDecisions({ rows, total, onOpen, onTrajectory, t }: RecentDecisionsProps) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / RECENT_PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = rows.slice(current * RECENT_PAGE_SIZE, (current + 1) * RECENT_PAGE_SIZE)
  return (
    <section className={css.card} aria-labelledby="routing-recent-heading">
      <div className={css.cardHead}>
        <div>
          <h3 id="routing-recent-heading" className={css.cardTitle}>{t('recent.title')}</h3>
          <p className={css.cardSubtitle}>{t('recent.subtitle')}</p>
        </div>
        <span className={css.count}>{t('recent.count', { shown: rows.length, total })}</span>
      </div>
      <table className={css.recentTable}>
        <thead>
          <tr>
            <th scope="col">{t('recent.col.turn')}</th>
            <th scope="col">{t('recent.col.outcome')}</th>
            <th scope="col">{t('recent.col.reason')}</th>
            <th scope="col" className={css.numeric}>{t('recent.col.best')}</th>
            <th scope="col" className={css.numeric}>{t('recent.col.difficulty')}</th>
            <th scope="col">{t('recent.col.engine')}</th>
            <th scope="col" className={css.numeric}>{t('recent.col.latency')}</th>
            <th scope="col"><span className={css.visuallyHidden}>{t('recent.col.trajectory')}</span></th>
          </tr>
        </thead>
        <tbody>
          {shown.map(row => (
            <tr key={row.seq}>
              <td>
                <button type="button" className={css.rowButton} aria-label={t('recent.open', { turn: row.turn, step: row.step })} onClick={() => { onOpen(row.seq) }}>
                  {`${row.turn}.${row.step}`}
                </button>
              </td>
              <td><span className={css.outcome} data-outcome={row.outcome}>{row.outcome}</span></td>
              <td>{row.reason}</td>
              <td className={css.numeric}>{row.best === null ? '' : formatScore(row.best)}</td>
              <td className={css.numeric}>{row.difficulty === null ? '' : row.difficulty.toFixed(1)}</td>
              <td>{row.engine ?? ''}</td>
              <td className={css.numeric}>{row.latencyMs === null ? '' : formatMs(row.latencyMs)}</td>
              <td>
                {onTrajectory !== undefined && (
                  <button type="button" className={css.link} onClick={() => { onTrajectory(row.seq) }}>{t('recent.trajectory')}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className={css.pager}>
          <button type="button" className={css.link} disabled={current === 0} onClick={() => { setPage(current - 1) }}>{t('recent.newer')}</button>
          <span>{t('recent.page', { page: current + 1, pages })}</span>
          <button type="button" className={css.link} disabled={current === pages - 1} onClick={() => { setPage(current + 1) }}>{t('recent.older')}</button>
        </div>
      )}
    </section>
  )
}
