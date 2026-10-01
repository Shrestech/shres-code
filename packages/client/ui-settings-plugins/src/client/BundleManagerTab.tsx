/** Generic profile-bundle manager and keyed feature-configuration dispatch. */

import { useEffect, useState, type ReactNode } from 'react'
import type {
  ManagedBundle,
  PluginActivationOutcome,
  PluginGestureToken,
} from '@shres-code/shres-code-api-remotes/client'
import type {
  InjectFace,
  HostObservable,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
} from '@shres-code/shres-code-client-ui-slots'
import type { SettingsPluginsBundle } from '@shres-code/shres-code-client-ui-settings/client'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import css from './BundleManagerTab.module.css'

/** Registration-side Remote face used by the generic bundle manager. */
export interface BundleManagerTabInjected {
  /** Read all installed and shipped bundles. */
  listBundles: () => Promise<readonly ManagedBundle[]>
  /** Mint a one-shot bundle selection grant. */
  begin: (verb: 'bundle-enable' | 'bundle-disable', target: string) => Promise<{
    token: PluginGestureToken
    expiresAt: string
  }>
  /** Spend a grant to select or deselect one bundle. */
  setBundleEnabled: (token: PluginGestureToken, name: string, enabled: boolean) => Promise<PluginActivationOutcome>
  /** Invalidates the snapshot when the host connection is rebuilt. */
  hooks: { connectionRevision: HostObservable<number> }
}

/** Full component props assembled by the Plugins tab slot renderer. */
export type BundleManagerTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugins.bundle'>
  & InjectFace<BundleManagerTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly bundles: readonly ManagedBundle[] }

type ActionState =
  | { readonly kind: 'none' }
  | { readonly kind: 'working'; readonly name: string; readonly enabled: boolean }
  | { readonly kind: 'saved'; readonly name: string; readonly enabled: boolean; readonly outcome: Extract<PluginActivationOutcome, { kind: 'saved' }> }
  | { readonly kind: 'refused'; readonly name: string; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string }

/** Narrow a bundle wire value to the settings slot's generic feature state. */
function slotBundle(bundle: ManagedBundle): SettingsPluginsBundle {
  return bundle
}

/** Describe an activation outcome without importing feature-specific copy. */
function outcomeDetail(outcome: PluginActivationOutcome, t: BundleManagerTabProps['t'], enabled: boolean): string {
  if (outcome.kind === 'saved') {
    const key: Record<typeof outcome.application, PluginsSettingsLocaleKey> = {
      applied: enabled ? 'bundleApplied' : 'bundleDisabledSaved',
      'restart-required': 'bundleRestartRequired',
      overridden: 'bundleOverridden',
    }
    return outcome.detail === undefined ? t(key[outcome.application]) : `${t(key[outcome.application])} ${outcome.detail}`
  }
  if (outcome.kind === 'unsupported') return t('bundleUnsupported')
  const key: Record<typeof outcome.code, PluginsSettingsLocaleKey> = {
    'unknown-bundle': 'bundleUnknown',
    'unknown-plugin': 'bundleUnknown',
    'management-required': 'bundleManagementRequired',
    unaddressable: 'bundleUnaddressable',
    'invalid-composition': 'bundleInvalidComposition',
  }
  return outcome.detail === undefined ? t(key[outcome.code]) : `${t(key[outcome.code])} ${outcome.detail}`
}

/** Generic display state for a bundle row. */
function bundleState(bundle: ManagedBundle, t: BundleManagerTabProps['t']): string {
  if (bundle.error !== undefined) return t('bundleUnavailable')
  if (bundle.selected && bundle.active) return t('bundleActive')
  if (bundle.selected !== bundle.active) return t(bundle.selected ? 'bundlePendingEnable' : 'bundlePendingDisable')
  if (!bundle.shipped) return t('bundleInstalled')
  return t('bundleDisabled')
}

/** Translate host-managed read-only reasons before showing them in the generic manager. */
function readOnlyDetail(reason: string, t: BundleManagerTabProps['t']): string {
  if (reason === 'management-required') return t('bundleManagementRequired')
  if (reason === 'unaddressable') return t('bundleUnaddressable')
  return reason
}

