/**
 * Agent Team roster plugin, browser half: registers the Team header action
 * into the conversation header. The action loads the roster view on mount
 * and again when the panel opens, and renders only for live Team Leads;
 * teammate rows navigate through the stable addressed-subagent path.
 */
import type { ClientContext, SessionId } from '@shres-code/shres-code-client-runtime/client'
import type { IApiClient } from '@shres-code/shres-code-api-remotes/client'
import type { AgentTeamsMemberRow } from '@shres-code/shres-code-api-remotes/client'
import type {} from '@shres-code/shres-code-client-locale/client'
import { rosterFromView, TeamAction, type TeamActionInjected } from './TeamAction.tsx'
import { en, NS, type TeamKey } from './locales.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Team roster panel copy. */
    'agent-team': TeamKey
  }
}

export type { TeamActionInjected, TeamActionProps } from './TeamAction.tsx'

/** Required services for the roster RPC, conversation slots, and session navigation. */
export const inject = ['slots', 'locale', 'sessions', 'connection']

/**
 * Client plugin body: register the Team header action once the conversation
 * header slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-agent-team: dictionaries')
  const sessions = ctx.sessions
  const connection = ctx.get('connection') as { api: IApiClient }
  const teamInjected = (): TeamActionInjected => ({
    load: async (sessionId) => {
      const response = await connection.api.agentTeams.view({ sessionId })
      return rosterFromView(response)
    },
    openTeammate(parentSessionId: SessionId, member: AgentTeamsMemberRow) {
      void sessions.refreshSubagents(parentSessionId)
      sessions.openSubagent({ parentSessionId, childSessionId: member.id as SessionId, mode: 'continuable' })
    },
  })
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: 12,
      locale: NS,
      inject: teamInjected,
    }, TeamAction),
  )
}
