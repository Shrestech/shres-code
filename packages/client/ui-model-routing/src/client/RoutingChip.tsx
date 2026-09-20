import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.modelRouting
// seat and its {locked} owner share).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the `modelRouting` SessionProjectionMap merge for useProjection.
import type {} from '@shres-code/shres-code-model-router/client'
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
export function RoutingChip({ useProjection, locked, available, setRouting, restoreStrong, t }: RoutingChipProps) {
  const routing = useProjection('modelRouting')
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
  // Idle is the dead end the projection names: routing is on and every decision
  // resolves the candidate the session already runs, so no turn can downgrade.
  const idle = on && routing.last?.reason === 'candidate-equals-base'
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
        onClick={() => { run('mode', () => setRouting(!on)) }}
      >
        {/* Design literal, not copy: the wordmark is Auto off and auto on in every locale. */}
        {on ? 'auto' : 'Auto'}
      </button>
      {idle && <span className={css.idle}>{t('idle.warning')}</span>}
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
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {failure !== null && (
        <span className={css.error} role="status" title={failure.detail}>{FAILURE_LABEL[failure.action]}</span>
      )}
    </span>
  )
}
