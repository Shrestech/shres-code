import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@shres-code/shres-code-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.modelRouting
// seat and its {locked} owner share).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the `modelRouting` SessionProjectionMap merge for useProjection.
import type { ModelRoutingGateView } from '@shres-code/shres-code-model-router/client'
import { routingJudge, type RoutingJudge } from './engine-source.ts'
import { judgeRefused } from './view/derive.ts'
import type { RoutingChipInjected } from './index.ts'
import css from './RoutingChip.module.css'

/** Full routing-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type RoutingChipProps =
  PropsRuntime<'conversation.input.modelRouting'> & InjectFace<RoutingChipInjected> & PropsLocale<'modelRouting'>

/** The chip's two gestures; each carries its own failure label. */
type ChipAction = 'mode' | 'restore'

/** English failure labels, one per gesture (error-surface policy: not localized). */
const FAILURE_LABEL: Record<ChipAction, string> = {
  mode: 'failed to switch model routing',
  restore: 'failed to restore the strong model',
}

/**
 * Model-routing status over the host-computed `modelRouting` projection. The
 * seat is a toggle, so both modes render: while routing is off the button is the
 * `Auto` affordance that executes /route on; while it is on the button reads
 * `auto` and executes /route off. The chip states the routing mode alone — it
 * names no routed model, no confidence, no streak position, and no model hint,
 * because those render in the trajectory and the full session log. A session
 * whose last decision reads `candidate-equals-base` runs the routing target as
 * its own selection, so routing is on and can change nothing: the chip reports
 * that idle state and offers the one-click restore of the selection to the route
 * the last streak was entered on, submitted through the same model-selection
 * path both selection surfaces use, with its prefix re-prefill cost stated.
 * Nothing here holds routing state — the projection is the only source, and a
 * decision the host has not logged yet is not predicted.
 * @param props - runtime share, injected face, and the locale seat.
 * @returns the chip, or null while routing is unavailable for this session.
 */
