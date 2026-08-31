/**
 * The first-connect trust modal: target, observed daemon version against this
 * app's, and the installation id (short form for layout, full value in
 * title/aria — it is anonymous-identity data, never a secret). Branches on
 * the modal machine: inspecting, confirm (TOFU, explicit re-trust, version
 * skew, connect outcomes), connecting, and failed-with-retry. Pure props.
 */
import { Button, Modal } from '@shres-code/shres-code-client-ui-primitives'
import type { Translate } from '@shres-code/shres-code-client-ui-slots'
import css from './TrustModal.module.css'
import type { RemoteKey } from './locales.ts'
import type { ConnectDecision, RemoteModalState } from './store.ts'

/** Modal props. */
export type TrustModalProps = {
  /** Current modal machine state; `closed` renders nothing. */
  modal: RemoteModalState
  /** True while the granted connect is in flight. */
  connectBusy: boolean
  /** Namespace translate seat. */
  t: Translate<RemoteKey>
  /** Spend one granted connect with the modal's decision. */
  onConfirm: (alias: string, decision: ConnectDecision) => void
  /** Close the modal without connecting. */
  onCancel: () => void
  /** Re-run the inspect read (retry after a failure). */
  onRetry: (alias: string) => void
}

/**
 * Render the trust modal.
 * @param props - modal state plus the three actions.
 * @returns the modal element, or null when the machine is closed.
 */
export function TrustModal({ modal, connectBusy, t, onConfirm, onCancel, onRetry }: TrustModalProps) {
  if (modal.phase === 'closed') return null
  const title = t('modal.title', { alias: modal.alias })
  return (
    <Modal open onClose={onCancel} title={title} closeLabel={t('modal.close')}>
      {modal.phase === 'inspecting' && <p className={css.line}>{t('modal.inspecting')}</p>}
      {modal.phase === 'connecting' && <p className={css.line}>{t('modal.connecting')}</p>}
      {modal.phase === 'failed' && (
        <>
          <p className={css.failure}>{t('modal.failed')}</p>
          <p className={css.line}>{modal.message}</p>
          <div className={css.actions}>
            <Button variant="primary" onClick={() => { onRetry(modal.alias) }}>{t('modal.retry')}</Button>
            <Button onClick={onCancel}>{t('modal.cancel')}</Button>
          </div>
        </>
      )}
      {modal.phase === 'confirm' && (
        <ConfirmBody modal={modal} connectBusy={connectBusy} t={t} onConfirm={onConfirm} onCancel={onCancel} />
      )}
    </Modal>
  )
}

function ConfirmBody({ modal, connectBusy, t, onConfirm, onCancel }: {
  modal: Extract<RemoteModalState, { phase: 'confirm' }>
  connectBusy: boolean
  t: Translate<RemoteKey>
  onConfirm: (alias: string, decision: ConnectDecision) => void
  onCancel: () => void
}) {
  const { inspect, outcome } = modal
  const firstConnect = inspect.firstConnect
  const observedVersion = outcome?.status === 'version-mismatch' ? outcome.observed : inspect.daemonVersion
  const skew = outcome?.status === 'version-mismatch'
    || (observedVersion !== null && observedVersion !== inspect.localVersion)
  const changed = outcome?.status === 'fingerprint-mismatch'
    || (!firstConnect && inspect.installationId !== null && inspect.installationId !== inspect.trustedFingerprint)
  const installationId = inspect.installationId
    ?? (outcome?.status === 'fingerprint-mismatch' ? outcome.observed : null)
  const versionLine = observedVersion === null
    ? inspect.installed
      ? t('modal.version.absent')
      : t('modal.version.uninstalled')
    : skew
      ? t('modal.version.skew', { observed: observedVersion, local: inspect.localVersion })
      : t('modal.version.match', { version: observedVersion })
  const trustLine = firstConnect
    ? t('modal.fingerprint.first')
    : changed
      ? t('modal.fingerprint.changed')
      : t('modal.fingerprint.match')
  return (
    <>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('modal.field.target')}</span>
        <span className={css.fieldValue}>{inspect.target}</span>
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('modal.field.version')}</span>
        <span className={css.fieldValue}>{versionLine}</span>
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('modal.field.fingerprint')}</span>
        {installationId !== null && (
          <span className={css.fieldValue} title={installationId} aria-label={installationId}>
            {installationId.length > 12 ? `${installationId.slice(0, 12)}…` : installationId}
          </span>
        )}
        <span className={css.trustLine}>{trustLine}</span>
      </div>
      <div className={css.actions}>
        <Button
          variant="primary"
          disabled={connectBusy}
          onClick={() => { onConfirm(modal.alias, { allowVersionSkew: skew, forceFingerprint: changed }) }}
        >
          {skew ? t('modal.connectAnyway') : t('modal.connect')}
        </Button>
        <Button onClick={onCancel}>{t('modal.cancel')}</Button>
      </div>
    </>
  )
}
