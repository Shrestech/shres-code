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

/**
 * Model-routing status over the host-computed `modelRouting` projection. The
 * seat is a toggle, so both modes render: while routing is off the button is the
 * `Auto` affordance that executes /route on; while it is on the button reads
 * `auto → <model> (<confidence>)` from the last logged decision, carries the
 * held streak's elapsed turns and the consider-stronger hint beside it, and
 * executes /route off. Nothing here holds routing state — the projection is the
 * only source, and a decision the host has not logged yet is not predicted.
 * @param props - runtime share, injected face, and the locale seat.
 * @returns the chip, or null while routing is unavailable for this session.
 */
export function RoutingChip({ useProjection, locked, available, setRouting, t }: RoutingChipProps) {
  const routing = useProjection('modelRouting')
  const [flipping, setFlipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (!available || routing === undefined) return null

  const on = routing.active
  const last = routing.last
  const sticky = routing.sticky
  const selection = last?.selection
  const confidence = last?.confidence
  const stickyTurn = sticky !== undefined && sticky.active ? sticky.turnsElapsed : null
  const hint = last?.hint === 'consider-stronger' ? t('hint.considerStronger') : null

  const toggle = (): void => {
    // No flipping/locked guard: both disable the button, so no click arrives.
    setFlipping(true)
    setError(null)
    void setRouting(!on).then((failure) => {
      if (!aliveRef.current) return
      setFlipping(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setFlipping(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={clsx(css.chip, on ? css.chipOn : css.chipOff)}
        aria-label={on ? t('chip.on.aria') : t('chip.off.aria')}
        title={on ? t('chip.on.title') : t('chip.off.title')}
        aria-busy={flipping}
        disabled={locked || flipping}
        onClick={toggle}
      >
        {/* Design literal, not copy: the wordmark is Auto off and auto on in every locale. */}
        {on ? 'auto' : 'Auto'}
        {/* The routed route is a host identity from the projection, not client state. */}
        {on && selection !== undefined && (
          <span className={css.route}>
            {` → ${selection.model}`}
            {confidence !== undefined && ` (${confidence.toFixed(2)})`}
          </span>
        )}
      </button>
      {on && stickyTurn !== null && <span className={css.sticky}>{t('sticky.turn', { turn: stickyTurn })}</span>}
      {on && hint !== null && <span className={css.hint}>{hint}</span>}
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <span className={css.error} role="status" title={error}>failed to switch model routing</span>}
    </span>
  )
}
