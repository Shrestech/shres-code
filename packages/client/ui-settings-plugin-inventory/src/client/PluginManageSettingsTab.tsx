/**
 * Settings Manage tab over the pluginAdmin Remote namespace: gesture-gated
 * plugin install/remove with preview consent, restart-required statuses, and
 * installed-skill add/remove with live shadowing disclosure. Remove renders
 * only for a row the status reports removable; the host still owns the
 * refusal verdict, so its mapped copy stays reachable. Plugin
 * mutations render the unsupported-host notice when the host reports
 * `mutations: 'unsupported'`; skill operations stay available. The host is
 * built from the same source as this client, so every outcome union is
 * closed and handled exhaustively; a transport failure is the only error
 * path and renders the generic failure notice.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  PluginAdminConfirmOutcome,
  PluginAdminGestureVerb,
  PluginAdminInstallOutcome,
  PluginAdminRemoveOutcome,
  PluginAdminStatusResult,
  PluginConfirmToken,
  PluginGestureToken,
  PluginTransactionId,
  SkillInstallOutcome,
  SkillRemoveOutcome,
} from '@shres-code/shres-code-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginManageSettingsTab.module.css'

/** One profile plugin row of the status result. */
type PluginStateEntry = PluginAdminStatusResult['plugins'][number]
/** The parked arm of the install outcome, the only arm that carries a confirm token. */
type ParkedInstallOutcome = Extract<PluginAdminInstallOutcome, { kind: 'parked' }>
/** The preview a parked install awaits consent for. */
type InstallPreview = ParkedInstallOutcome['preview']
/** Core refusal of an install, carrying its code and specifics. */
type InstallRefusal = Extract<PluginAdminInstallOutcome, { kind: 'refused' }>['refusal']
/** Rollback report accompanying a refused install or a cancel. */
type RollbackReport = Extract<PluginAdminInstallOutcome, { kind: 'refused' }>['rollback']
/** The refused arm of the remove outcome. */
type RemoveRefusal = Extract<PluginAdminRemoveOutcome, { kind: 'refused' }>
/** Skill refusal codes across add and remove. */
type SkillRefusalCode =
  | Extract<SkillInstallOutcome, { kind: 'refused' }>['code']
  | Extract<SkillRemoveOutcome, { kind: 'refused' }>['code']

/** Exhaustiveness backstop for the closed outcome unions. */
/* v8 ignore next 3 -- only reachable through an arm the compiler already rejects. */
function unreachable(value: never): never {
  throw new Error(`unreachable pluginAdmin outcome: ${JSON.stringify(value)}`)
}

/** Wire grant from `pluginAdmin/begin`: spendable on exactly one matching mutation. */
interface BeginGrant {
  /** One-shot branded gesture token for the begun verb and target. */
  token: PluginGestureToken
  /** ISO 8601 deadline after which the grant is dead. */
  expiresAt: string
}

/** Registration-side pluginAdmin face used by the Manage tab. */
export interface PluginManageSettingsTabInjected {
  /** Read the plugin, skill, and parked-transaction picture for a fresh page load. */
  status: () => Promise<PluginAdminStatusResult>
  /** Mint one one-shot gesture grant bound to the verb and target. */
  begin: (verb: PluginAdminGestureVerb, target: string) => Promise<BeginGrant>
  /** Run one install into the booted profile and park it for consent. */
  install: (token: PluginGestureToken, spec: string) => Promise<PluginAdminInstallOutcome>
  /** Commit the parked install this tab began. */
  confirm: (token: PluginConfirmToken) => Promise<PluginAdminConfirmOutcome>
  /** Roll the parked install this tab began back. */
  cancel: (token: PluginConfirmToken) => Promise<RollbackReport>
  /** Remove one installed bundle package from the booted profile. */
  remove: (token: PluginGestureToken, name: string) => Promise<PluginAdminRemoveOutcome>
  /** Install one local skill directory into the installed-skills root. */
  skillAdd: (token: PluginGestureToken, path: string) => Promise<SkillInstallOutcome>
  /** Remove one installed skill. */
  skillRemove: (token: PluginGestureToken, name: string) => Promise<SkillRemoveOutcome>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginManageSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginManageSettingsTabInjected>

type ManageView =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'ready'; readonly result: PluginAdminStatusResult }

