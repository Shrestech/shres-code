/**
 * BrowserSkill feature settings over the gesture-gated browserSkill
 * namespace: the single disclosed install flow (verified provisioning and
 * the owned-browser launch behind one confirmation), provisioning progress
 * and readiness, and teardown. Reset always deletes the owned profile and
 * its sign-ins and warns so before the gesture is minted; uninstall carries
 * the keep-profile choice. Refusals render as statements with their
 * specifics and no bypass: there is no continue-anywhere and no port choice,
 * because the host never contacts or evicts a listener it does not own.
 *
 * Spending methods answer with the accepted operation id or the refusal;
 * completion is observed by polling status and matching the operation id. A
 * lifecycle state is never treated as an outcome: a Ready that predates the
 * accepted operation cannot be misread as the operation's completion,
 * because only the accepted id settling ends the wait.
 *
 * The host is built from the same source as this client, so every state and
 * refusal union is closed and handled exhaustively; a transport failure is
 * the only error path and renders the generic failure notice with a retry.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  BrowserSkillOperation,
  BrowserSkillOperationId,
  BrowserSkillRefusal,
  BrowserSkillStatus,
  BrowserSkillToken,
} from '@shres-code/shres-code-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type { BrowserSkillLocaleKey } from './locales.ts'
import css from './BrowserSkillSettingsSection.module.css'

/** One lifecycle verb of the browserSkill namespace. */
type SpendVerb = BrowserSkillOperation['verb']

/**
 * Wire verdict of one spending method, minus the settled promise the RPC
 * never carries: the accepted operation's id, or the refusal.
 */
export type BrowserSkillStartVerdict =
  | { accepted: true; operationId: BrowserSkillOperationId }
  | { accepted: false; refusal: BrowserSkillRefusal }

/** Transport marker for a host composition without the selected BrowserSkill row. */
export class BrowserSkillUnavailableError extends Error {
  readonly kind = 'browserSkill-unavailable'

  /**
   * @param message - Gateway diagnostic retained for logs, never shown as a
   *   provisioning control or fallback instruction.
   */
  constructor(message: string) {
    super(message)
    this.name = 'BrowserSkillUnavailableError'
  }
}

/**
 * Registration-side browserSkill face used by the feature settings. Runtime
 * bundle selection is owned by the generic Plugins manager; this face owns
 * only consented BrowserSkill provisioning and lifecycle actions.
 */
export interface BrowserSkillSettingsSectionInjected {
  /** Read the lifecycle picture: state, consent facts, artifacts, operation. */
  status: () => Promise<BrowserSkillStatus>
  /** Mint one one-shot gesture grant bound to the verb and keepProfile choice. */
  begin: (verb: SpendVerb, keepProfile?: boolean) => Promise<{ token: BrowserSkillToken; expiresAt: string }>
  /** Start the disclosed provision flow; answers the operation id or the refusal. */
  provision: (token: BrowserSkillToken) => Promise<BrowserSkillStartVerdict>
  /** Open the provisioned stack again (also reconnects a disconnected browser). */
  openBrowser: (token: BrowserSkillToken) => Promise<BrowserSkillStartVerdict>
  /** Close the browser sessions and the browser, then stop the owned daemon. */
  closeBrowser: (token: BrowserSkillToken) => Promise<BrowserSkillStartVerdict>
  /** Delete the owned profile and its sign-ins and pick a fresh daemon port. */
  reset: (token: BrowserSkillToken) => Promise<BrowserSkillStartVerdict>
  /** Remove the provisioned artifacts; the profile survives only when kept. */
  uninstall: (token: BrowserSkillToken, keepProfile: boolean) => Promise<BrowserSkillStartVerdict>
}

/** Full component props assembled by the Settings slot renderer. */
export type BrowserSkillSettingsSectionProps =
  PropsRuntime<'settings.plugins.bundle'>
  & PropsLocale<'settings.browserSkill'>
  & InjectFace<BrowserSkillSettingsSectionInjected>

/** Poll cadence while an accepted operation or a runtime transition is in flight. */
const POLL_MS = 500

/** Whether a failed status read means the feature row is unavailable. */
function isUnavailable(error: unknown): error is BrowserSkillUnavailableError {
  return error instanceof BrowserSkillUnavailableError
}

/** The operation this client accepted and is waiting to settle. */
interface TrackedOperation {
  readonly id: string
  readonly verb: SpendVerb
  readonly keepProfile: boolean
}