export function RoutingChip({
  useProjection, useRoutingEngine, locked, reveal, available, setRouting, restoreStrong, loadGate, openRoutingSettings, t,
}: RoutingChipProps) {
  const routing = useProjection('modelRouting')
  const engineState = useRoutingEngine(state => state)
  const [confirm, setConfirm] = useState<Extract<RoutingJudge, { kind: 'engine' | 'loading' | 'failed' }> | null>(null)
  const [confirmGate, setConfirmGate] = useState<ModelRoutingGateView | null>(null)
  const [pending, setPending] = useState<ChipAction | null>(null)
  const [failure, setFailure] = useState<{ action: ChipAction; detail: string } | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (!available || routing === undefined) return null

  const on = routing.active
  // Idle is a dead end the projection names: routing is on, but every decision
  // resolves the candidate the session already runs or finds that routing does
  // not start from the session's model, so no turn can downgrade.
  const reason = routing.last?.reason
  const idle = on && (reason === 'candidate-equals-base' || reason === 'base-unlisted')
  const strong = idle ? routing.lastStrong : undefined

  const run = (action: ChipAction, request: () => Promise<string | null>): void => {
    // No pending/locked guard: both disable the controls, so no click arrives.
    setPending(action)
    setFailure(null)
    void request().then((detail) => {
      if (!aliveRef.current) return
      setPending(null)
      if (detail !== null) setFailure({ action, detail })
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setPending(null)
      setFailure({ action, detail: reason instanceof Error ? reason.message : String(reason) })
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={clsx(css.chip, on ? css.chipOn : css.chipOff)}
        aria-label={on ? t('chip.on.aria') : t('chip.off.aria')}
        title={on ? t('chip.on.title') : t('chip.off.title')}
        aria-busy={pending === 'mode'}
        disabled={locked || pending !== null}
        onClick={() => {
          if (on) {
            run('mode', () => setRouting(false))
            return
          }
          // Turning routing on is the gesture that starts sending conversation
          // state to the judge, so a judge that sends it off this machine, or
          // one not known yet, asks first; a local judge or none does not.
          const judge = routingJudge(engineState)
          const asks = judge.kind === 'loading' || judge.kind === 'failed'
            || (judge.kind === 'engine' && judge.engine.egress === 'remote')
          if (!asks) {
            run('mode', () => setRouting(true))
            return
          }
          setConfirm(judge)
          setConfirmGate(null)
          loadGate().then((gate) => {
            if (aliveRef.current) setConfirmGate(gate)
          }, () => {
            // Without the cap the confirm names the destination alone; the
            // gesture stays available, so nothing else needs the failure.
          })
        }}
      >
        {/* Design literal, not copy: the wordmark is Auto off and auto on in every locale. */}
        {on ? 'auto' : 'Auto'}
      </button>
      {reveal !== undefined && (
        <button
          type="button"
          className={css.details}
          aria-label={t('chip.details')}
          title={t('chip.details')}
          // Opening this session's Routing view changes no routing state, so a
          // locked composer or a gesture in flight leaves it available.
          onClick={() => { reveal({ view: 'routing', target: { kind: 'none' } }) }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      )}
      {idle && <span className={css.idle}>{t(reason === 'base-unlisted' ? 'idle.unlisted' : 'idle.warning')}</span>}
      {strong !== undefined && (
        <button
          type="button"
          className={css.restore}
          // One string for the tooltip and the accessible name, so the announced
          // gesture keeps the visible label and still states what it costs.
          aria-label={t('idle.restore.title')}
          title={t('idle.restore.title')}
          aria-busy={pending === 'restore'}
          disabled={locked || pending !== null}
          onClick={() => { run('restore', () => restoreStrong(strong)) }}
        >
          {t('idle.restore')}
        </button>
      )}
      {confirm !== null && (
        <Modal
          open
          onClose={() => { setConfirm(null) }}
          title={t('confirm.title')}
          description={t('confirm.body')}
          closeLabel={t('confirm.close')}
          footer={(
            <span className={css.confirmActions}>
              <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('confirm.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirm(null)
                  run('mode', () => setRouting(true))
                }}
              >
                {t('confirm.turnOn')}
              </Button>
            </span>
          )}
        >
          <p className={css.confirmWarning}>{confirmWarning(confirm, confirmGate, t)}</p>
          <p className={css.confirmSettings}>
            {t('confirm.settings.before')}{' '}
            {openRoutingSettings === undefined
              ? t('status.settings.link')
              : (
                <button
                  type="button"
                  className={css.confirmLink}
                  onClick={() => {
                    setConfirm(null)
                    openRoutingSettings()
                  }}
                >
                  {t('status.settings.link')}
                </button>
              )}
          </p>
        </Modal>
      )}
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {failure !== null && (
        <span className={css.error} role="status" title={failure.detail}>{FAILURE_LABEL[failure.action]}</span>
      )}
    </span>
  )
}

/**
 * The confirm's warning: where the judge sends conversation state, with the
 * per-consult character cap once the gate has loaded, or that the router
 * refuses the judge and so sends nothing.
 * @param judge - the judge the confirm was opened for.
 * @param gate - the configured gate, or null until it loads.
 * @param t - the chip's translate.
 * @returns the warning sentence.
 */
function confirmWarning(
  judge: Extract<RoutingJudge, { kind: 'engine' | 'loading' | 'failed' }>,
  gate: ModelRoutingGateView | null,
  t: RoutingChipProps['t'],
): string {
  if (judge.kind !== 'engine') return t('confirm.unknown')
  if (judgeRefused(judge, gate) === true) return t('confirm.refused')
  const destination = judge.engine.destination ?? judge.engine.label
  return gate === null
    ? t('confirm.warning', { destination })
    : t('confirm.warning.chars', { destination, chars: gate.stateMaxChars.toLocaleString('en-US') })
}
