import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Menu, Modal } from '@shres-code/shres-code-client-ui-primitives'
import type { MenuEntry } from '@shres-code/shres-code-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.modelRouting
// seat and its {locked} owner share).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the `modelRouting` SessionProjectionMap merge for useProjection.
import type { ModelRoutingGateView } from '@shres-code/shres-code-model-router/client'
import { routingJudge, routingSettingsPage, type RoutingJudge } from './engine-source.ts'
import { judgeRefused } from './view/derive.ts'
import type { RoutingChipInjected } from './index.ts'
import css from './RoutingChip.module.css'

/** Full routing-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type RoutingChipProps =
  PropsRuntime<'conversation.input.modelRouting'> & InjectFace<RoutingChipInjected> & PropsLocale<'modelRouting'>

/** The chip's gestures; each carries its own failure label. */
type ChipAction = 'mode' | 'restore' | 'settings'

/** English failure labels, one per gesture (error-surface policy: not localized). */
const FAILURE_LABEL: Record<ChipAction, string> = {
  mode: 'failed to switch model routing',
  restore: 'failed to restore the strong model',
  settings: 'failed to open Settings › Model routing',
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
  // Offered only while the page exists: opening a section that is not registered rejects.
  const openSettings = routingSettingsPage(engineState) ? openRoutingSettings : undefined
  const [confirm, setConfirm] = useState<ConfirmedJudge | null>(null)
  const [confirmMode, setConfirmMode] = useState<'on' | 'shadow'>('on')
  const [confirmGate, setConfirmGate] = useState<ModelRoutingGateView | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState<ChipAction | null>(null)
  const [failure, setFailure] = useState<{ action: ChipAction; detail: string } | null>(null)
  const aliveRef = useRef(true)
  const idleDescriptionId = useId()
  const failureDescriptionId = useId()

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (!available || routing === undefined) return null

  const mode = routing.mode
  const on = mode === 'on'
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

  // Turning routing on, or starting shadow, is the gesture that starts sending
  // conversation state to the judge, so a judge that sends it off this machine,
  // or one not known yet, asks first. An id no engine registers is not known:
  // an engine registering under it later is asked with no further gesture. A
  // local judge, judgment switched off, or no dispatcher does not ask.
  const requestJudged = (wanted: 'on' | 'shadow'): void => {
    const judge = routingJudge(engineState)
    if (!confirms(judge)) {
      run('mode', () => setRouting(wanted === 'shadow' ? 'shadow' : true))
      return
    }
    setConfirmMode(wanted)
    setConfirm(judge)
    setConfirmGate(null)
    loadGate().then((gate) => {
      if (aliveRef.current) setConfirmGate(gate)
    }, () => {
      // Without the cap the confirm names the destination alone; the
      // gesture stays available, so nothing else needs the failure.
    })
  }

  // The mode group is always offered; the Routing view entry exists only while
  // the session can reveal it.
  const menuEntries: readonly MenuEntry[] = [
    { type: 'label', id: 'mode-heading', text: t('menu.mode') },
    { id: 'off', label: t('mode.off') },
    { id: 'shadow', label: t('mode.shadow') },
    { id: 'on', label: t('mode.on') },
    ...reveal === undefined ? [] : [
      { type: 'separator' as const, id: 'mode-separator' },
      { id: 'details', label: t('chip.details') },
    ],
  ]

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={clsx(css.chip, mode === 'shadow' ? css.chipShadow : on ? css.chipOn : css.chipOff)}
        aria-label={mode === 'shadow' ? t('chip.shadow.aria') : on ? t('chip.on.aria') : t('chip.off.aria')}
        title={mode === 'shadow' ? t('chip.shadow.title') : on ? t('chip.on.title') : t('chip.off.title')}
        aria-busy={pending === 'mode'}
        disabled={locked || pending !== null}
        onClick={() => {
          // Off's primary gesture turns routing on; on's and shadow's turn it
          // off, because shadow never switched anything to undo.
          if (mode !== 'off') {
            run('mode', () => setRouting(false))
            return
          }
          requestJudged('on')
        }}
      >
        {/* Design literal, not copy: the wordmark is Auto off, auto on, and
            auto · shadow in every locale. */}
        {mode === 'shadow' ? 'auto · shadow' : on ? 'auto' : 'Auto'}
      </button>
      <Menu
        open={menuOpen}
        items={menuEntries}
        selectedId={mode}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'details') {
            // Opening this session's Routing view changes no routing state,
            // so a locked composer or a gesture in flight leaves it available.
            if (reveal !== undefined) reveal({ view: 'routing', target: { kind: 'none' } })
            return
          }
          if (id === 'off') {
            run('mode', () => setRouting(false))
            return
          }
          requestJudged(id === 'shadow' ? 'shadow' : 'on')
        }}
        onClose={() => { setMenuOpen(false) }}
        anchor={(
          <button
            type="button"
            className={css.details}
            aria-label={t('chip.menu')}
            title={t('chip.menu')}
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen(open => !open) }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        )}
      />
      {idle && (
        // The visible copy is short and truncates in a narrow composer; the full
        // sentence stays in the tooltip and the accessible description.
        <>
          <span
            className={css.idle}
            title={t(reason === 'base-unlisted' ? 'idle.unlisted.title' : 'idle.warning.title')}
            aria-describedby={idleDescriptionId}
          >
            {t(reason === 'base-unlisted' ? 'idle.unlisted' : 'idle.warning')}
          </span>
          <span id={idleDescriptionId} className={css.visuallyHidden}>
            {t(reason === 'base-unlisted' ? 'idle.unlisted.title' : 'idle.warning.title')}
          </span>
        </>
      )}
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
          title={confirmMode === 'shadow' ? t('confirm.shadowTitle') : t('confirm.title')}
          description={t('confirm.body')}
          closeLabel={t('confirm.close')}
          footer={(
            <span className={css.confirmActions}>
              {openSettings !== undefined && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirm(null)
                    run('settings', async () => {
                      await openSettings()
                      return null
                    })
                  }}
                >
                  {t('confirm.openSettings')}
                </Button>
              )}
              <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('confirm.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirm(null)
                  run('mode', () => setRouting(confirmMode === 'shadow' ? 'shadow' : true))
                }}
              >
                {confirmMode === 'shadow' ? t('confirm.shadowConfirm') : t('confirm.turnOn')}
              </Button>
            </span>
          )}
        >
          <p className={css.confirmWarning}>{confirmWarning(confirm, confirmGate, t)}</p>
          {/* Without a way to open Settings, the confirm names where the judge is changed. */}
          {openSettings === undefined && <p className={css.confirmSettings}>{t('confirm.settings')}</p>}
        </Modal>
      )}
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {failure !== null && (
        <>
          <span
            className={css.error}
            role="status"
            title={`${FAILURE_LABEL[failure.action]}: ${failure.detail}`}
            aria-describedby={failureDescriptionId}
          >
            {FAILURE_LABEL[failure.action]}
          </span>
          <span id={failureDescriptionId} className={css.visuallyHidden}>{failure.detail}</span>
        </>
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
  judge: ConfirmedJudge,
  gate: ModelRoutingGateView | null,
  t: RoutingChipProps['t'],
): string {
  if (judge.kind === 'none') return t('confirm.unregistered')
  if (judge.kind !== 'engine') return t('confirm.unknown')
  if (judgeRefused(judge, gate) === true) return t('confirm.refused')
  const destination = judge.engine.destination ?? judge.engine.label
  return gate === null
    ? t('confirm.warning', { destination })
    : t('confirm.warning.chars', { destination, chars: gate.stateMaxChars.toLocaleString('en-US') })
}

/** A judge whose turn-on asks first: a remote engine, or one not known yet. */
type ConfirmedJudge =
  | Extract<RoutingJudge, { kind: 'engine' | 'loading' | 'failed' }>
  | { readonly kind: 'none'; readonly reason: 'unregistered' }

/**
 * Whether turning routing on asks first for this judge.
 * @param judge - the router's judge.
 * @returns true for a remote engine, a judge not known yet, or an id no engine registers.
 */
function confirms(judge: RoutingJudge): judge is ConfirmedJudge {
  switch (judge.kind) {
    case 'loading':
    case 'failed': return true
    case 'none': return judge.reason === 'unregistered'
    case 'engine': return judge.engine.egress === 'remote'
  }
}
