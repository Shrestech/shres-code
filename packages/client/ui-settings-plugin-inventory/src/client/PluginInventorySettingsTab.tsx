import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type {
  ManagedPlugin,
  PluginActivationOutcome,
  PluginGestureToken,
} from '@shres-code/shres-code-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '@shres-code/shres-code-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side pluginAdmin face used by the inventory and activation controls. */
export interface PluginInventorySettingsTabInjected {
  /** Read the current Loader entries and their profile-management restrictions. */
  listPlugins: () => Promise<readonly ManagedPlugin[]>
  /** Mint a one-shot grant bound to one plugin enablement change. */
  beginPlugin: (verb: 'plugin-enable' | 'plugin-disable', target: string) => Promise<{
    token: PluginGestureToken
    expiresAt: string
  }>
  /** Persist and, when possible, apply one plugin enablement change. */
  setPluginEnabled: (token: PluginGestureToken, entryId: ManagedPlugin['entryId'], enabled: boolean) => Promise<PluginActivationOutcome>
}

type PluginInventoryEntry = ManagedPlugin
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly entries: readonly ManagedPlugin[] }

type ToggleState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly entryId: ManagedPlugin['entryId']; readonly enabled: boolean }
  | { readonly status: 'notice'; readonly detail: string }
  | { readonly status: 'error'; readonly detail: string }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PluginInventorySettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^shres-(?:host-|client-)?/, '')
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Explain why a host row cannot be changed from this profile. */
function readOnlyLabel(reason: string, t: PluginInventorySettingsTabProps['t']): string {
  if (reason === 'management-required') return t('pluginReadOnlyManagement')
  if (reason === 'unaddressable') return t('pluginReadOnlyUnaddressable')
  return reason === 'unsupported' ? t('pluginActivationUnavailable') : reason
}

/** Explain the saved or refused result of one plugin enablement request. */
function outcomeDetail(outcome: PluginActivationOutcome, t: PluginInventorySettingsTabProps['t']): string {
  if (outcome.kind === 'unsupported') return t('pluginActivationUnavailable')
  if (outcome.kind === 'saved') {
    if (outcome.application === 'restart-required') return t('pluginActivationRestartRequired')
    if (outcome.application === 'overridden') return t('pluginActivationOverridden')
    return t('pluginActivationApplied')
  }
  if (outcome.code === 'management-required') return t('pluginReadOnlyManagement')
  if (outcome.code === 'unaddressable') return t('pluginReadOnlyUnaddressable')
  return outcome.detail ?? t('pluginActivationFailed')
}

/** Render the Loader inventory and profile-scoped activation controls. */
export function PluginInventorySettingsTab(props: PluginInventorySettingsTabProps): ReactNode {
  const { listPlugins, beginPlugin, setPluginEnabled, t } = props
  const catalogId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [toggle, setToggle] = useState<ToggleState>({ status: 'idle' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(listPlugins).then(
      (entries) => { if (current) setState({ status: 'ready', entries }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [listPlugins, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () => state.status === 'ready'
      ? state.entries.filter(entry => matches(entry, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )

  useEffect(() => {
    if (expanded !== null && !filteredEntries.some(entry => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, filteredEntries])

  const retry = (): void => {
    setState({ status: 'loading' })
    setToggle({ status: 'idle' })
    setRequest(value => value + 1)
  }

  const togglePlugin = (entry: ManagedPlugin): void => {
    if (entry.readOnlyReason !== undefined || toggle.status === 'working') return
    const enabled = !entry.enabled
    setToggle({ status: 'working', entryId: entry.entryId, enabled })
    void (async () => {
      try {
        const grant = await beginPlugin(enabled ? 'plugin-enable' : 'plugin-disable', entry.entryId)
        const outcome = await setPluginEnabled(grant.token, entry.entryId, enabled)
        if (outcome.kind === 'saved') {
          setToggle({ status: 'notice', detail: outcomeDetail(outcome, t) })
          setState({ status: 'loading' })
          setRequest(value => value + 1)
        } else {
          setToggle({ status: 'error', detail: outcomeDetail(outcome, t) })
        }
      } catch {
        setToggle({ status: 'error', detail: t('pluginActivationFailed') })
      }
    })()
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {toggle.status === 'notice' ? <p className={css.notice} role="status">{toggle.detail}</p> : null}
      {toggle.status === 'error' ? <p className={css.failure} role="alert">{toggle.detail}</p> : null}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.catalogHeading}>
            <h3>{t('catalog')}</h3>
            <span data-plugin-count={filteredEntries.length}>{filteredEntries.length}</span>
          </div>
          {state.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.entries.length > 0 && filteredEntries.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}
          {filteredEntries.length > 0 ? (
            <ul className={css.cards}>
              {filteredEntries.map((entry) => {
                const status = phaseLabel(entry.fiberPhase, t)
                const title = moduleShortName(entry.moduleName)
                const configuration = t(entry.enabled ? 'enabledTag' : 'disabledTag')
                const open = expanded === entry.entryId
                const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`
                const pending = toggle.status === 'working' && toggle.entryId === entry.entryId
                const toggleDisabled = pending || toggle.status === 'working' || entry.readOnlyReason !== undefined
                return (
                  <li
                    className={css.card}
                    key={entry.entryId}
                    data-plugin-entry={entry.entryId}
                    data-open={open ? 'true' : undefined}
                  >
                    <button
                      className={css.cardContent}
                      type="button"
                      aria-expanded={open}
                      aria-controls={detailId}
                      aria-label={entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`}
                      onClick={() => {
                        setExpanded(current => current === entry.entryId ? null : entry.entryId)
                      }}
                    >
                      <strong className={css.cardTitle} title={entry.moduleName}>{title}</strong>
                      <span className={css.cardTrailing}>
                        {entry.enabled ? (
                          <span
                            className={css.statusDot}
                            data-phase={entry.fiberPhase ?? 'unobserved'}
                            role="img"
                            aria-label={status}
                            title={status}
                          />
                        ) : null}
                        <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>
                          {configuration}
                        </span>
                        <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                      </span>
                    </button>
                    {open ? (
                      <div className={css.cardDetails} id={detailId}>
                        <code className={css.entryValue} data-loader-entry>{entry.entryId}</code>
                        <dl className={css.details}>
                          <div>
                            <dt>{t('configuration')}</dt>
                            <dd>{configuration}</dd>
                          </div>
                          {entry.enabled ? (
                            <div>
                              <dt>{t('cordis')}</dt>
                              <dd>{status}</dd>
                            </div>
                          ) : null}
                        </dl>
                        {entry.readOnlyReason === undefined ? (
                          <div className={css.activation}>
                            <button
                              type="button"
                              disabled={toggleDisabled}
                              aria-pressed={entry.enabled}
                              onClick={() => { togglePlugin(entry) }}
                            >
                              {pending ? t(entry.enabled ? 'pluginDisabling' : 'pluginEnabling') : t(entry.enabled ? 'pluginDisableAction' : 'pluginEnableAction')}
                            </button>
                          </div>
                        ) : <p className={css.activationNote}>{readOnlyLabel(entry.readOnlyReason, t)}</p>}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
