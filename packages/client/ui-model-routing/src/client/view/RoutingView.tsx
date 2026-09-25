/**
 * The per-session Routing view, listed in the session's Activity popover
 * beside Chat and Trajectory. It reads this session's `modelRoutingStats`
 * and `modelRouting` projections, shows the routing mode read-only (the Auto
 * chip in the chat input is the one control), and renders the verdict, the
 * KPI tiles, G1 to G6, the streak exits, the recent decisions, and one
 * decision's drill-down. Handoffs to Trajectory and back ride the
 * conversation shell's `reveal` request.
 */
import { useEffect, useState } from 'react'
import type {
  ModelRoutingDecisionDetail, ModelRoutingGateView,
} from '@shres-code/shres-code-model-router/client'
import type { InjectFace, PropsLocale } from '@shres-code/shres-code-client-ui-slots'
import type { ConvViewOwnerProps, ConvViewProps } from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the `modelRouting`/`modelRoutingStats` SessionProjectionMap merges for useProjection.
import type {} from '@shres-code/shres-code-model-router/client'
import {
  ColdChart, ConfidenceChart, LatencyChart, ModelTimeline, ReasonsChart, StreakExits, TokensChart,
} from './charts.tsx'
import { DecisionDrawer } from './DecisionDrawer.tsx'
import {
  engineTroubleRecorded, routingKpis, routingVerdict, routingViewState, strongRoute,
} from './derive.ts'
import { RecentDecisions } from './RecentDecisions.tsx'
import css from './RoutingView.module.css'

/** Injected business face of the Routing view entry. */
export interface RoutingViewInjected {
  /**
   * Whether this session can show routing; false for addressed subagent
   * sessions, the same guard the Auto chip uses.
   */
  available: boolean
  /**
   * Fetch one logged decision with the configured gate.
   * @param seq - seq of the `model-routing/decision` event.
   * @returns the decision detail; rejects when the host cannot read it.
   */
  loadDecision: (seq: number) => Promise<ModelRoutingDecisionDetail>
  /**
   * Fetch the configured gate: thresholds, deadline, and difficulty scores.
   * @returns the gate; rejects when the host cannot read it.
   */
  loadGate: () => Promise<ModelRoutingGateView>
}

/** Full Routing view props: the view share, the conversation owner share, the injected face, and the locale seat. */
export type RoutingViewProps =
  ConvViewProps & ConvViewOwnerProps & InjectFace<RoutingViewInjected> & PropsLocale<'modelRouting'>

type GateLoad = { kind: 'loading' } | { kind: 'loaded'; gate: ModelRoutingGateView } | { kind: 'failed'; message: string }

/**
 * The Routing view.
 * @param props - view share, owner share, injected face, and locale seat.
 * @returns the view, or a notice when routing is unavailable for this session.
 */
