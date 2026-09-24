/**
 * Durable Agent Team records, log-only session events, and the
 * `team-message` model source. Runtime-free so client aggregates can import
 * the projection key without dragging host Cordis merges.
 *
 * @module @shres-code/shres-code-agent-team/types
 */

import type { ContentBlock, MessageSource } from '@shres-code/shres-code-llm'
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
  /** Subagent spawn provider that created the child, such as `spawn`; not the LLM provider. */
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
  /**
   * LLM provider route the child was created with, as recorded in its
   * subagent descriptor. Written only on the `active` edge; absent on older
   * logs and when no route resolved.
   */
  readonly agentProvider?: string
  /**
   * LLM model the child was created with and cold-resumes on, as recorded in
   * its subagent descriptor. Written only on the `active` edge; absent on
   * older logs and when no route resolved.
   */
  readonly agentModel?: string
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
  readonly content: readonly ContentBlock[]
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
  /** Replay fault recorded by the fold; a faulted Team freezes at its last good snapshot. */
  readonly fault?: string
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

/**
 * Roster liveness for one {@link TeamMemberView} row. Distinct from
 * `list_agents` residency (`running` / `idle` / `ready`) and from durable
 * {@link TeamMemberPhase}.
 *
 * `unstarted` is a reserved template name with no session. `inactive` is a
 * started member whose Agent is not loaded. `idle` is a loaded Agent between
 * turns.
 */
export type TeamMemberStatus =
  | 'running'
  | 'idle'
  | 'unstarted'
  | 'inactive'
  | 'provisioning'
  | 'failed'

/**
 * Current runtime-enriched roster row.
 *
 * `agentProvider` / `model` are the row's own LLM route. The loaded Lead
 * reports its latest logged request header, else the live default-model
 * selection, else its creation options. A loaded teammate reports its latest
 * logged request header, else its creation options, which are the descriptor
 * route it was created or resumed with. An unloaded started teammate reports
 * its {@link TeamMemberSnapshot} route. An `unstarted` row reports the current
 * template binding. A row whose route is unknown omits both fields and never
 * reports the Lead's route instead. A `/model` switch appears after the
 * switched Agent's next request.
 */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: TeamMemberStatus
  readonly description?: string
  /** Subagent spawn provider that starts or started the teammate, such as `spawn`; not the LLM provider. Absent on the Lead row. */
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  /** LLM provider route. */
  readonly agentProvider?: string
  /** LLM model. */
  readonly model?: string
  readonly diagnostics: string[]
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: readonly ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: AbortSignal
  readonly persona?: string
  /**
   * Optional teammate workspace. Becomes the child's session cwd on first
   * provision. Whitespace is omitted; a non-empty value must be an enterable
   * absolute directory.
   */
  readonly cwd?: string
  /**
   * Durable source for the child's initial inbox message. Omitted is an
   * ordinary user prompt.
   */
  readonly source?: MessageSource
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: readonly ContentBlock[]
  readonly signal: AbortSignal
  /**
   * Lead-sent role for first provision. Shadows the child's `deployment:persona`.
   * Tool guidance, team policy, and the working-directory line stay. Ignored
   * after the teammate is active.
   */
  readonly persona?: string
  /**
   * Optional teammate workspace for first provision. Becomes the child's
   * session cwd and AGENTS.md root. Whitespace is omitted. A non-empty value
   * after the teammate is active is rejected.
   */
  readonly cwd?: string
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/**
 * Human-configured teammate that can be lazily provisioned. The template is
 * read when an `unstarted` name starts; a started teammate keeps the route it
 * was created with.
 */
export interface TeamRosterTemplateEntry {
  readonly name: string
  readonly description: string
  readonly persona?: string
  /** LLM provider route; applied together with {@link model}. */
  readonly provider: string
  /** LLM model; without it the teammate inherits the Lead's route when it starts. */
  readonly model?: string
  readonly context?: 'fresh' | 'fork'
}

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
