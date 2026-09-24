/**
 * Browser-safe Agent Teams domain contract: a read-only roster view for the
 * chat surface. The exact live Lead session authorizes the read; a session
 * that is not a live Team Lead views an empty roster.
 */

import type { SessionId } from '@shres-code/shres-code-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One roster row as the chat-header panel renders it. */
export interface AgentTeamsMemberRow {
  /** Model-facing teammate name; the Lead row is `lead`. */
  name: string
  role: 'lead' | 'teammate'
  status: 'running' | 'idle' | 'unstarted' | 'inactive' | 'provisioning' | 'failed'
  /** Durable child Session id; empty for the Lead row and unprovisioned template rows. */
  id: string
  description?: string
  /** Subagent spawn provider, such as `spawn`; not the LLM provider. */
  provider?: string
  /** LLM provider route the member runs or resumes on; absent when unknown. */
  agentProvider?: string
  /** LLM model the member runs or resumes on; absent when unknown, never the Lead's model as a stand-in. */
  model?: string
  /** Durable provisioning failure diagnostics. */
  diagnostics: string[]
}

/** Roster view for one session. */
export interface AgentTeamsRoster {
  sessionId: SessionId
  /** Whether the session resolves to a live Team Lead; false views carry an empty roster. */
  isTeam: boolean
  members: AgentTeamsMemberRow[]
}

/** Agent-Teams-domain unary methods. */
export interface AgentTeamsApi {
  /**
   * Read the roster of the Team rooted at one attached session. A session
   * that is not a live Team Lead reports `isTeam: false` with no members.
   */
  view(
    request: RpcRequest<{ sessionId: SessionId }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<AgentTeamsRoster>>
}
