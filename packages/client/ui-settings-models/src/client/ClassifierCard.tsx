/**
 * The Classifier card of the Models section: the deployment switch for the
 * judgment seam (`judgment.enabled`).
 *
 * A judgment engine is a role-bound model rather than a conversation model,
 * so this card states what off means instead of presenting the engine as a
 * provider: with the switch off, every consumer treats the engine as exactly
 * absent — routing keeps the strong route, and compaction runs its basic
 * path. The section's schema carries the switch alone; the engine itself is
 * bound by the deployment composition, so the card names no engine model.
 *
 * The write is one `settings.mutate` path op carrying the section revision,
 * like every other control on this page: a concurrent edit is refused rather
 * than overwritten, and a rejection shows inline with the switch unmoved.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { getPath } from '@shres-code/shres-code-client-schema-form'
import { messageOf } from './store.ts'
import type { ModelsSettingsState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace the judgment seam registers. */
const JUDGMENT_NS = 'judgment'

/**
 * Whether the judgment engine is on in this section's resolved value. An
 * omitted field is on: the seam composes `enabled: true`.
 * @param namespace - the resolved `judgment` settings view.
 * @returns false only when the section stores an explicit false.
 */
export function judgmentEnabled(namespace: SettingsNamespaceView): boolean {
  return getPath(namespace.value, ['enabled']) !== false
}

/**
 * Write the deployment switch as one path op carrying the revision the
 * rendered section was read at.
 * @param api - settings wire face.
 * @param enabled - next switch value.
 * @param expectedRevision - revision of the section this write was drafted over.
 * @returns the failure text, or undefined when the write committed.
 */
export async function writeJudgmentEnabled(
  api: Pick<IApiClient, 'settings'>,
  enabled: boolean,
  expectedRevision: number,
): Promise<string | undefined> {
  try {
    const response = await api.settings.mutate({
      ns: JUDGMENT_NS,
      ops: [{ op: 'set', path: ['enabled'], value: enabled }],
      expectedRevision,
    })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    // The transport rejected rather than answering; the caller retries the
    // idempotent write instead of the switch silently staying put.
    return messageOf(error)
  }
  return undefined
}

/** Props for {@link ClassifierCard}. */
export interface ClassifierCardProps {
  /** Joined Models snapshot, carrying the resolved `judgment` section. */
  state: ModelsSettingsState
  /** Settings wire face. */
  api: Pick<IApiClient, 'settings'>
  /** Reload the page snapshot after a write. */
  reload: () => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Render the Classifier card when the Host exposes `judgment`.
 * @param props - snapshot, settings wire, reload, and copy.
 * @returns the card, or null when the namespace is not exposed.
 */
export function ClassifierCard({ state, api, reload, t }: ClassifierCardProps): ReactNode {
  const namespace = state.namespaces.get(JUDGMENT_NS)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  if (namespace === undefined) return null

  const enabled = judgmentEnabled(namespace)
  const toggle = (next: boolean): void => {
    setBusy(true)
    setFailure(undefined)
    void writeJudgmentEnabled(api, next, namespace.revision).then((error) => {
      setBusy(false)
      if (error !== undefined) {
        setFailure(error)
        return
      }
      reload()
    })
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('classifierTitle')}</span>
      </div>
      <p className={styles['advancedHint']}>{t('classifierIntro')}</p>
      <div className={styles['rowHead']}>
        <span className={styles['fieldLabel']}>{t('classifierSwitchLabel')}</span>
        <span className={styles['rowActions']}>
          <span className={styles['fieldLabel']}>
            {enabled ? t('classifierOn') : t('classifierOff')}
          </span>
          <button
            type="button"
            className={`${styles['rowSwitch']} ${enabled ? styles['rowSwitchOn'] : styles['rowSwitchOff']}`}
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? t('classifierDisable') : t('classifierEnable')}
            disabled={!state.writable || busy}
            onClick={() => { toggle(!enabled) }}
          >
            <span className={styles['rowSwitchThumb']} />
          </button>
        </span>
      </div>
      <p className={styles['advancedHint']}>{t('classifierOffMeans')}</p>
      <p className={styles['advancedHint']}>{t('classifierBinding')}</p>
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
    </div>
  )
}
