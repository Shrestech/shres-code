/** Shield settings section: posture and license over the `shres-shield` namespace. */

import { useState, type ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import type { PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import { FishLogo } from '@shres-code/shres-code-client-ui-primitives'
import type { en } from './locales.ts'
import { publishShieldMark } from './mark.ts'
import css from './ShieldSection.module.css'

/** Stored Shield settings the Host seat registers. */
export interface ShieldSettings {
  /** Customer entitlement string. */
  license?: string
  /** User activate/disable switch. Default true. */
  enabled?: boolean
  /** Screening posture forwarded to the paid plugin. */
  posture?: 'observe' | 'ask' | 'enforce'
}

const POSTURES = ['observe', 'ask', 'enforce'] as const

/** Injected face for {@link ShieldSection}. */
export interface ShieldSectionInjected {
  /** Bound `shres-shield` settings scope. */
  scope: SettingsScope<ShieldSettings>
  /** Snapshot hook bound by the renderer. */
  useSnapshot: <T>(select: (snapshot: SettingsScopeSnapshot<ShieldSettings>) => T) => T
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Full component props. */
export type ShieldSectionProps =
  PropsRuntime<'settings.section'> & ShieldSectionInjected

/**
 * Render the Shield settings page.
 * @param props - scope, snapshot hook, and copy.
 * @returns the section.
 */
export function ShieldSection({ scope, useSnapshot, t }: ShieldSectionProps): ReactNode {
  const snapshot = useSnapshot(current => current)
  const [licenseDraft, setLicenseDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const posture = snapshot.value?.posture ?? 'ask'
  const enabled = snapshot.value?.enabled !== false
  const licenseStored = typeof snapshot.value?.license === 'string' && snapshot.value.license.length > 0

  if (snapshot.status === 'unavailable') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.notice} role="status">{t('unavailable')}</p>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.status}>{t('loading')}</p>
      </div>
    )
  }

  const disabled = !snapshot.writable || saving
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {!snapshot.writable ? <p className={css.notice} role="status">{t('readOnly')}</p> : null}
      <div className={css.toggleCard}>
        <FishLogo size={40} shieldActive={enabled} />
        <div className={css.toggleCopy}>
          <span className={css.toggleName}>{t('title')}</span>
          <span className={css.toggleState}>{enabled ? t('active') : t('inactive')}</span>
        </div>
        <button
          type="button"
          className={enabled ? css.switchOn : css.switchOff}
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? t('disable') : t('activate')}
          disabled={disabled}
          onClick={() => {
            const next = !enabled
            publishShieldMark(next)
            void scope.set('enabled', next)
          }}
        >
          <span className={css.switchThumb} />
        </button>
      </div>
      <p className={css.hint}>{t('toggleHint')}</p>
      <label className={css.field}>
        <span className={css.label}>{t('posture')}</span>
        <select
          className={css.select}
          value={posture}
          disabled={disabled}
          aria-label={t('posture')}
          onChange={(event) => {
            const next = event.target.value
            if (POSTURES.includes(next as typeof POSTURES[number])) {
              void scope.set('posture', next)
            }
          }}
        >
          <option value="observe">{t('postureObserve')}</option>
          <option value="ask">{t('postureAsk')}</option>
          <option value="enforce">{t('postureEnforce')}</option>
        </select>
        <span className={css.hint}>{t('postureHint')}</span>
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('license')}</span>
        <input
          className={css.input}
          type="password"
          autoComplete="off"
          value={licenseDraft}
          placeholder={licenseStored ? t('licenseStored') : t('licensePlaceholder')}
          disabled={disabled}
          aria-label={t('license')}
          onChange={(event) => { setLicenseDraft(event.target.value) }}
        />
        <span className={css.hint}>{t('licenseHint')}</span>
      </label>
      <div className={css.actions}>
        <button
          type="button"
          className={css.apply}
          disabled={disabled || licenseDraft.trim().length === 0}
          onClick={() => {
            const next = licenseDraft.trim()
            if (next.length === 0) return
            setSaving(true)
            void scope.set('license', next).finally(() => {
              setLicenseDraft('')
              setSaving(false)
            })
          }}
        >
          {saving ? t('applying') : t('apply')}
        </button>
      </div>
      <p className={css.notice}>{t('panic')}</p>
    </div>
  )
}