/** One settled operation rendered as a banner until the next operation replaces it. */
interface OutcomeBanner {
  readonly tone: 'ok' | 'warn'
  readonly key: BrowserSkillLocaleKey
  /** One human-facing specifics line built from a structured refusal. */
  readonly detail?: string | undefined
}

/** Copy key per refusal kind. */
const REFUSAL_KEYS: Record<BrowserSkillRefusal['kind'], BrowserSkillLocaleKey> = {
  'endpoint-in-use': 'refuseEndpointInUse',
  'hash-mismatch': 'refuseHashMismatch',
  'download-failed': 'refuseDownloadFailed',
  'extension-load-failed': 'refuseExtensionLoadFailed',
  'daemon-start-failed': 'refuseDaemonStartFailed',
  'instance-mismatch': 'refuseInstanceMismatch',
  'command-lost': 'refuseCommandLost',
  'owned-by-peer': 'refuseOwnedByPeer',
  'operation-in-progress': 'refuseOperationInProgress',
  'disposed': 'refuseDisposed',
  'shutdown-incomplete': 'refuseShutdownIncomplete',
  'unsupported-platform': 'unsupportedPlatform',
  'chrome-missing': 'chromeMissing',
  'chrome-too-old': 'chromeTooOld',
}

/** Copy key per unsupported reason. */
const UNSUPPORTED_KEYS = {
  platform: 'unsupportedPlatform',
  'chrome-missing': 'chromeMissing',
  'chrome-too-old': 'chromeTooOld',
} as const satisfies Record<Extract<BrowserSkillStatus['state'], { kind: 'unsupported' }>['reason'], BrowserSkillLocaleKey>

/** The provisioning steps in run order, for the progress list. */
const PROVISIONING_STEPS = [
  { key: 'stepDownload', step: 'download' },
  { key: 'stepVerify', step: 'verify' },
  { key: 'stepExtract', step: 'extract' },
] as const

/** Copy key for a succeeded operation, by verb and uninstall keep choice. */
function successKey(verb: SpendVerb, keepProfile: boolean): BrowserSkillLocaleKey {
  switch (verb) {
    case 'provision': return 'provisionedNotice'
    case 'open': return 'openedNotice'
    case 'close': return 'closedNotice'
    case 'reset': return 'resetDoneNotice'
    case 'uninstall': return keepProfile ? 'uninstallDoneKeptNotice' : 'uninstallDonePurgedNotice'
  }
}

/**
 * Build the human-facing specifics line of a structured refusal; each line
 * carries the fields the host reported, rendered verbatim.
 */
function refusalDetail(refusal: BrowserSkillRefusal): string | undefined {
  switch (refusal.kind) {
    case 'endpoint-in-use':
      return 'Port ' + String(refusal.port) + ' is already in use.'
    case 'hash-mismatch':
      return refusal.artifact + ': expected ' + refusal.expected + ', got ' + refusal.actual + '.'
    case 'download-failed':
    case 'extension-load-failed':
    case 'daemon-start-failed':
    case 'command-lost':
    case 'disposed':
    case 'shutdown-incomplete':
    case 'unsupported-platform':
    case 'chrome-missing':
    case 'chrome-too-old':
      return refusal.detail
    case 'owned-by-peer':
      // The detail, when the host reported one, is the manual recovery path.
      return refusal.detail ?? 'Owned by process ' + String(refusal.pid) + '.'
    case 'instance-mismatch':
    case 'operation-in-progress':
      return undefined
    /* v8 ignore next -- closed union; the compiler rejects an unhandled arm. */
    default:
      return unreachable(refusal)
  }
}

/** Project one refusal onto a warning banner. */
function refusalBanner(refusal: BrowserSkillRefusal): OutcomeBanner {
  return { tone: 'warn', key: REFUSAL_KEYS[refusal.kind], detail: refusalDetail(refusal) }
}

/** Exhaustiveness backstop for the closed outcome unions. */
/* v8 ignore next 3 -- only reachable through an arm the compiler already rejects. */
function unreachable(value: never): never {
  throw new Error('unreachable browserSkill outcome: ' + JSON.stringify(value))
}

/** One consent-disclosure download row: artifact, URL, pinned version, and hash. */
function DownloadRow({ artifact, url, version, sha256 }: {
  artifact: string
  url: string
  version: string
  sha256: string
}): ReactNode {
  return (
    <li className={css.artifact} data-artifact={artifact}>
      <strong className={css.artifactName}>{artifact}</strong>
      <span className={css.artifactFacts}>
        <code className={css.artifactFact}>{url}</code>
        <code className={css.artifactFact}>{version}</code>
        <code className={css.artifactFact}>{sha256}</code>
      </span>
    </li>
  )
}

