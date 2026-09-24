/** Activity inspector Team action: loads the roster view and reloads when the panel opens. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@shres-code/shres-code-client-runtime/client'
import type { AgentTeamsMemberRow, AgentTeamsRoster } from '@shres-code/shres-code-api-remotes/client'
import type { RpcResponse } from '@shres-code/shres-code-api-remotes/client'
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

/** Full props for the session Activity contribution. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.activity'> & TeamActionInjected & PropsLocale<typeof NS>

/**
 * Unwrap one `agentTeams.view` RPC response. A failed call throws so the
 * panel can retry instead of treating the session as a non-Lead.
 * @param response - unary view result.
 * @returns the roster value.
 */
export function rosterFromView(response: RpcResponse<AgentTeamsRoster>): AgentTeamsRoster {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

/** Whether one roster row can navigate into a child conversation. */
function navigable(member: AgentTeamsMemberRow): boolean {
  return member.role === 'teammate'
    && member.id !== ''
    && !member.id.startsWith('unprovisioned:')
    && member.status !== 'failed'
    && member.status !== 'provisioning'
    && member.status !== 'unstarted'
}

/**
 * Format one row's LLM binding as `provider · model`, or the model alone
 * when the provider route is unknown.
 * @param agentProvider - the row's LLM provider route, when known.
 * @param model - the row's LLM model.
 * @returns the display text.
 */
function modelBinding(agentProvider: string | undefined, model: string): string {
  return agentProvider === undefined ? model : `${agentProvider} · ${model}`
}

/**
 * Render the Team trigger for live Team Leads, and a retry control when the
 * first roster read fails. Opening the panel reloads `agentTeams.view`.
 * @param props - session runtime props, injected face, and localized copy.
 * @returns the action, or null while the first load is in flight or off a Team Lead.
 */
export function TeamAction({ sessionId, load, openTeammate, t }: TeamActionProps): ReactNode {
  const [roster, setRoster] = useState<AgentTeamsRoster | undefined>(undefined)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const generationRef = useRef(0)

  const refresh = (): Promise<void> => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const requested = sessionRef.current
    return loadRef.current(requested).then(
      (view) => {
        if (generation !== generationRef.current) return
        setRoster(view)
        setError(false)
      },
      () => {
        if (generation !== generationRef.current) return
        setError(true)
      },
    )
  }

  useEffect(() => {
    generationRef.current += 1
    setRoster(undefined)
    setError(false)
    setOpen(false)
    void refresh()
    return () => {
      generationRef.current += 1
    }
  }, [sessionId])

  const visible = roster?.isTeam === true || (error && roster === undefined)
  if (!visible) return null
  return (
    <div className={css.action}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => {
            if (!value) void refresh()
            return !value
          })
        }}
      >
        {t('teamAction')}
      </button>
      {open
        ? (
          <div className={css.panel} role="dialog" aria-label={t('teamPanelTitle')}>
            <p className={css.panelTitle}>{t('teamPanelTitle')}</p>
            {error
              ? (
                <div className={css.errorRow}>
                  <p className={css.diagnostic}>{t('teamLoadFailed')}</p>
                  <button
                    type="button"
                    className={css.open}
                    onClick={() => {
                      void refresh()
                    }}
                  >
                    {t('teamRetry')}
                  </button>
                </div>
              )
              : null}
            {roster?.isTeam !== true
              ? null
              : roster.members.length === 0
                ? <p className={css.empty}>{t('teamEmpty')}</p>
                : (
                  <ul className={css.rows}>
                    {roster.members.map(member => (
                      <li key={member.role === 'lead' ? 'lead' : member.id} className={css.row}>
                        <span className={css.name}>{member.name}</span>
                        <span className={css.status}>{member.status}</span>
                        {member.model === undefined
                          ? null
                          : <span className={css.model}>{modelBinding(member.agentProvider, member.model)}</span>}
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