export function RoutingView({
  useProjection, available, loadDecision, loadGate, inspect, onInspectDone, reveal, canReveal, t,
}: RoutingViewProps) {
  const stats = useProjection('modelRoutingStats')
  const routing = useProjection('modelRouting')
  const [gateLoad, setGateLoad] = useState<GateLoad>({ kind: 'loading' })
  const [gateAttempt, setGateAttempt] = useState(0)
  const [openSeq, setOpenSeq] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    setGateLoad({ kind: 'loading' })
    loadGate().then(
      (gate) => { if (live) setGateLoad({ kind: 'loaded', gate }) },
      (reason: unknown) => { if (live) setGateLoad({ kind: 'failed', message: reason instanceof Error ? reason.message : String(reason) }) },
    )
    return () => { live = false }
  }, [loadGate, gateAttempt])

  // Cross-view handoff: an event target is a decision seq to open.
  useEffect(() => {
    if (inspect?.target.kind !== 'event') return
    setOpenSeq(inspect.target.seq)
    onInspectDone?.()
  }, [inspect, onInspectDone])

  if (!available || routing === undefined || stats === undefined) {
    return <div className={css.view}><p className={css.muted}>{t('view.unavailable')}</p></div>
  }

  const gate = gateLoad.kind === 'loaded' ? gateLoad.gate : null
  const state = routingViewState(stats, routing.active)
  const verdict = routingVerdict(stats, gate, routing.active, t)
  const kpis = routingKpis(stats, gate, undefined, t)
  const trajectory = reveal !== undefined && canReveal?.('trajectory') === true
    ? (seq: number) => { reveal({ view: 'trajectory', target: { kind: 'event', seq } }) }
    : undefined
  const base = strongRoute(stats)

  return (
    <div className={css.view}>
      <header className={css.header}>
        <h2 className={css.heading}>{t('view.heading')}</h2>
        <span className={css.scopePill}>{t('view.scope')}</span>
      </header>
      <p className={css.status}>
        {t('status.mode')} <strong>{routing.active ? t('status.on') : t('status.off')}</strong>
        {' · '}{t('status.switch.before')} <span className={css.autoPill} aria-hidden="true">{routing.active ? 'auto' : 'Auto'}</span> {t('status.switch.after')}
      </p>
      {gateLoad.kind === 'failed' && (
        <p className={css.notice} role="alert">
          {t('gate.failed', { message: gateLoad.message })}{' '}
          <button type="button" className={css.link} onClick={() => { setGateAttempt(gateAttempt + 1) }}>{t('gate.retry')}</button>
        </p>
      )}
      {state === 'no-engine' && <p className={css.notice} role="status">{t('state.noEngine')}</p>}
      {state === 'base-unlisted' && <p className={css.notice} role="status">{t('state.baseUnlisted', { model: base ?? t('state.thisModel') })}</p>}
      {engineTroubleRecorded(stats) && <p className={css.notice} role="status">{t('state.engineTrouble')}</p>}
      {state === 'never-used'
        ? <section className={css.card}><p>{t('state.neverUsed')}</p></section>
        : (
          <>
            {verdict !== undefined && (
              <section className={css.verdict} role="status">
                <p className={css.verdictHeadline}>{verdict.headline}</p>
                {verdict.detail !== '' && <p className={css.verdictDetail}>{verdict.detail}</p>}
              </section>
            )}
            <div className={css.kpis}>
              {kpis.map(kpi => (
                <div key={kpi.id} className={css.kpi} data-kpi={kpi.id}>
                  <span className={css.kpiLabel}>{kpi.label}</span>
                  <span className={css.kpiValue}>
                    {kpi.value}
                    {kpi.unit !== undefined && <small className={css.kpiUnit}> {kpi.unit}</small>}
                  </span>
                  <span className={css.kpiDetail}>{kpi.detail}</span>
                </div>
              ))}
            </div>
            <ModelTimeline stats={stats} gate={gate} t={t} onStep={trajectory} onDecision={setOpenSeq} />
            <div className={css.graphs}>
              <ConfidenceChart stats={stats} gate={gate} t={t} />
              <ReasonsChart stats={stats} gate={gate} t={t} />
              <TokensChart stats={stats} gate={gate} t={t} />
              <ColdChart stats={stats} gate={gate} t={t} />
              <LatencyChart stats={stats} gate={gate} t={t} />
              <StreakExits stats={stats} gate={gate} t={t} />
            </div>
            <RecentDecisions rows={stats.recent} total={stats.counts.decisions} onOpen={setOpenSeq} onTrajectory={trajectory} t={t} />
          </>
        )}
      <p className={css.footer}>{t('view.footer')}</p>
      {openSeq !== null && (
        <DecisionDrawer
          seq={openSeq}
          loadDecision={loadDecision}
          onClose={() => { setOpenSeq(null) }}
          onTrajectory={trajectory === undefined ? undefined : () => { trajectory(openSeq) }}
          t={t}
        />
      )}
    </div>
  )
}
