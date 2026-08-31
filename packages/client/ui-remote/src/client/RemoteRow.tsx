/**
 * One remote row: alias, target, live status dot, and the kebab actions
 * (open in new tab, edit, remove-with-confirm). Row click starts the connect
 * flow (inspect → trust modal); the remove confirmation and its refusal/error
 * message are component-local state per the three-channel rule.
 */
import { useState } from 'react'
import {
  IconEllipsisOutline16, IconEditOutline16, IconRightUpOutline14, IconTrashOutline16, Menu,
} from '@shres-code/shres-code-client-ui-primitives'
import type { Translate } from '@shres-code/shres-code-client-ui-slots'
import type { RemoteEntryView, TunnelStateView } from '@shres-code/shres-code-api-remotes/client'
import css from './RemoteRow.module.css'
import type { RemoteKey } from './locales.ts'
import type { RemoveResult } from './store.ts'

/** Status-dot fill per tunnel state; closed stays neutral. */
const STATE_COLOR: Record<TunnelStateView['state'], string> = {
  closed: 'closed',
  connecting: 'connecting',
  open: 'open',
  error: 'error',
}

/** Copy key per tunnel state (title/aria of the dot). */
const STATE_TEXT: Record<TunnelStateView['state'], RemoteKey> = {
  closed: 'status.closed',
  connecting: 'status.connecting',
  open: 'status.open',
  error: 'status.error',
}

/** Row props. */
export type RemoteRowProps = {
  /** The registry entry this row renders. */
  entry: RemoteEntryView
  /** The alias's last committed tunnel state; undefined before the first read. */
  tunnel: TunnelStateView | undefined
  /** True while this alias has a connect in flight. */
  busy: boolean
  /** Namespace translate seat. */
  t: Translate<RemoteKey>
  /** Start the connect flow (inspect → trust modal). */
  onConnect: (alias: string) => void
  /** Open the inline form over this entry. */
  onEdit: (alias: string) => void
  /** Run the granted removal. */
  onRemove: (alias: string) => Promise<RemoveResult>
  /** Open the tunneled origin in a new tab. */
  onOpenTab: (localPort: number) => void
}

/**
 * Render one remote row.
 * @param props - entry, tunnel state, and the four actions.
 * @returns the row element.
 */
export function RemoteRow({ entry, tunnel, busy, t, onConnect, onEdit, onRemove, onOpenTab }: RemoteRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const [removeNote, setRemoveNote] = useState<string | null>(null)
  const state = tunnel?.state ?? 'closed'
  const localPort = tunnel?.localPort ?? null

  const runRemove = async (): Promise<void> => {
    setRemoveNote(null)
    const result = await onRemove(entry.id)
    if (result.ok) {
      setArmed(false)
      return
    }
    setRemoveNote(result.kind === 'connected'
      ? t('row.remove.refused', { alias: entry.id })
      : t('form.error', { message: result.message }))
  }

  return (
    <div className={css.row}>
      <button
        type="button"
        className={css.main}
        aria-label={t('row.connect.aria', { alias: entry.id })}
        onClick={() => { onConnect(entry.id) }}
      >
        <span className={css.dot} data-state={STATE_COLOR[state]} title={t(STATE_TEXT[state])} aria-label={t(STATE_TEXT[state])} />
        <span className={css.alias}>{entry.id}</span>
        <span className={css.target}>{entry.target}</span>
        {busy && <span className={css.busy} aria-hidden="true" />}
      </button>
      <Menu
        open={menuOpen}
        onClose={() => { setMenuOpen(false) }}
        portal
        anchor={(
          <button
            type="button"
            className={css.kebab}
            aria-label={t('row.menu.aria', { alias: entry.id })}
            onClick={() => { setMenuOpen(open => !open) }}
          >
            <IconEllipsisOutline16 size={16} />
          </button>
        )}
        items={[
          { id: 'open', label: t('row.menu.open'), icon: <IconRightUpOutline14 size={14} />, disabled: localPort === null },
          { id: 'edit', label: t('row.menu.edit'), icon: <IconEditOutline16 size={16} /> },
          { id: 'remove', label: t('row.menu.remove'), icon: <IconTrashOutline16 size={16} />, danger: true },
        ]}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'open' && localPort !== null) onOpenTab(localPort)
          if (id === 'edit') onEdit(entry.id)
          if (id === 'remove') {
            setArmed(true)
            setRemoveNote(null)
          }
        }}
      />
      {armed && (
        <div className={css.confirm} role="alertdialog" aria-label={t('row.remove.confirm', { alias: entry.id })}>
          <span>{t('row.remove.confirm', { alias: entry.id })}</span>
          <button type="button" className={css.confirmYes} onClick={() => { void runRemove() }}>{t('row.remove.yes')}</button>
          <button type="button" onClick={() => { setArmed(false); setRemoveNote(null) }}>{t('row.remove.cancel')}</button>
        </div>
      )}
      {removeNote !== null && <div className={css.note} role="alert">{removeNote}</div>}
    </div>
  )
}