/** Render bundle selection controls and feature-owned details. */
export function BundleManagerTab(props: BundleManagerTabProps): ReactNode {
  const { listBundles, begin, setBundleEnabled, renderSlot, t, useConnectionRevision } = props
  const [request, setRequest] = useState(0)
  const connectionRevision = useConnectionRevision(value => value)
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [action, setAction] = useState<ActionState>({ kind: 'none' })
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listBundles()).then(
      (bundles) => { if (current) setView({ status: 'ready', bundles }) },
      () => { if (current) setView({ status: 'error' }) },
    )
    return () => { current = false }
  }, [connectionRevision, listBundles, request])

  const retry = (): void => {
    setView({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const toggle = (bundle: ManagedBundle): void => {
    if (action.kind === 'working' || bundle.readOnlyReason !== undefined) return
    const enabled = !bundle.selected
    setAction({ kind: 'working', name: bundle.name, enabled })
    void (async () => {
      try {
        const grant = await begin(enabled ? 'bundle-enable' : 'bundle-disable', bundle.name)
        const outcome = await setBundleEnabled(grant.token, bundle.name, enabled)
        if (outcome.kind === 'saved') {
          setAction({ kind: 'saved', name: bundle.name, enabled, outcome })
          setRequest(value => value + 1)
        } else {
          setAction({ kind: 'refused', name: bundle.name, detail: outcomeDetail(outcome, t, enabled) })
        }
      } catch (error) {
        setAction({ kind: 'error', detail: error instanceof Error ? error.message : t('bundleOperationFailed') })
      }
    })()
  }

  if (view.status === 'loading') return <p className={css.status}>{t('bundlesLoading')}</p>
  if (view.status === 'error') {
    return <div className={css.failure}><p role="alert">{t('bundlesError')}</p><button type="button" onClick={retry}>{t('retry')}</button></div>
  }
  if (view.bundles.length === 0) return <p className={css.status}>{t('bundlesEmpty')}</p>

  const working = action.kind === 'working' ? action.name : undefined
  return (
    <div className={css.section} aria-busy={working !== undefined}>
      <p className={css.intro}>{t('bundlesIntro')}</p>
      {action.kind === 'saved' ? <p className={css.notice} role="status">{outcomeDetail(action.outcome, t, action.enabled)}</p> : null}
      {action.kind === 'refused' || action.kind === 'error' ? <p className={css.alert} role="alert">{action.detail}</p> : null}
      <ul className={css.cards}>
        {view.bundles.map((bundle) => {
          const featureReady = bundle.selected && bundle.active && bundle.error === undefined
          const state = bundleState(bundle, t)
          const disabled = working !== undefined || bundle.readOnlyReason !== undefined
          const detailsOpen = expanded === bundle.name
          const featureDetails = featureReady && detailsOpen
            ? renderSlot('settings.plugins.bundle', { bundle: slotBundle(bundle) }, { entryKey: bundle.name })
            : null
          return (
            <li className={css.card} key={bundle.name} data-bundle={bundle.name} data-active={featureReady ? 'true' : 'false'}>
              <div className={css.header}>
                <div className={css.headText}>
                  <strong className={css.name}>{bundle.name}</strong>
                  {bundle.description === undefined ? null : <span className={css.description}>{bundle.description}</span>}
                  <span className={css.state}>{state}</span>
                </div>
                <div className={css.actions}>
                  {featureReady ? <button type="button" className={css.detailsToggle} aria-expanded={detailsOpen} onClick={() => { setExpanded(current => current === bundle.name ? null : bundle.name) }}>
                    {t(detailsOpen ? 'bundleHideDetails' : 'bundleShowDetails')}
                  </button> : null}
                  <button
                    type="button"
                    className={css.toggle}
                    disabled={disabled}
                    aria-pressed={bundle.selected}
                    onClick={() => { toggle(bundle) }}
                  >
                    {working === bundle.name ? t(bundle.selected ? 'bundleDisabling' : 'bundleEnabling') : t(bundle.selected ? 'bundleDisableAction' : 'bundleEnableAction')}
                  </button>
                </div>
              </div>
              {bundle.version === undefined ? null : <p className={css.version}>{t('bundleVersion')}: {bundle.version}</p>}
              {bundle.readOnlyReason === undefined ? null : <p className={css.readOnly}>{readOnlyDetail(bundle.readOnlyReason, t)}</p>}
              {bundle.error === undefined ? null : <p className={css.readOnly}>{bundle.error}</p>}
              {!featureReady && bundle.selected && bundle.active ? <p className={css.readOnly}>{t('bundleFeatureUnavailable')}</p> : null}
              {featureReady && detailsOpen ? (
                <div className={css.feature}>
                  <p className={css.version} data-generic-bundle-details="true">{bundle.description ?? bundle.name}</p>
                  {bundle.rows.length === 0 ? null : <p className={css.version}>{t('bundleRows')}: {bundle.rows.join(', ')}</p>}
                  {featureDetails}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
