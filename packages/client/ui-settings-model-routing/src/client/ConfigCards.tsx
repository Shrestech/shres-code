/**
 * The configuration cards below the engine card: the routing mode new
 * sessions start in and the classifier switch.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import clsx from 'clsx'
import type { ModelRoutingController, WriteFailure } from './model.ts'
import { classifierEnabled, initialMode } from './view.ts'
import type { Translate } from './view.ts'
import css from './ModelRoutingSection.module.css'

/**
 * Run one write, tracking its busy state and failure text.
 * @returns the busy flag, the failure, and the runner.
 */
function useWrite(): { busy: boolean; failure: WriteFailure | undefined; run: (write: () => Promise<WriteFailure | undefined>) => void } {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WriteFailure | undefined>(undefined)
  return {
    busy,
    failure,
    run: (write) => {
      setBusy(true)
      setFailure(undefined)
      void write().then((result) => {
        setBusy(false)
        setFailure(result)
      })
    },
  }
}

/** Props shared by the writable cards. */
interface WritableCardProps {
  section: SettingsNamespaceView
  writable: boolean
  controller: ModelRoutingController
  t: Translate
}

/** The Off / Shadow / On mode new sessions start in (`model-router.initialMode`). */
export function DefaultModeCard({ section, writable, controller, t }: WritableCardProps): ReactNode {
  const { busy, failure, run } = useWrite()
  const mode = initialMode(section)
  return (
    <section className={css['card']} aria-label={t('modeTitle')}>
      <h3 className={css['cardTitle']}>{t('modeTitle')}</h3>
      <p className={css['sub']}>{t('modeIntro')}</p>
      <div className={css['segmented']} role="radiogroup" aria-label={t('modeGroup')}>
        {(['off', 'shadow', 'on'] as const).map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={mode === option}
            className={clsx(css['segment'], mode === option && css['segmentOn'])}
            disabled={busy || !writable}
            onClick={() => {
              if (option !== mode) run(() => controller.setDefaultMode(option))
            }}
          >
            {option === 'off' ? t('modeOff') : option === 'shadow' ? t('modeShadow') : t('modeOn')}
          </button>
        ))}
      </div>
      {mode === 'shadow' ? <p className={css['sub']}>{t('modeShadowHint')}</p> : null}
      {failure === undefined ? null : <p className={css['fieldError']} role="alert">{failure.message}</p>}
    </section>
  )
}

/** The classifier switch (`judgment.enabled`), moved here from the Models page. */
export function ClassifierCard({ section, writable, controller, t }: WritableCardProps): ReactNode {
  const { busy, failure, run } = useWrite()
  const enabled = classifierEnabled(section)
  return (
    <section className={css['card']} aria-label={t('classifierTitle')}>
      <h3 className={css['cardTitle']}>{t('classifierTitle')}</h3>
      <p className={css['sub']}>{t('classifierIntro')}</p>
      <div className={css['switchRow']}>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t(enabled ? 'classifierDisable' : 'classifierEnable')}
          className={clsx(css['switch'], enabled && css['switchOn'])}
          disabled={busy || !writable}
          onClick={() => { run(() => controller.setClassifier(!enabled)) }}
        >
          <span className={css['switchThumb']} />
        </button>
        <span>{t(enabled ? 'classifierOn' : 'classifierOff')}</span>
      </div>
      {enabled ? null : <p className={css['sub']}>{t('classifierOffMeans')}</p>}
      {failure === undefined ? null : <p className={css['fieldError']} role="alert">{failure.message}</p>}
    </section>
  )
}