/** One settled operation rendered as a banner until the next operation replaces it. */
interface OutcomeBanner {
  readonly tone: 'ok' | 'warn'
  readonly key: PluginInventoryLocaleKey
  /** One human-facing specifics line (names, exit code, refusal detail). */
  readonly detail?: string | undefined
}

/**
 * The one operation in flight. While it is set every action button is
 * disabled, so no second gesture can start a duplicate mutation.
 */
type PendingOperation =
  | { readonly kind: 'install' }
  | { readonly kind: 'settle'; readonly action: 'confirm' | 'cancel' }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'skill-add' }
  | { readonly kind: 'skill-remove'; readonly name: string }

/** The parked install this tab began; its confirm token exists only on this client. */
interface LocalParked {
  readonly transactionId: PluginTransactionId
  readonly preview: InstallPreview
  readonly confirmToken: PluginConfirmToken
}

/** Copy key per install-refusal code. */
const INSTALL_REFUSAL_KEYS: Record<InstallRefusal['code'], PluginInventoryLocaleKey> = {
  'pnpm-not-found': 'refusePnpmNotFound',
  'pnpm-failed': 'refusePnpmFailed',
  'needs-build': 'refuseNeedsBuild',
  'foreign-dsh': 'refuseForeignManifest',
  'not-a-bundle': 'refuseNotBundle',
  'already-active': 'refuseAlreadyActive',
  'link-spec': 'refuseLinkSpec',
  'compose-failed': 'refuseComposeFailed',
  declined: 'refuseDeclined',
  'unsupported-platform': 'refuseUnsupportedPlatform',
  'invalid-spec': 'refuseInvalidSpec',
  'unsupported-layout': 'refuseUnsupportedLayout',
}

/** Copy key per remove-refusal code. */
const REMOVE_REFUSAL_KEYS: Record<RemoveRefusal['code'], PluginInventoryLocaleKey> = {
  'not-installed': 'refuseNotInstalled',
  'template-bundle': 'refuseTemplateBundle',
  'unsupported-platform': 'refuseUnsupportedPlatform',
}

/** Copy key per skill-refusal code across add and remove. */
const SKILL_REFUSAL_KEYS: Record<SkillRefusalCode, PluginInventoryLocaleKey> = {
  'invalid-skill': 'skillRefuseInvalid',
  'name-taken': 'skillRefuseNameTaken',
  'escaping-symlink': 'skillRefuseEscapingSymlink',
  'not-installed': 'skillRefuseNotInstalled',
  'not-managed': 'skillRefuseNotManaged',
}

/** Copy key per plugin restart state. */
const PLUGIN_STATE_KEYS: Record<PluginStateEntry['state'], PluginInventoryLocaleKey> = {
  active: 'stateActive',
  'installed-restart-required': 'stateInstalledRestart',
  'removed-restart-required': 'stateRemovedRestart',
}

/** Project one install refusal onto a warning banner. */
function refusalBanner(refusal: InstallRefusal): OutcomeBanner {
  return { tone: 'warn', key: INSTALL_REFUSAL_KEYS[refusal.code], detail: refusal.detail }
}

/** Project one remove refusal onto a warning banner. */
function removeRefusalBanner(refusal: RemoveRefusal): OutcomeBanner {
  return { tone: 'warn', key: REMOVE_REFUSAL_KEYS[refusal.code] }
}

/** Project one skill add or remove refusal onto a warning banner. */
function skillRefusalBanner(refusal: { readonly code: SkillRefusalCode; readonly detail?: string | undefined }): OutcomeBanner {
  return { tone: 'warn', key: SKILL_REFUSAL_KEYS[refusal.code], detail: refusal.detail }
}

