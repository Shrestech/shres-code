/** Team settings section: the shared roster and its provider bindings. */

import type { ReactNode } from 'react'
import type { IApiClient } from '@shres-code/shres-code-api-remotes/client'
import type { SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { TeamCard } from './TeamCard.tsx'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies shared with the Models settings controller. */
export interface TeamSectionInjected {
  /** The provider/settings join shared by all settings sections in this plugin. */
  controller: ModelsSettingsStore
  /** The shared snapshot; the slot renderer binds this as `useSnapshot`. */
  hooks: {
    snapshot: SnapshotStore<ModelsSettingsState>
  }
  /** Settings and model-catalog wire faces used by the roster. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the Team section's injected business face. */
export type TeamSectionProps = PropsRuntime<'settings.section'> & InjectFace<TeamSectionInjected>

/**
 * Render the Team members section over the shared Models settings snapshot.
 * @param props - shell owner props and shared settings dependencies.
 * @returns the section, including an unavailable message when the roster seam is absent.
 */
export function TeamSection({ controller, useSnapshot, api, t }: TeamSectionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }
  if (state.status !== 'ready') {
    return (
      <div className={styles['section']}>
        <p className={styles['intro']}>{t('loading')}</p>
      </div>
    )
  }
  // The Host may compose the provider settings without the agent-seats
  // namespace. Keep the destination explicit in that profile instead of
  // leaving a blank page behind the global Teams navigation.
  if (!state.namespaces.has('agent-seats')) {
    return (
      <div className={styles['section']}>
        <p className={styles['emptyState']} role="status">{t('teamsUnavailable')}</p>
      </div>
    )
  }
  return (
    <div className={styles['section']}>
      <p className={styles['intro']}>{t('teamsIntro')}</p>
      {!state.writable ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      <TeamCard
        state={state}
        api={api}
        reload={() => { void controller.load() }}
        t={t}
      />
    </div>
  )
}
