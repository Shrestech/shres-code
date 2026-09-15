/** Chat-header Team action: loads the roster view once and renders the panel. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@shres-code/shres-code-client-runtime/client'
import type { AgentTeamsMemberRow, AgentTeamsRoster } from '@shres-code/shres-code-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
import { NS } from './locales.ts'
import css from './TeamAction.module.css'

/** Business actions supplied by the slot registration. */
export interface TeamActionInjected {
  /** Read the Team roster for one session from the host view RPC. */
  load: (sessionId: SessionId) => Promise<AgentTeamsRoster>
  /** Open one teammate's conversation through the addressed-subagent path. */
  openTeammate: (parentSessionId: SessionId, member: AgentTeamsMemberRow) => void
}

/** Full props for the session-header Team action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

/** Whether one roster row can navigate into a child conversation. */
function navigable(member: AgentTeamsMemberRow): boolean {
  return member.role === 'teammate'
    && member.id !== ''
    && !member.id.startsWith('unprovisioned:')
    && member.status !== 'failed'
    && member.status !== 'provisioning'
}

/**
 * Render the Team trigger only for sessions that are live Team Leads; the
 * panel lists the roster and navigates into teammates.
 * @param props - session runtime props, injected face, and localized copy.
 * @returns the action, or null while loading or off a Team Lead.
 */
export function TeamAction({ sessionId, load, openTeammate, t }: TeamActionProps): ReactNode {
  const [roster, setRoster] = useState<AgentTeamsRoster | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let cancelled = false
    setRoster(undefined)
    loadRef.current(sessionId)
      .then((view) => {
        if (!cancelled) setRoster(view)
      })
      .catch(() => {
        if (!cancelled) setRoster({ sessionId, isTeam: false, members: [] })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])
  if (roster === undefined || !roster.isTeam) return null
  return (
    <div className={css.action}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(value => !value)
        }}
      >
        {t('teamAction')}
      </button>
      {open
        ? (
          <div className={css.panel} role="dialog" aria-label={t('teamPanelTitle')}>
            <p className={css.panelTitle}>{t('teamPanelTitle')}</p>
            {roster.members.length === 0
              ? <p className={css.empty}>{t('teamEmpty')}</p>
              : (
                <ul className={css.rows}>
                  {roster.members.map(member => (
                    <li key={member.role === 'lead' ? 'lead' : member.id} className={css.row}>
                      <span className={css.name}>{member.name}</span>
                      <span className={css.status}>{member.status}</span>
                      {member.model === undefined ? null : <span className={css.model}>{member.model}</span>}
                      {navigable(member)
                        ? (
                          <button
                            type="button"
                            className={css.open}
                            onClick={() => {
                              openTeammate(sessionId, member)
                              setOpen(false)
                            }}
                          >
                            {t('teamOpenConversation')}
                          </button>
                        )
                        : null}
                      {member.diagnostics.length === 0
                        ? null
                        : <p className={css.diagnostic}>{member.diagnostics.join('; ')}</p>}
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )
        : null}
    </div>
  )
}