/** One parked install's preview fields, shared by the local and remote parked views. */
function PreviewFields({ preview, t }: {
  preview: InstallPreview
  t: PluginManageSettingsTabProps['t']
}): ReactNode {
  return (
    <>
      <dl className={css.details}>
        <div>
          <dt>{t('previewSpecLabel')}</dt>
          <dd><code>{preview.spec}</code></dd>
        </div>
        <div>
          <dt>{t('previewPackageLabel')}</dt>
          <dd>{preview.name} {preview.version}</dd>
        </div>
        <div>
          <dt>{t('previewSourceLabel')}</dt>
          <dd>{preview.source}</dd>
        </div>
        <div>
          <dt>{t('previewAddsLabel')}</dt>
          <dd>{preview.addedPackages.length > 0 ? preview.addedPackages.join(', ') : t('previewAddsNone')}</dd>
        </div>
      </dl>
      {preview.clientHalf ? <p className={css.parkedNote}>{t('previewClientHalf')}</p> : null}
    </>
  )
}

/** Render the gesture-gated Manage tab for profile plugins and installed skills. */
export function PluginManageSettingsTab(props: PluginManageSettingsTabProps): ReactNode {
  const { status, begin, install, confirm, cancel, remove, skillAdd, skillRemove, t } = props
  const [view, setView] = useState<ManageView>({ phase: 'loading' })
  const [request, setRequest] = useState(0)
  const [spec, setSpec] = useState('')
  const [skillPath, setSkillPath] = useState('')
  const [pending, setPending] = useState<PendingOperation | null>(null)
  const [parked, setParked] = useState<LocalParked | null>(null)
  const [banner, setBanner] = useState<OutcomeBanner | null>(null)
  const busy = useRef(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(status).then(
      (result) => { if (current) setView({ phase: 'ready', result }) },
      () => { if (current) setView({ phase: 'error' }) },
    )
    return () => { current = false }
  }, [status, request])

  /**
   * Run one operation under the single-flight guard. After unmount the
   * outcome is dropped: the host owns any parked transaction (its confirm
   * window cancels it) and owns the in-flight request, so this client
   * starts no further work and keeps no state from it.
   */
  const run = (operation: PendingOperation, work: () => Promise<void>): void => {
    if (busy.current) return
    busy.current = true
    setPending(operation)
    void (async () => {
      try {
        await work()
      } catch {
        if (live.current) setBanner({ tone: 'warn', key: 'opFailedNotice' })
      } finally {
        busy.current = false
        if (live.current) setPending(null)
      }
    })()
  }

  /** Silent status refetch; the effect keeps the current view until the result lands. */
  const refresh = (): void => {
    setRequest(value => value + 1)
  }

  const beginInstall = (): void => {
    const trimmed = spec.trim()
    if (trimmed.length === 0) return
    run({ kind: 'install' }, async () => {
      const grant = await begin('install', trimmed)
      const outcome = await install(grant.token, trimmed)
      if (!live.current) return
      switch (outcome.kind) {
        case 'parked':
          setParked({ transactionId: outcome.transactionId, preview: outcome.preview, confirmToken: outcome.confirmToken })
          setBanner(null)
          break
        case 'refused':
          setBanner(refusalBanner(outcome.refusal))
          refresh()
          break
        case 'unsupported':
          setBanner({ tone: 'warn', key: 'unsupported' })
          refresh()
          break
        /* v8 ignore next -- closed union; the compiler rejects an unhandled arm. */
        default: unreachable(outcome)
      }
    })
  }

  const confirmInstall = (current: LocalParked): void => {
    run({ kind: 'settle', action: 'confirm' }, async () => {
      const outcome = await confirm(current.confirmToken)
      if (!live.current) return
      setParked(null)
      switch (outcome.kind) {
        case 'committed':
          setBanner({ tone: 'ok', key: 'installedNotice', detail: `${outcome.name} ${outcome.version}` })
          break
        case 'refused':
          setBanner(refusalBanner(outcome.refusal))
          break
        /* v8 ignore next -- closed union; the compiler rejects an unhandled arm. */
        default: unreachable(outcome)
      }
      refresh()
    })
  }

  const cancelInstall = (current: LocalParked): void => {
    run({ kind: 'settle', action: 'cancel' }, async () => {
      const rollback = await cancel(current.confirmToken)
      if (!live.current) return
      setParked(null)
      setBanner(rollback.reinstall === 'failed'
        ? { tone: 'warn', key: 'installCancelledDirtyNotice', detail: rollback.detail }
        : { tone: 'ok', key: 'installCancelledNotice' })
      refresh()
    })
  }

  const removePlugin = (name: string): void => {
    run({ kind: 'remove', name }, async () => {
      const grant = await begin('remove', name)
      const outcome = await remove(grant.token, name)
      if (!live.current) return
      switch (outcome.kind) {
        case 'removed':
          setBanner(outcome.pnpm === 'ok'
            ? { tone: 'ok', key: 'removeDoneNotice', detail: name }
            : { tone: 'warn', key: 'removeDirtyNotice', detail: name })
          refresh()
          break
        case 'refused':
          setBanner(removeRefusalBanner(outcome))
          break
        case 'unsupported':
          setBanner({ tone: 'warn', key: 'unsupported' })
          break
        /* v8 ignore next -- closed union; the compiler rejects an unhandled arm. */
        default: unreachable(outcome)
      }
    })
  }

  const addSkill = (): void => {
    const trimmed = skillPath.trim()
    if (trimmed.length === 0) return
    run({ kind: 'skill-add' }, async () => {
      const grant = await begin('skill-add', trimmed)
      const outcome = await skillAdd(grant.token, trimmed)
      if (!live.current) return
      switch (outcome.kind) {
        case 'installed':
          setBanner({ tone: 'ok', key: 'skillAddedNotice', detail: outcome.name })
          setSkillPath('')
          refresh()
          break
        case 'refused':
          setBanner(skillRefusalBanner(outcome))
          break
        /* v8 ignore next -- closed union; the compiler rejects an unhandled arm. */
        default: unreachable(outcome)
      }
    })
  }

  const removeSkill = (name: string): void => {
    run({ kind: 'skill-remove', name }, async () => {
      const grant = await begin('skill-remove', name)
      const outcome = await skillRemove(grant.token, name)
      if (!live.current) return
      switch (outcome.kind) {
        case 'removed':
          setBanner({ tone: 'ok', key: 'skillRemovedNotice', detail: name })
          refresh()
          break
        case 'refused':
          setBanner(skillRefusalBanner({ code: outcome.code }))
          break
        /* v8 ignore next -- closed union; the compiler rejects an unhandled arm. */
        default: unreachable(outcome)
      }
    })
  }

  if (view.phase !== 'ready') {
    return (
      <div className={css.section} aria-busy={view.phase === 'loading'}>
        {view.phase === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
        {view.phase === 'error' ? (
          <div className={css.failure}>
            <p role="alert">{t('error')}</p>
            <button type="button" onClick={refresh}>{t('retry')}</button>
          </div>
        ) : null}
      </div>
    )
  }

  const result = view.result
  const canMutate = result.mutations === 'enabled'
  const plugins = result.plugins
  const skills = result.skills
  const needsRestart = plugins.some(plugin => plugin.state !== 'active')
  const remoteParked = parked === null ? result.parked : undefined

  return (
    <div className={css.section}>
      {canMutate ? null : <p className={css.unsupported} role="note">{t('unsupported')}</p>}
      {banner === null ? null : banner.tone === 'ok' ? (
        <div className={css.notice} role="status">
          <p>{t(banner.key)}{banner.detail === undefined ? null : <> <strong>{banner.detail}</strong></>}</p>
        </div>
      ) : (
        <div className={css.alert} role="alert">
          <p>{t(banner.key)}{banner.detail === undefined ? null : <> <strong>{banner.detail}</strong></>}</p>
        </div>
      )}
      {remoteParked === undefined ? null : (
        <section className={css.card} data-parked="remote">
          <h3 className={css.heading}>{t('previewHeading')}</h3>
          <p className={css.parkedNote}>{t('parkedElsewhere')}</p>
          <PreviewFields preview={remoteParked.preview} t={t} />
        </section>
      )}
      {parked === null ? null : (
        <section className={css.card} data-parked="local">
          <h3 className={css.heading}>{t('previewHeading')}</h3>
          <PreviewFields preview={parked.preview} t={t} />
          <div className={css.previewActions}>
            <button
              type="button"
              className={css.primaryButton}
              disabled={pending !== null}
              onClick={() => { confirmInstall(parked) }}
            >
              {pending?.kind === 'settle' && pending.action === 'confirm' ? t('confirmBusyAction') : t('confirmAction')}
            </button>
            <button
              type="button"
              className={css.secondaryButton}
              disabled={pending !== null}
              onClick={() => { cancelInstall(parked) }}
            >
              {pending?.kind === 'settle' && pending.action === 'cancel' ? t('cancelBusyAction') : t('cancelAction')}
            </button>
          </div>
        </section>
      )}
      {canMutate ? (
        <section className={css.card} data-install="">
          <h3 className={css.heading}>{t('installHeading')}</h3>
          <form
            className={css.installForm}
            onSubmit={(event) => {
              event.preventDefault()
              beginInstall()
            }}
          >
            <label className={css.field}>
              <span>{t('specLabel')}</span>
              <input
                type="text"
                className={css.textInput}
                value={spec}
                placeholder={t('specPlaceholder')}
                disabled={pending !== null}
                onChange={(event) => { setSpec(event.currentTarget.value) }}
              />
            </label>
            <button
              type="submit"
              className={css.primaryButton}
              disabled={pending !== null || spec.trim().length === 0}
            >
              {pending?.kind === 'install' ? t('installBusyAction') : t('installAction')}
            </button>
          </form>
          <p className={css.consent}>{t('consent')}</p>
        </section>
      ) : null}
      <section data-plugin-section="">
        <div className={css.sectionHead}>
          <h3 className={css.heading}>{t('pluginsHeading')}</h3>
          {needsRestart ? <span className={css.restartTag} role="status">{t('restartRequiredBanner')}</span> : null}
        </div>
        {plugins.length === 0 ? <p className={css.muted}>{t('pluginsEmpty')}</p> : (
          <ul className={css.rows}>
            {plugins.map(plugin => (
              <li key={plugin.name} className={css.row} data-plugin-state={plugin.state}>
                <span className={css.rowMain}>
                  <strong className={css.rowTitle}>{plugin.name}</strong>
                  {plugin.version === undefined ? null : <span className={css.rowVersion}>{plugin.version}</span>}
                </span>
                <span className={css.rowTrailing}>
                  <span className={css.stateTag} data-state={plugin.state}>{t(PLUGIN_STATE_KEYS[plugin.state])}</span>
                  {canMutate && plugin.removable ? (
                    <button
                      type="button"
                      className={css.secondaryButton}
                      disabled={pending !== null}
                      aria-label={`${t('removeAction')}: ${plugin.name}`}
                      onClick={() => { removePlugin(plugin.name) }}
                    >
                      {pending?.kind === 'remove' && pending.name === plugin.name
                        ? t('removeBusyAction')
                        : t('removeAction')}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-skill-section="">
        <h3 className={css.heading}>{t('skillsHeading')}</h3>
        <form
          className={css.installForm}
          onSubmit={(event) => {
            event.preventDefault()
            addSkill()
          }}
        >
          <label className={css.field}>
            <span>{t('skillPathLabel')}</span>
            <input
              type="text"
              className={css.textInput}
              value={skillPath}
              placeholder={t('skillPathPlaceholder')}
              disabled={pending !== null}
              onChange={(event) => { setSkillPath(event.currentTarget.value) }}
            />
          </label>
          <button
            type="submit"
            className={css.primaryButton}
            disabled={pending !== null || skillPath.trim().length === 0}
          >
            {pending?.kind === 'skill-add' ? t('skillAddBusyAction') : t('skillAddAction')}
          </button>
        </form>
        {skills.length === 0 ? <p className={css.muted}>{t('skillsEmpty')}</p> : (
          <ul className={css.rows}>
            {skills.map(skill => (
              <li key={skill.name} className={css.row} data-skill={skill.name}>
                <span className={css.rowMain}>
                  <strong className={css.rowTitle}>{skill.name}</strong>
                  <span className={css.rowVersion}>{skill.description}</span>
                </span>
                <span className={css.rowTrailing}>
                  {skill.shadowedBy === undefined
                    ? null
                    : <span className={css.shadowTag}>{t('skillShadowedBy')} {skill.shadowedBy}</span>}
                  <button
                    type="button"
                    className={css.secondaryButton}
                    disabled={pending !== null}
                    aria-label={`${t('skillRemoveAction')}: ${skill.name}`}
                    onClick={() => { removeSkill(skill.name) }}
                  >
                    {pending?.kind === 'skill-remove' && pending.name === skill.name
                      ? t('skillRemoveBusyAction')
                      : t('skillRemoveAction')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
