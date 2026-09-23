/** Voice & audio settings section: speech engines, cloud audio, and voice rows. */

import { useState, type ReactNode } from 'react'
import type { IApiClient } from '@shres-code/shres-code-api-remotes/client'
import type { SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { SpeechAudioCard } from './SpeechAudioCard.tsx'
import type { SpeechStatusFace } from './SpeechAudioCard.tsx'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies shared with the Models settings controller. */
export interface AudioSectionInjected {
  /** The provider/settings join shared by all settings sections in this plugin. */
  controller: ModelsSettingsStore
  /** The shared snapshot; the slot renderer binds this as `useSnapshot`. */
  hooks: {
    snapshot: SnapshotStore<ModelsSettingsState>
  }
  /** Settings, credential, and model-discovery wire faces. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Speech status Remote, when the speech plugin is composed. */
  speech?: SpeechStatusFace
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props, child audio rows, and the section's injected business face. */
export type AudioSectionProps =
  PropsRuntime<'settings.section'>
  & PropsRenderSlots<'settings.audio.item'>
  & InjectFace<AudioSectionInjected>

/**
 * Render the Voice & audio section over the shared Models settings snapshot.
 * @param props - shell owner props, child-row renderer, and shared dependencies.
 * @returns the section, including an unavailable message when the speech seam is absent.
 */
export function AudioSection({
  controller, useSnapshot, api, speech, t, renderSlot,
}: AudioSectionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState(false)
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
  const namespace = state.namespaces.get('speech')
  // The section can be present in a profile without the speech Host seam.
  // Keep the destination explicit instead of rendering a blank page.
  if (namespace === undefined) {
    return (
      <div className={styles['section']}>
        <p className={styles['emptyState']} role="status">{t('audioUnavailable')}</p>
      </div>
    )
  }
  return (
    <div className={styles['section']}>
      <p className={styles['intro']}>{t('audioIntro')}</p>
      {saved
        ? <p className={styles['savedNotice']} role="status" aria-live="polite">{t('speechSaved')}</p>
        : null}
      {!state.writable ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {open
        ? (
          <SpeechAudioCard
            api={api}
            speech={speech}
            namespace={namespace}
            t={t}
            readOnly={!state.writable}
            onChanged={() => { void controller.load() }}
            onSaved={() => { setSaved(true) }}
            onClose={() => { setOpen(false) }}
          />
        )
        : (
          <div className={styles['rowCard']}>
            <div className={styles['rowHead']}>
              <span className={styles['rowIdentity']}>
                <span className={styles['rowName']}>{t('audioTitle')}</span>
              </span>
              <button
                type="button"
                className={styles['secondaryButton']}
                aria-label={t('audioTitle')}
                onClick={() => { setSaved(false); setOpen(true) }}
              >
                {t('edit')}
              </button>
            </div>
          </div>
        )}
      <div className={styles['audioItems']}>
        {renderSlot('settings.audio.item', {})}
      </div>
    </div>
  )
}
