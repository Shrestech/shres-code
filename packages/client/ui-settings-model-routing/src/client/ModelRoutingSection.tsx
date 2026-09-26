/**
 * Settings › Model routing: the global routing configuration page. It holds
 * the deployment-wide judgment engine, the routing mode new sessions start in,
 * the classifier switch, the shared candidate pool with the Route from
 * allowlist, and the read-only thresholds; per-session routing stays with each
 * session's Auto chip.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type { ModelRoutingController, ModelRoutingState } from './model.ts'
import { EngineCard } from './EngineCard.tsx'
import { ClassifierCard, DefaultModeCard } from './ConfigCards.tsx'
import { PoolEditor } from './PoolEditor.tsx'
import { ThresholdsCard } from './ThresholdsCard.tsx'
import css from './ModelRoutingSection.module.css'

/** Injected dependencies of {@link ModelRoutingSection} (slot `inject`). */
export interface ModelRoutingSectionInjected {
  /** The page controller (read on mount, refreshed on pushed invalidations). */
  controller: ModelRoutingController
  /** The page snapshot; the slot renderer binds this as `useSnapshot`. */
  hooks: {
    snapshot: SnapshotStore<ModelRoutingState>
  }
}

/** Full component props assembled by the Settings slot renderer. */
export type ModelRoutingSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.modelRouting'>
  & InjectFace<ModelRoutingSectionInjected>

/** Render the page from the controller's snapshot. */
export function ModelRoutingSection({ controller, useSnapshot, t }: ModelRoutingSectionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  useEffect(() => {
    void controller.load()
  }, [controller])

  return (
    <section className={css['section']} aria-label={t('title')}>
      <header className={css['header']}>
        <span className={css['scopePill']}>{t('scope')}</span>
        <p className={css['intro']}>{t('intro')}</p>
      </header>
      {state.engines === null && state.status !== 'error'
        ? <p className={css['muted']} role="status">{t('loading')}</p>
        : null}
      {state.status === 'error' && state.error !== null
        ? (
          <div className={css['warning']} role="alert">
            <span>{t('loadFailed', { message: state.error })}</span>
            {' '}
            <button type="button" className={css['button']} onClick={() => { void controller.load() }}>{t('retry')}</button>
          </div>
        )
        : null}
      {state.status === 'ready' && !state.writable ? <p className={css['muted']}>{t('readOnly')}</p> : null}
      <EngineCard state={state} controller={controller} t={t} />
      {state.router === null && state.judgment === null
        ? null
        : (
          <div className={css['pair']}>
            {state.router === null
              ? null
              : <DefaultModeCard section={state.router} writable={state.writable} controller={controller} t={t} />}
            {state.judgment === null
              ? null
              : <ClassifierCard section={state.judgment} writable={state.writable} controller={controller} t={t} />}
          </div>
        )}
      {state.routingError === null ? null : <p className={css['fieldError']} role="alert">{t('poolLoadFailed', { message: state.routingError })}</p>}
      <PoolEditor state={state} controller={controller} t={t} />
      <ThresholdsCard state={state} t={t} />
    </section>
  )
}
