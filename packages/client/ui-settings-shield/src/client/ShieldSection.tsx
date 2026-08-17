/** Shield settings section: posture and license over the `shres-shield` namespace. */

import { useEffect, useState, type ReactNode } from 'react'
import type { ShieldFindingSummary, ShieldSnapshot } from '@shres-code/shres-code-api-remotes/client'
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
  /** Read-only per-repo console payload. Not a settings field. */
  loadSnapshot: () => Promise<ShieldSnapshot>
}

/** Full component props. */
export type ShieldSectionProps =
  PropsRuntime<'settings.section'> & ShieldSectionInjected

type ConsoleState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ShieldSnapshot }

function verdictLabel(
  verdict: ShieldFindingSummary['verdict'],
  t: ShieldSectionInjected['t'],
): string {
  if (verdict === 'deny') return t('verdictBlocked')
  if (verdict === 'ask') return t('verdictAsked')
  return t('verdictObserved')
}

function formatFinding(
  item: ShieldFindingSummary,
  t: ShieldSectionInjected['t'],
): string {
  const parts = [verdictLabel(item.verdict, t), item.channel, item.rule]
  if (item.host !== undefined) parts.push(item.host)
  parts.push(new Date(item.at).toISOString())
  return parts.join(' · ')
}

function definitionsStamp(snapshot: ShieldSnapshot): string {
  const definitions = snapshot.definitions
  if (definitions === undefined || definitions.updatedAt === null) return '—'
  return `${definitions.version} · ${new Date(definitions.updatedAt).toISOString()}`
}

/**
 * Render the Shield settings page.
 * @param props - scope, snapshot hook, copy, and console loader.
 * @returns the section.
 */
export function ShieldSection({
  scope, useSnapshot, t, loadSnapshot,
}: ShieldSectionProps): ReactNode {
  const settings = useSnapshot(current => current)
  const [licenseDraft, setLicenseDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [request, setRequest] = useState(0)
  const [consoleState, setConsoleState] = useState<ConsoleState>({ status: 'loading' })
  const posture = settings.value?.posture ?? 'ask'
  const enabled = settings.value?.enabled !== false
  const licenseStored = typeof settings.value?.license === 'string' && settings.value.license.length > 0

  useEffect(() => {
    let current = true
    setConsoleState({ status: 'loading' })
    void Promise.resolve().then(() => loadSnapshot()).then(
      (snapshot) => { if (current) setConsoleState({ status: 'ready', snapshot }) },
      () => { if (current) setConsoleState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [loadSnapshot, request])

  const bothMissing = settings.status === 'unavailable' && consoleState.status === 'error'
  const formDisabled = settings.status !== 'ready' || !settings.writable || saving
  const showForm = settings.status === 'ready'

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      {bothMissing ? <p className={css.notice} role="status">{t('unavailable')}</p> : (
        <>
          {settings.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
          {settings.status === 'unavailable' ? <p className={css.notice} role="status">{t('unavailable')}</p> : null}
          {showForm ? (
            <>
              <p className={css.intro}>{t('intro')}</p>
              {!settings.writable ? <p className={css.notice} role="status">{t('readOnly')}</p> : null}
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
                  disabled={formDisabled}
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
                  disabled={formDisabled}
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
                  disabled={formDisabled}
                  aria-label={t('license')}
                  onChange={(event) => { setLicenseDraft(event.target.value) }}
                />
                <span className={css.hint}>{t('licenseHint')}</span>
              </label>
              <div className={css.actions}>
                <button
                  type="button"
                  className={css.apply}
                  disabled={formDisabled || licenseDraft.trim().length === 0}
                  onClick={() => {
                    const next = licenseDraft.trim()
                    /* v8 ignore next -- the button is disabled while the draft trims empty */
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
            </>
          ) : null}
          <section
            className={css.console}
            aria-label={t('console')}
            aria-busy={consoleState.status === 'loading'}
          >
            {consoleState.status === 'loading' ? (
              <p className={css.status}>{t('snapshotLoading')}</p>
            ) : null}
            {consoleState.status === 'error' ? (
              <div className={css.consoleFailure}>
                <p role="alert">{t('snapshotUnavailable')}</p>
                <button
                  type="button"
                  className={css.retry}
                  onClick={() => { setRequest(value => value + 1) }}
                >
                  {t('retry')}
                </button>
              </div>
            ) : null}
            {consoleState.status === 'ready' ? (
              <>
                <p className={css.repoPath}>
                  {t('console')}
                  {' · '}
                  {consoleState.snapshot.stats.cwd ?? '—'}
                </p>
                <dl className={css.counters}>
                  <div>
                    <dt>{t('screened')}</dt>
                    <dd>{consoleState.snapshot.stats.screened}</dd>
                  </div>
                  <div>
                    <dt>{t('asked')}</dt>
                    <dd>{consoleState.snapshot.stats.asked}</dd>
                  </div>
                  <div>
                    <dt>{t('blocked')}</dt>
                    <dd>{consoleState.snapshot.stats.blocked}</dd>
                  </div>
                  <div>
                    <dt>{t('observed')}</dt>
                    <dd>{consoleState.snapshot.stats.observed}</dd>
                  </div>
                </dl>
                <p className={css.definitions}>
                  {t('definitions')}
                  {' · '}
                  {definitionsStamp(consoleState.snapshot)}
                </p>
                <div className={css.recent}>
                  <h3 className={css.recentTitle}>{t('recent')}</h3>
                  {consoleState.snapshot.stats.recent.length === 0 ? (
                    <p className={css.status}>{t('noFindings')}</p>
                  ) : (
                    <ul className={css.findings}>
                      {consoleState.snapshot.stats.recent.map(item => (
                        <li key={`${item.at}:${item.sha16}:${item.rule}`}>
                          {formatFinding(item, t)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : null}
          </section>
        </>
      )}
    </div>
  )
}
