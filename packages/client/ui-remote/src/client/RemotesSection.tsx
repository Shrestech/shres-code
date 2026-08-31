/**
 * The sidebar.remotes registrant: the remote-host group — fold header, the
 * connected badge, one row per registry alias, the inline add/edit form, and
 * the LAN degraded hint — plus the shared trust modal. Reads the plugin's
 * view store through the bound `useView` selector hook and drives every
 * mutation through the injected callbacks; the form draft and its error are
 * component-local.
 */
import { useState } from 'react'
import { IconChevronDownOutline14, IconPlusOutline16 } from '@shres-code/shres-code-client-ui-primitives'
import type { PropsRuntime, SnapshotSelectorHook, Translate } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.remotes' entry).
import type {} from '@shres-code/shres-code-client-ui-sidebar/client'
import type { RemoteEntryView } from '@shres-code/shres-code-api-remotes/client'
import clsx from 'clsx'
import { ConnectedBadge, type ConnectedTunnel } from './ConnectedBadge.tsx'
import type { RemoteKey } from './locales.ts'
import { RemoteRow } from './RemoteRow.tsx'
import {
  BUSY_ADD, busyKey, type AddEditResult, type ConnectDecision, type RemoteDraft,
  type RemoteViewState, type RemoteViewStore, type RemoveResult,
} from './store.ts'
import { TrustModal } from './TrustModal.tsx'
import css from './RemotesSection.module.css'

/**
 * Injected share: the bound view-store hook plus the complete mutation API
 * (the apply closures over the remoteControl/remoteAdmin namespaces). The
 * bare store source rides the reserved `hooks` compartment — components
 * never receive it directly.
 */
export type RemoteInjected = {
  hooks: {
    /** The plugin's shared view store (snapshot observable). */
    view: RemoteViewStore
  }
  /** Read the alias and open the trust modal. */
  connect: (alias: string) => Promise<void>
  /** Spend one granted connect with the modal's decision. */
  confirmConnect: (alias: string, decision: ConnectDecision) => Promise<void>
  /** Close the modal without connecting. */
  cancelModal: () => void
  /** Disconnect one alias's GUI-owned tunnel. */
  disconnect: (alias: string) => Promise<void>
  /** Open the tunneled origin in a new tab. */
  openTab: (localPort: number) => void
  /** Insert one registry entry. */
  addRemote: (draft: RemoteDraft) => Promise<AddEditResult>
  /** Rewrite one registry entry in place. */
  editRemote: (alias: string, draft: RemoteDraft) => Promise<AddEditResult>
  /** Remove one registry entry (refused while connected). */
  removeRemote: (alias: string) => Promise<RemoveResult>
  /** Fold or unfold the group body. */
  setFolded: (folded: boolean) => void
}

/** Component-side view of the injected share: the bound selector hook. */
export type RemoteViewHooks = {
  /** Selector hook over the shared view snapshot. */
  useView: SnapshotSelectorHook<RemoteViewState>
}

/** Full section props: owner share + injected actions + the bound hook + locale seat. */
export type RemotesSectionProps =
  PropsRuntime<'sidebar.remotes'>
  & Omit<RemoteInjected, 'hooks'>
  & RemoteViewHooks
  & { t: Translate<RemoteKey> }

/** The inline form's mode: a fresh alias, or one entry being rewritten. */
type FormState = { mode: 'add' } | { mode: 'edit'; entry: RemoteEntryView }

/**
 * Render the remote-host group.
 * @param props - composed slot props (owner share, injected face, hook, locale).
 * @returns the group element; the rail width renders nothing (the workspaces
 * region owns the 56px column).
 */
