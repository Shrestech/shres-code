/** J-Space settings section: allow switch over the `jspace` namespace, plus Advisor and LLM Wiki. */

import { useEffect, useState, type ReactNode } from 'react'
import type { IApiClient, ModelProviderGroup } from '@shres-code/shres-code-api-remotes/client'
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
  /** Refuse a checkpoint whose `by` names no coverage term. Default true. */
  requireCoverage?: boolean
}

/** Stored advisor settings the Host advisor plugin registers. */
export interface AdvisorSettings {
  /** Master allow. Default false. */
  enabled?: boolean
  /** LLM route provider the reviewer runs on. */
  provider?: string
  /** Model id on that route. */
  model?: string
}

/** Stored wiki settings the Host wiki seat registers. */
export interface WikiSettings {
  /** Master allow. Default true. */
  enabled?: boolean
  /** Per-role bindings; an omitted librarian stays dormant. */
  roles?: {
    librarian?: {
      provider?: string
      model?: string
    }
  }
}

const MODES = ['available', 'always-open'] as const

/** Injected face for {@link JSpaceSection}. */
export interface JSpaceSectionInjected {
  /** Bound `jspace` settings scope. */
  scope: SettingsScope<JSpaceSettings>
  /** Settings snapshot hook bound by the renderer. */
  useSnapshot: <T>(select: (snapshot: SettingsScopeSnapshot<JSpaceSettings>) => T) => T
  /** Bound `wiki` settings scope. */
  wikiScope: SettingsScope<WikiSettings>
  /** Wiki settings snapshot hook bound by the renderer. */
  useWikiSnapshot: <T>(select: (snapshot: SettingsScopeSnapshot<WikiSettings>) => T) => T
  /** Bound `jspace-advisor` settings scope. */
  advisorScope: SettingsScope<AdvisorSettings>
  /** Advisor settings snapshot hook bound by the renderer. */
  useAdvisorSnapshot: <T>(select: (snapshot: SettingsScopeSnapshot<AdvisorSettings>) => T) => T
  /** Last-known card view from the selected session projection. */
  useCard: <T>(select: (view: JSpaceCardView | undefined) => T) => T
  /** Wire face for wiki librarian binding and live model catalog. */
  api: Pick<IApiClient, 'settings' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Full component props. */
export type JSpaceSectionProps =
  PropsRuntime<'settings.section'> & JSpaceSectionInjected

/**
 * Bind or clear the wiki librarian role. Both fields must be set for dispatch.
 * @param api - settings wire face.
 * @param next - next binding, or undefined to unbind.
 * @returns fulfillment after the mutate settles.
 */
/**
 * Bind or clear the advisor LLM route. Turning the provider off unsets both fields.
 * @param api - settings wire face.
 * @param next - next binding, or undefined to unbind.
 * @returns fulfillment after the mutate settles.
 */
export async function writeAdvisorRoute(
  api: Pick<IApiClient, 'settings'>,
  next: { provider?: string; model?: string } | undefined,
): Promise<void> {
  await api.settings.mutate({
    ns: 'jspace-advisor',
    ops: next === undefined
      ? [{ op: 'unset', path: ['provider'] }, { op: 'unset', path: ['model'] }]
      : next.model === undefined
        ? [{ op: 'set', path: ['provider'], value: next.provider }, { op: 'unset', path: ['model'] }]
        : [
          { op: 'set', path: ['provider'], value: next.provider },
          { op: 'set', path: ['model'], value: next.model },
        ],
  })
}

/**
 * Bind or clear the wiki librarian role. Both fields must be set for dispatch.
 * @param api - settings wire face.
 * @param next - next binding, or undefined to unbind.
 * @returns fulfillment after the mutate settles.
 */
export async function writeWikiLibrarian(
  api: Pick<IApiClient, 'settings'>,
  next: { provider?: string; model?: string } | undefined,
): Promise<void> {
  await api.settings.mutate({
    ns: 'wiki',
    ops: next === undefined
      ? [{ op: 'unset', path: ['roles', 'librarian'] }]
      : [{ op: 'set', path: ['roles', 'librarian'], value: next }],
  })
}

/**
 * Render the J-Space settings page.
 * @param props - scope, snapshot hooks, and copy.
 * @returns the section.
 */
export function JSpaceSection({
  scope, useSnapshot, wikiScope, useWikiSnapshot, advisorScope, useAdvisorSnapshot, useCard, api, t,
}: JSpaceSectionProps): ReactNode {
  const settings = useSnapshot(current => current)
  const wiki = useWikiSnapshot(current => current)
  const advisor = useAdvisorSnapshot(current => current)
  const card = useCard(current => current)
  const enabled = settings.value?.enabled === true
  const mode = settings.value?.mode ?? 'available'
  const requireCoverage = settings.value?.requireCoverage !== false
  const formDisabled = settings.status !== 'ready' || !settings.writable
  const showForm = settings.status === 'ready'
  const wikiEnabled = wiki.value?.enabled !== false
  const wikiReady = wiki.status === 'ready'
  const wikiDisabled = !wiki.writable
  const librarian = wiki.value?.roles?.librarian ?? {}
  const advisorReady = advisor.status === 'ready'
  const advisorDisabled = !advisor.writable
  const advisorEnabled = advisor.value?.enabled === true
  const advisorProvider = advisor.value?.provider
  const advisorModel = advisor.value?.model
  const [groups, setGroups] = useState<readonly ModelProviderGroup[]>([])

  useEffect(() => {
    if ((!wikiReady || !wikiEnabled) && (!advisorReady || !advisorEnabled)) return
    void api.llm.models({}).then((response) => {
      if (response.result.ok) setGroups(response.result.value.groups)
    })
  }, [api, wikiReady, wikiEnabled, advisorReady, advisorEnabled])

  const models = groups.find(group => group.id === librarian.provider)?.models ?? []
  const advisorModels = groups.find(group => group.id === advisorProvider)?.models ?? []

  return (
    <div className={css.section}>
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
      {advisorReady ? (
        <div className={css.wikiBlock}>
          <p className={css.intro}>{t('advisorIntro')}</p>
          <div className={css.toggleCard}>
            <div className={css.toggleCopy}>
              <span className={css.toggleName}>{t('advisorTitle')}</span>
              <span className={css.toggleState}>{advisorEnabled ? t('advisorActive') : t('advisorInactive')}</span>
            </div>
            <button
              type="button"
              className={advisorEnabled ? css.switchOn : css.switchOff}
              role="switch"
              aria-checked={advisorEnabled}
              aria-label={advisorEnabled ? t('advisorDisable') : t('advisorActivate')}
              disabled={advisorDisabled}
              onClick={() => { void advisorScope.set('enabled', !advisorEnabled) }}
            >
              <span className={css.switchThumb} />
            </button>
          </div>
          <p className={css.hint}>{t('advisorToggleHint')}</p>
          {advisorEnabled ? (
            <>
              <p className={css.hint}>{t('advisorModelHint')}</p>
              <div className={css.wikiFields}>
                <label className={css.field}>
                  <span className={css.label}>{t('advisorProvider')}</span>
                  <select
                    className={css.select}
                    value={advisorProvider ?? ''}
                    aria-label={`${t('advisorTitle')} ${t('advisorProvider')}`}
                    disabled={advisorDisabled}
                    onChange={(event) => {
                      const provider = event.target.value
                      void writeAdvisorRoute(
                        api,
                        provider === '' ? undefined : { provider },
                      )
                    }}
                  >
                    <option value="">{t('advisorUnbound')}</option>
                    {groups.map(group => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.label}>{t('advisorModel')}</span>
                  <select
                    className={css.select}
                    value={advisorModel ?? ''}
                    aria-label={`${t('advisorTitle')} ${t('advisorModel')}`}
                    disabled={advisorDisabled || advisorProvider === undefined}
                    onChange={(event) => {
                      const model = event.target.value
                      /* v8 ignore next -- the model select is disabled until a provider is chosen */
                      if (advisorProvider === undefined) return
                      void writeAdvisorRoute(
                        api,
                        model === ''
                          ? { provider: advisorProvider }
                          : { provider: advisorProvider, model },
                      )
                    }}
                  >
                    <option value="">{t('advisorUnbound')}</option>
                    {advisorModels.map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                    {advisorModel !== undefined
                      && advisorModel.length > 0
                      && !advisorModels.some(model => model.id === advisorModel)
                      ? <option value={advisorModel}>{advisorModel}</option>
                      : null}
                  </select>
                </label>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {wikiReady ? (
        <div className={css.wikiBlock}>
          <p className={css.intro}>{t('wikiIntro')}</p>
          <div className={css.toggleCard}>
            <div className={css.toggleCopy}>
              <span className={css.toggleName}>{t('wikiTitle')}</span>
              <span className={css.toggleState}>{wikiEnabled ? t('wikiActive') : t('wikiInactive')}</span>
            </div>
            <button
              type="button"
              className={wikiEnabled ? css.switchOn : css.switchOff}
              role="switch"
              aria-checked={wikiEnabled}
              aria-label={wikiEnabled ? t('wikiDisable') : t('wikiActivate')}
              disabled={wikiDisabled}
              onClick={() => { void wikiScope.set('enabled', !wikiEnabled) }}
            >
              <span className={css.switchThumb} />
            </button>
          </div>
          <p className={css.hint}>{t('wikiToggleHint')}</p>
          {wikiEnabled ? (
            <>
              <p className={css.hint}>{t('wikiModelHint')}</p>
              <div className={css.wikiFields}>
                <label className={css.field}>
                  <span className={css.label}>{t('wikiProvider')}</span>
                  <select
                    className={css.select}
                    value={librarian.provider ?? ''}
                    aria-label={`${t('wikiLibrarian')} ${t('wikiProvider')}`}
                    disabled={wikiDisabled}
                    onChange={(event) => {
                      const provider = event.target.value
                      void writeWikiLibrarian(
                        api,
                        provider === '' ? undefined : { provider },
                      )
                    }}
                  >
                    <option value="">{t('wikiUnbound')}</option>
                    {groups.map(group => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.label}>{t('wikiModel')}</span>
                  <select
                    className={css.select}
                    value={librarian.model ?? ''}
                    aria-label={`${t('wikiLibrarian')} ${t('wikiModel')}`}
                    disabled={wikiDisabled || librarian.provider === undefined}
                    onChange={(event) => {
                      const model = event.target.value
                      /* v8 ignore next -- the model select is disabled until a provider is chosen */
                      if (librarian.provider === undefined) return
                      void writeWikiLibrarian(
                        api,
                        model === ''
                          ? { provider: librarian.provider }
                          : { provider: librarian.provider, model },
                      )
                    }}
                  >
                    <option value="">{t('wikiUnbound')}</option>
                    {models.map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                    {librarian.model !== undefined
                      && librarian.model.length > 0
                      && !models.some(model => model.id === librarian.model)
                      ? <option value={librarian.model}>{librarian.model}</option>
                      : null}
                  </select>
                </label>
              </div>
            </>
          ) : null}
        </div>
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
