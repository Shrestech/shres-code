import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { IconCloseFill14 } from '@shres-code/shres-code-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: the `jspace` SessionProjectionMap key merge.
import type {} from '@shres-code/shres-code-jspace/client'
import type { JSpaceChipInjected } from './slots.ts'
import { jspaceSettingsEnabled } from './settings.ts'
import css from './JSpaceChip.module.css'

/** Full chip props: runtime share & injected verbs + settings hook & locale. */
export type JSpaceChipProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<JSpaceChipInjected>
  & PropsLocale<'jspace'>

/**
 * Session J-Space status in the composer tool row. Visible only while
 * Settings `enabled` is true. An open card shows the on-state chip and
 * executes `/j-space off`; no card shows the off-state chip and
 * executes `/j-space on`.
 */
export function JSpaceChip({
  useProjection, useJspaceSettings, closeCard, openCard, sessionId, t,
}: JSpaceChipProps) {
  const enabled = jspaceSettingsEnabled(useJspaceSettings(s => s))
  const projection = useProjection('jspace')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (!enabled) return null
  const open = projection?.card != null && projection.card.sessionId === sessionId

  const run = (action: () => Promise<string | null>): void => {
    setPending(true)
    setError(null)
    void action().then((failure) => {
      if (!aliveRef.current) return
      setPending(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setPending(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap} data-jspace-chip={open ? 'on' : 'off'}>
      <button
        type="button"
        className={open ? `${css.chip} ${css.chipOn}` : css.chip}
        aria-label={open ? t('chip.on.aria') : t('chip.off.aria')}
        title={open ? t('chip.on.title') : t('chip.off.title')}
        disabled={pending}
        onClick={() => { run(open ? closeCard : openCard) }}
      >
        J-Space
        {open && (
          <span className={css.close} aria-hidden>
            <IconCloseFill14 size={12} />
          </span>
        )}
      </button>
      {error !== null && (
        <span className={css.error} role="status" title={error}>
          {open ? 'failed to close J-Space' : 'failed to open J-Space'}
        </span>
      )}
    </span>
  )
}
