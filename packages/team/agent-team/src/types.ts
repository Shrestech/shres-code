/**
 * Durable Agent Team records, log-only session events, and the
 * `team-message` model source. Runtime-free so client aggregates can import
 * the projection key without dragging host Cordis merges.
 *
 * @module @shres-code/shres-code-agent-team/types
 */

import type { ContentBlock } from '@shres-code/shres-code-llm'
import type { SessionId } from '@shres-code/shres-code-session/types'
import type { TeamId, TeamMessageId, TeamTaskId } from './brand.ts'

export type { TeamId, TeamMessageId, TeamTaskId } from './brand.ts'

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/**
 * Source retained by the target Session for durable mailbox de-duplication.
 * Delivery writes this on an ordinary `user/message` in the TARGET session;
 * the Lead log never reconstructs the model-visible content.
 */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderSessionId: SessionId
  readonly senderName: string
}

declare module '@shres-code/shres-code-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Whole teammate lifecycle value, stored only in the Team Lead Session. */
export interface TeamMemberEvent {
  readonly teamId: TeamId
  readonly member: TeamMemberSnapshot
}

/** Whole shared-task value, stored only in the Team Lead Session. */
export interface TeamTaskEvent {
  readonly teamId: TeamId
  readonly task: TeamTaskSnapshot
}

/** Durable mailbox enqueue, stored before delivery is attempted. */
export interface TeamMessageQueuedEvent {
  readonly teamId: TeamId
  readonly message: TeamMessageSnapshot
}

/** Durable acknowledgement that the target Session recorded the message. */
export interface TeamMessageDeliveredEvent {
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly targetId: SessionId
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Whole teammate lifecycle value, stored only in the Team Lead Session.
     * Latest snapshot for a member id wins. A name is reserved permanently
     * and a failed provisioning keeps its row. Log-only. Writers pass
     * `{ ignorable: true }`.
     * @param teamId - implicit Team identity, the Lead Session id under a distinct brand.
     * @param member - complete post-change teammate snapshot.
     */
    'team/member': TeamMemberEvent
    /**
     * Whole shared-task value, stored only in the Team Lead Session. Latest
     * snapshot for a task id wins. Log-only. Writers pass `{ ignorable: true }`.
     * @param teamId - implicit Team identity.
     * @param task - complete post-change task snapshot.
     */
    'team/task': TeamTaskEvent
    /**
     * Durable mailbox enqueue, stored before delivery is attempted. Log-only.
     * Writers pass `{ ignorable: true }`.
     * @param teamId - implicit Team identity.
     * @param message - complete queued peer-message snapshot.
     */
    'team/message/queued': TeamMessageQueuedEvent
    /**
     * Durable acknowledgement that the target Session recorded the message.
     * Log-only. Writers pass `{ ignorable: true }`.
     * @param teamId - implicit Team identity.
     * @param messageId - queued message identity being acknowledged.
     * @param targetId - Session that durably recorded the message.
     */
    'team/message/delivered': TeamMessageDeliveredEvent
  }
}

/** Current Team state selected by durable Team identity. */
export interface TeamState {
  readonly id: TeamId
  readonly members: TeamMemberSnapshot[]
  readonly tasks: TeamTaskSnapshot[]
  readonly messages: TeamMessageSnapshot[]
  readonly delivered: TeamMessageId[]
  readonly nextTaskNumber: number
}

/**
 * The `agentTeam` projection value: every Team whose events appear in this
 * Session log, keyed by `teamId`. A Lead Session's own Team is
 * `projection[session.id]`. Inherited fork-seed events retain their ancestor
 * id and occupy a different key, so they never become the new root's Team.
 * The unit cannot read `session.id` from `init`/`apply`/`view`, so callers
 * select by identity after the snapshot.
 */
export type AgentTeamProjection = Record<string, TeamState>

declare module '@shres-code/shres-code-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Roster, task board, and queued-minus-delivered mailbox for every Team
     * whose events appear in this Session log, keyed by `teamId`. Select the
     * projected Session's own Team with `values.agentTeam?.[session.id]`.
     */
    agentTeam: AgentTeamProjection
  }
}