export function RemotesSection({
  wide, useView, connect, confirmConnect, cancelModal, disconnect, openTab,
  addRemote, editRemote, removeRemote, setFolded, t,
}: RemotesSectionProps) {
  const { entries, tunnels, degraded, folded, modal, busy } = useView(state => state)
  const [form, setForm] = useState<FormState | null>(null)

  if (!wide) return null

  const openTunnels: ConnectedTunnel[] = []
  for (const entry of entries) {
    const tunnel = tunnels[entry.id]
    if (tunnel !== undefined && tunnel.state === 'open' && tunnel.localPort !== null) {
      openTunnels.push({ alias: entry.id, target: entry.target, localPort: tunnel.localPort })
    }
  }

  return (
    <section className={css.group} aria-label={t('section.remotes')}>
      <button
        type="button"
        className={css.header}
        aria-expanded={!folded}
        aria-label={folded ? t('fold.show') : t('fold.hide')}
        onClick={() => { setFolded(!folded) }}
      >
        <IconChevronDownOutline14 size={14} className={clsx(css.chevron, folded && css.chevronFolded)} />
        <span className={css.headerLabel}>{t('section.remotes')}</span>
      </button>
      {!folded && (
        <>
          <ConnectedBadge open={openTunnels} t={t} onOpen={openTab} onDisconnect={(alias) => { void disconnect(alias) }} />
          <div className={css.rows}>
            {entries.map(entry => (
              <RemoteRow
                key={entry.id}
                entry={entry}
                tunnel={tunnels[entry.id]}
                busy={busy[busyKey('connect', entry.id)] === true}
                t={t}
                onConnect={(alias) => { void connect(alias) }}
                onEdit={() => { setForm({ mode: 'edit', entry }) }}
                onRemove={removeRemote}
                onOpenTab={openTab}
              />
            ))}
          </div>
          {form === null ? (
            <button type="button" className={css.add} onClick={() => { setForm({ mode: 'add' }) }}>
              <IconPlusOutline16 size={14} />
              {t('form.add')}
            </button>
          ) : (
            <AddEditForm
              key={form.mode === 'edit' ? form.entry.id : 'add'}
              form={form}
              addBusy={busy[BUSY_ADD] === true}
              t={t}
              onSubmit={(draft) => {
                const result = form.mode === 'edit'
                  ? editRemote(form.entry.id, draft)
                  : addRemote(draft)
                return result.then((outcome) => {
                  if (outcome.ok) setForm(null)
                  return outcome
                })
              }}
              onCancel={() => { setForm(null) }}
            />
          )}
          {degraded && <p className={css.degraded}>{t('degraded.hint')}</p>}
        </>
      )}
      <TrustModal
        modal={modal}
        connectBusy={modal.phase !== 'closed' && busy[busyKey('connect', modal.alias)] === true}
        t={t}
        onConfirm={(alias, decision) => { void confirmConnect(alias, decision) }}
        onCancel={cancelModal}
        onRetry={(alias) => { void connect(alias) }}
      />
    </section>
  )
}

/** The inline add/edit form: alias (locked while editing), target, port. */
function AddEditForm({ form, addBusy, t, onSubmit, onCancel }: {
  form: FormState
  addBusy: boolean
  t: Translate<RemoteKey>
  onSubmit: (draft: RemoteDraft) => Promise<AddEditResult>
  onCancel: () => void
}) {
  const [alias, setAlias] = useState(form.mode === 'edit' ? form.entry.id : '')
  const [target, setTarget] = useState(form.mode === 'edit' ? form.entry.target : '')
  const [port, setPort] = useState(form.mode === 'edit' ? String(form.entry.remotePort) : '3080')
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setError(null)
    const outcome = await onSubmit({ alias, target, remotePort: port === '' ? undefined : Number(port) })
    if (!outcome.ok) setError(outcome.message)
  }

  return (
    <form
      className={css.form}
      aria-label={form.mode === 'edit' ? t('form.editing', { alias }) : t('form.add')}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label className={css.formField}>
        <span>{t('form.alias')}</span>
        <input value={alias} required disabled={form.mode === 'edit'} onChange={(event) => { setAlias(event.target.value) }} />
      </label>
      <label className={css.formField}>
        <span>{t('form.target')}</span>
        <input value={target} required placeholder="user@host" onChange={(event) => { setTarget(event.target.value) }} />
      </label>
      <label className={css.formField}>
        <span>{t('form.port')}</span>
        <input value={port} required type="number" min={1} max={65535} onChange={(event) => { setPort(event.target.value) }} />
      </label>
      {error !== null && <p className={css.formError} role="alert">{t('form.error', { message: error })}</p>}
      <div className={css.formActions}>
        <button type="submit" className={css.formSave} disabled={addBusy}>{t('form.save')}</button>
        <button type="button" onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </form>
  )
}
