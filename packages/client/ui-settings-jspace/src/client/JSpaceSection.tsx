/** J-Space settings section: allow switch over the `jspace` namespace. */

import type { ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import type { PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type { JSpaceCardView } from './card-source.ts'
import type { en } from './locales.ts'
import css from './JSpaceSection.module.css'

/** Stored J-Space settings the Host seat registers. */
export interface JSpaceSettings {
  /** Master allow. Default false. */
  enabled?: boolean
  /** `available` waits for open; `always-open` opens on the first pre-step. */
  mode?: 'available' | 'always-open'
  /** Require a coverage term and successful evidence call. Default true. */
  requireCoverage?: boolean
}

const MODES = ['available', 'always-open'] as const

/** Injected face for {@link JSpaceSection}. */
export interface JSpaceSectionInjected {
  /** Bound `jspace` settings scope. */
  scope: SettingsScope<JSpaceSettings>
  /** Settings snapshot hook bound by the renderer. */
  useSnapshot: <T>(select: (snapshot: SettingsScopeSnapshot<JSpaceSettings>) => T) => T
  /** Last-known card view from the selected session projection. */
  useCard: <T>(select: (view: JSpaceCardView | undefined) => T) => T
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Full component props. */
export type JSpaceSectionProps =
  PropsRuntime<'settings.section'> & JSpaceSectionInjected

/**
 * Render the J-Space settings page.
 * @param props - scope, snapshot hooks, and copy.
 * @returns the section.
 */
export function JSpaceSection({
  scope, useSnapshot, useCard, t,
}: JSpaceSectionProps): ReactNode {
  const settings = useSnapshot(current => current)
  const card = useCard(current => current)
  const enabled = settings.value?.enabled === true
  const mode = settings.value?.mode ?? 'available'
  const requireCoverage = settings.value?.requireCoverage !== false
  const formDisabled = settings.status !== 'ready' || !settings.writable
  const showForm = settings.status === 'ready'

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      {settings.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {settings.status === 'unavailable' ? <p className={css.notice} role="status">{t('unavailable')}</p> : null}
      {showForm ? (
        <>
          <p className={css.intro}>{t('intro')}</p>
          {!settings.writable ? <p className={css.notice} role="status">{t('readOnly')}</p> : null}
          <div className={css.toggleCard}>
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
              disabled={formDisabled}
              onClick={() => { void scope.set('enabled', !enabled) }}
            >
              <span className={css.switchThumb} />
            </button>
          </div>
          <p className={css.hint}>{t('toggleHint')}</p>
          <label className={css.field}>
            <span className={css.label}>{t('mode')}</span>
            <select
              className={css.select}
              value={mode}
              disabled={formDisabled}
              aria-label={t('mode')}
              onChange={(event) => {
                const next = event.target.value
                if (MODES.includes(next as typeof MODES[number])) {
                  void scope.set('mode', next)
                }
              }}
            >
              <option value="available">{t('modeAvailable')}</option>
              <option value="always-open">{t('modeAlwaysOpen')}</option>
            </select>
            <span className={css.hint}>{t('modeHint')}</span>
          </label>
          <div className={css.toggleCard}>
            <div className={css.toggleCopy}>
              <span className={css.toggleName}>{t('requireCoverage')}</span>
              <span className={css.toggleState}>{t('requireCoverageHint')}</span>
            </div>
            <button
              type="button"
              className={requireCoverage ? css.switchOn : css.switchOff}
              role="switch"
              aria-checked={requireCoverage}
              aria-label={t('requireCoverage')}
              disabled={formDisabled}
              onClick={() => { void scope.set('requireCoverage', !requireCoverage) }}
            >
              <span className={css.switchThumb} />
            </button>
          </div>
        </>
      ) : null}
      <section className={css.console} aria-label={t('session')}>
        <p className={css.sessionLine}>
          {t('session')}
          {' · '}
          {card === undefined ? '—' : card.open ? t('open') : t('closed')}
        </p>
        <dl className={css.counters}>
          <div>
            <dt>{t('checked')}</dt>
            <dd>{card === undefined ? '—' : card.checked}</dd>
          </div>
        </dl>
        <p className={css.notice}>{t('coverageHonesty')}</p>
      </section>
    </div>
  )
}