/** Render the BrowserSkill Settings section. */
export function BrowserSkillSettingsSection(props: BrowserSkillSettingsSectionProps): ReactNode {
  const { status, begin, provision, openBrowser, closeBrowser, reset, uninstall, t } = props
  const [view, setView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; unavailable: boolean }
    | { phase: 'ready'; result: BrowserSkillStatus }
  >({ phase: 'loading' })
  const [request, setRequest] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const [tracked, setTracked] = useState<TrackedOperation | undefined>(undefined)
  const trackedRef = useRef<TrackedOperation | undefined>(undefined)
  const [banner, setBanner] = useState<OutcomeBanner | null>(null)
  const [confirming, setConfirming] = useState<'none' | 'reset' | 'uninstall'>('none')
  const [keepProfile, setKeepProfile] = useState(true)
  const busy = useRef(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(status).then(
      (result) => {
        if (!current) return
        setView({ phase: 'ready', result })
        // Settle the tracked operation ONLY on its own id: a Ready state that
        // predates the accepted operation, or another operation's terminal
        // record, never ends this wait. The ref keeps the settle check free of
        // state updates inside an updater.
        const tracking = trackedRef.current
        if (tracking !== undefined) {
          const operation = result.operation
          const settledHere = operation !== undefined && operation.id === tracking.id && operation.phase !== 'running'
          if (settledHere) {
            trackedRef.current = undefined
            setTracked(undefined)
            if (operation.phase === 'failed') {
              setBanner(operation.refusal === undefined
                ? { tone: 'warn', key: 'opFailedNotice' }
                : refusalBanner(operation.refusal))
            } else {
              setBanner({ tone: 'ok', key: successKey(tracking.verb, tracking.keepProfile) })
            }
          }
        }
      },
      (error: unknown) => { if (current) setView({ phase: 'error', unavailable: isUnavailable(error) }) },
    )
    return () => { current = false }
  }, [status, request])

  // Progress, starting, and tracked operations poll, so the UI follows the
  // runtime's own state machine instead of guessing at timings.
  const polling = view.phase === 'ready'
    && (tracked !== undefined
      || view.result.state.kind === 'provisioning'
      || view.result.state.kind === 'starting'
      || view.result.operation?.phase === 'running')
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => { setRequest(value => value + 1) }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [polling])

  /**
   * Run one operation under the single-flight guard. After unmount the
   * outcome is dropped: the host owns the operation, so this client starts
   * no further work and keeps no state from it.
   */
  const run = (name: string, work: () => Promise<void>): void => {
    // Single-flight backstop in the operation itself: every control that
    // reaches run() also renders disabled={busyActions}, and busyActions is
    // true exactly while busy.current is set, so the rendered UI cannot
    // dispatch a second operation while one is in flight. The guard is the
    // operation-level enforcement behind that rendered state.
    /* v8 ignore next -- provably unreachable through the rendered controls; see comment above */
    if (busy.current) return
    busy.current = true
    setPending(name)
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

  /** Spend one verb, accept its operation, and wait for that id to settle. */
  const spendVerb = (
    verb: SpendVerb,
    spend: (token: BrowserSkillToken, keep: boolean) => Promise<BrowserSkillStartVerdict>,
    keep = false,
  ): void => {
    run(verb, async () => {
      const grant = await begin(verb, keep)
      const verdict = await spend(grant.token, keep)
      if (!live.current) return
      // A refused start never became an operation: render its refusal and stop.
      if (!verdict.accepted) {
        setBanner(refusalBanner(verdict.refusal))
        return
      }
      const tracking: TrackedOperation = { id: verdict.operationId, verb, keepProfile: keep }
      trackedRef.current = tracking
      setTracked(tracking)
      refresh()
    })
  }

  if (view.phase !== 'ready') {
    return (
      <div className={css.section} aria-busy={view.phase === 'loading'}>
        {view.phase === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
        {view.phase === 'error' && view.unavailable ? <p className={css.unsupported} role="status">{t('unavailable')}</p> : null}
        {view.phase === 'error' && !view.unavailable ? (
          <div className={css.failure}>
            <p role="alert">{t('error')}</p>
            <button type="button" onClick={refresh}>{t('retry')}</button>
          </div>
        ) : null}
      </div>
    )
  }

  const result = view.result
  const state = result.state
  const consent = result.consent
  // Controls stay disabled until the accepted operation settles, so no
  // second gesture can start while one is still running.
  const busyActions = pending !== null || tracked !== undefined
  const ownedState = state.kind === 'provisioned' || state.kind === 'ready' || state.kind === 'disconnected' || state.kind === 'failed'
  const currentState = result.operation?.phase === 'running' ? result.operation : undefined

  return (
    <div className={css.section} data-browserskill-state={state.kind}>
      {banner === null ? null : banner.tone === 'ok' ? (
        <div className={css.notice} role="status">
          <p>{t(banner.key)}</p>
        </div>
      ) : (
        <div className={css.alert} role="alert">
          <p>{t(banner.key)}{banner.detail === undefined ? null : <> <strong>{banner.detail}</strong></>}</p>
        </div>
      )}
      {state.kind === 'unsupported' ? (
        <p className={css.unsupported} role="note">{t(UNSUPPORTED_KEYS[state.reason])}</p>
      ) : null}
      {state.kind === 'failed' ? (
        <div className={css.alert} role="alert" data-refusal={state.refusal.kind}>
          <p>{t(REFUSAL_KEYS[state.refusal.kind])}</p>
          {refusalDetail(state.refusal) === undefined ? null : (
            <p className={css.alertDetail}>{refusalDetail(state.refusal)}</p>
          )}
        </div>
      ) : null}
      {state.kind === 'disconnected' ? (
        <div className={css.alert} role="alert">
          <p>{t('disconnectedNotice')}</p>
        </div>
      ) : null}
      {state.kind === 'provisioning' ? (
        <section className={css.card} data-provisioning="">
          <h3 className={css.heading}>{t('provisioningHeading')}</h3>
          <p className={css.status} aria-live="polite">{t('provisioningNote')}</p>
          <ol className={css.steps}>
            {PROVISIONING_STEPS.map(({ key, step }) => (
              <li className={css.step} key={step} data-step={step} data-step-phase={state.step === step ? 'stepActive' : 'stepPending'}>
                {t(key)}
                <span className={css.stepPhase}>{t(state.step === step ? 'stepActive' : 'stepPending')}</span>
              </li>
            ))}
            <li className={css.step} data-step="launch" data-step-phase="stepPending">
              {t('stepLaunch')}
              <span className={css.stepPhase}>{t('stepPending')}</span>
            </li>
          </ol>
        </section>
      ) : null}
      {state.kind === 'absent' ? (
        <section className={css.card} data-consent="">
          <h3 className={css.heading}>{t('installHeading')}</h3>
          <p className={css.consent}>{t('installIntro')}</p>
          <h4 className={css.subheading}>{t('disclosureHeading')}</h4>
          <dl className={css.details}>
            <div>
              <dt>{t('downloadsLabel')}</dt>
              <dd>
                <ul className={css.artifacts}>
                  {consent.downloads.map(download => (
                    <DownloadRow
                      key={download.artifact}
                      artifact={download.artifact}
                      url={download.url}
                      version={download.version}
                      sha256={download.sha256}
                    />
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt>{t('installDirLabel')}</dt>
              <dd><code>{consent.installDir}</code></dd>
            </div>
            <div>
              <dt>{t('profileDirLabel')}</dt>
              <dd><code>{consent.profileDir}</code></dd>
            </div>
            <div>
              <dt>{t('permissionsLabel')}</dt>
              <dd>{consent.extensionPermissions.join(', ')}</dd>
            </div>
            <div>
              <dt>{t('hostPermissionsLabel')}</dt>
              <dd>{consent.extensionHostPermissions.join(', ')}</dd>
            </div>
            <div>
              <dt>{t('updateManifestLabel')}</dt>
              <dd><code>{consent.updateManifestUrl}</code> — {t('updateManifestNote')}</dd>
            </div>
          </dl>
          <p className={css.consent}>{t('gestureNote')}</p>
          <p className={css.consent}>{t('agentCapabilityNote')}</p>
          <button
            type="button"
            className={css.primaryButton}
            disabled={busyActions}
            data-install-action=""
            onClick={() => { spendVerb('provision', token => provision(token)) }}
          >
            {pending === 'provision' ? t('installBusyAction') : t('installAction')}
          </button>
        </section>
      ) : null}
      {ownedState ? (
        <section className={css.card} data-runtime="">
          <div className={css.readyHead}>
            <h3 className={css.heading}>{t('nav')}</h3>
            {state.kind === 'ready' ? <span className={css.readyTag} role="status">{t('readyBadge')}</span> : null}
          </div>
          {state.kind === 'ready' ? <p className={css.status}>{t('readyNote')}</p> : null}
          {currentState !== undefined ? (
            <p className={css.status} aria-live="polite">
              {currentState.verb} — {currentState.phase}
            </p>
          ) : null}
          <dl className={css.details}>
            {result.chrome === undefined ? null : (
              <div>
                <dt>{t('chromeLabel')}</dt>
                <dd>{result.chrome.version}</dd>
              </div>
            )}
            {result.artifacts === undefined ? null : (
              <div>
                <dt>{t('artifactsLabel')}</dt>
                <dd>
                  <ul className={css.artifacts}>
                    <li className={css.artifact} data-artifact="bsk">
                      <code className={css.artifactFact}>bsk {result.artifacts.bsk.version} {result.artifacts.bsk.sha256}</code>
                    </li>
                    <li className={css.artifact} data-artifact="extension">
                      <code className={css.artifactFact}>
                        extension {result.artifacts.extension.version} {result.artifacts.extension.sha256}
                      </code>
                    </li>
                  </ul>
                </dd>
              </div>
            )}
            <div>
              <dt>{t('installDirLabel')}</dt>
              <dd><code>{consent.installDir}</code></dd>
            </div>
            <div>
              <dt>{t('profileDirLabel')}</dt>
              <dd><code>{consent.profileDir}</code></dd>
            </div>
            <div>
              <dt>{t('updateManifestLabel')}</dt>
              <dd><code>{consent.updateManifestUrl}</code> — {t('updateManifestNote')}</dd>
            </div>
          </dl>
          <p className={css.consent}>{t('agentCapabilityNote')}</p>
          <button
            type="button"
            className={css.primaryButton}
            disabled={busyActions}
            data-open-action=""
            onClick={() => { spendVerb('open', token => openBrowser(token)) }}
          >
            {pending === 'open' ? t('openBusyAction') : t('openAction')}
          </button>
          {state.kind === 'ready' ? (
            <button
              type="button"
              className={css.secondaryButton}
              disabled={busyActions}
              data-close-action=""
              onClick={() => { spendVerb('close', token => closeBrowser(token)) }}
            >
              {pending === 'close' ? t('closeBusyAction') : t('closeAction')}
            </button>
          ) : null}
        </section>
      ) : null}
      {ownedState && state.kind !== 'disconnected' ? (
        <section className={css.card} data-teardown="">
          <h3 className={css.heading}>{t('teardownHeading')}</h3>
          {confirming === 'none' ? (
            <div className={css.teardownActions}>
              <button
                type="button"
                className={css.secondaryButton}
                disabled={busyActions}
                data-reset-action=""
                onClick={() => { setConfirming('reset') }}
              >
                {t('resetAction')}
              </button>
              <button
                type="button"
                className={css.secondaryButton}
                disabled={busyActions}
                data-uninstall-action=""
                onClick={() => { setConfirming('uninstall'); setKeepProfile(true) }}
              >
                {t('uninstallAction')}
              </button>
            </div>
          ) : confirming === 'reset' ? (
            <div className={css.confirmCard} data-confirm="reset">
              <p className={css.destructive} role="alert">{t('resetWarning')}</p>
              <p className={css.consent}>{consent.profileDir}</p>
              <div className={css.teardownActions}>
                <button
                  type="button"
                  className={css.destructiveButton}
                  disabled={busyActions}
                  data-confirm-action=""
                  onClick={() => { setConfirming('none'); spendVerb('reset', token => reset(token)) }}
                >
                  {t('confirmResetAction')}
                </button>
                <button
                  type="button"
                  className={css.secondaryButton}
                  disabled={busyActions}
                  onClick={() => { setConfirming('none') }}
                >
                  {t('cancelAction')}
                </button>
              </div>
            </div>
          ) : (
            <div className={css.confirmCard} data-confirm="uninstall">
              <label className={css.keepProfile}>
                <input
                  type="checkbox"
                  checked={keepProfile}
                  disabled={busyActions}
                  onChange={(event) => { setKeepProfile(event.currentTarget.checked) }}
                />
                <span>{t('keepProfileLabel')}</span>
              </label>
              {keepProfile ? null : <p className={css.destructive} role="alert">{t('destructiveWarning')}</p>}
              <div className={css.teardownActions}>
                <button
                  type="button"
                  className={keepProfile ? css.primaryButton : css.destructiveButton}
                  disabled={busyActions}
                  data-confirm-action=""
                  onClick={() => { setConfirming('none'); spendVerb('uninstall', (token, keep) => uninstall(token, keep), keepProfile) }}
                >
                  {t('confirmUninstallAction')}
                </button>
                <button
                  type="button"
                  className={css.secondaryButton}
                  disabled={busyActions}
                  onClick={() => { setConfirming('none') }}
                >
                  {t('cancelAction')}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}
