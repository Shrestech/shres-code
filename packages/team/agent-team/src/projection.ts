/**
 * Host-only Team projection: a last-wins fold of Team events keyed by
 * `teamId`. The unit cannot read the projected Session id, so inherited
 * ancestor records occupy their own key and callers select
 * `values.agentTeam[session.id]`. A projection fold never throws; the
 * write-side invariant rejects illegal native transitions before commit
 * when the companion is mounted.
 *
 * @module @shres-code/shres-code-agent-team/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@shres-code/shres-code-session-projection'
import { TeamId as toTeamId, TeamMessageId as toTeamMessageId, TeamTaskId as toTeamTaskId } from './brand.ts'
import { applyTeamEvent, emptyTeamFoldState, teamStateFromFold } from './fold.ts'
import type { TeamFoldState } from './fold.ts'
import type { AgentTeamProjection, TeamState } from './types.ts'

const sessionIdSchema = z.string().min(1)
const teamIdSchema = z.string().min(1)
const teamTaskIdSchema = z.string().min(1)
const teamMessageIdSchema = z.string().min(1)

const teamMemberSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  phase: z.enum(['provisioning', 'active', 'failed']),
  error: z.string().optional(),
  agentProvider: z.string().min(1).optional(),
  agentModel: z.string().min(1).optional(),
}).strict()

const teamTaskSchema = z.object({
  id: teamTaskIdSchema,
  revision: z.number().int().positive(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
}).strict()

const teamMessageSchema = z.object({
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  content: z.array(z.object({ type: z.string().min(1) }).loose()),
}).strict()

const teamStateSchema = z.object({
  id: teamIdSchema,
  members: z.array(teamMemberSchema),
  tasks: z.array(teamTaskSchema),
  messages: z.array(teamMessageSchema),
  delivered: z.array(teamMessageIdSchema),
  nextTaskNumber: z.number().int().positive(),
  fault: z.string().optional(),
}).strict()

const agentTeamProjectionSchema = z.record(z.string(), teamStateSchema) as unknown as z.ZodType<AgentTeamProjection>

/** Checkpoint-safe per-Team fold retained under its durable identity. */
export interface TeamProjectionEntry {
  id: string
  members: TeamState['members']
  tasks: TeamState['tasks']
  messages: TeamState['messages']
  delivered: TeamState['delivered']
  nextTaskNumber: number
  fault?: string
}

/** Checkpoint-safe map of Team identities present in this Session log. */
export type TeamProjectionState = Record<string, TeamProjectionEntry>

function toFoldState(entry: TeamProjectionEntry): TeamFoldState {
  return {
    id: toTeamId(entry.id),
    members: entry.members,
    tasks: entry.tasks,
    messages: entry.messages,
    delivered: entry.delivered,
    nextTaskNumber: entry.nextTaskNumber,
    fault: entry.fault,
  }
}

function fromFoldState(fold: TeamFoldState): TeamProjectionEntry {
  const snapshot = teamStateFromFold(fold)
  return {
    id: snapshot.id,
    members: snapshot.members,
    tasks: snapshot.tasks,
    messages: snapshot.messages,
    delivered: snapshot.delivered,
    nextTaskNumber: snapshot.nextTaskNumber,
    ...fold.fault === undefined ? {} : { fault: fold.fault },
  }
}

function brandTeamState(entry: TeamProjectionEntry): TeamState {
  return {
    id: toTeamId(entry.id),
    members: entry.members,
    tasks: entry.tasks.map(task => ({
      ...task,
      id: toTeamTaskId(task.id),
      blockedBy: task.blockedBy.map(id => toTeamTaskId(id)),
    })),
    messages: entry.messages.map(message => ({
      ...message,
      id: toTeamMessageId(message.id),
    })),
    delivered: entry.delivered.map(id => toTeamMessageId(id)),
    nextTaskNumber: entry.nextTaskNumber,
    ...entry.fault === undefined ? {} : { fault: entry.fault },
  }
}

function viewProjection(state: TeamProjectionState): AgentTeamProjection {
  const view: AgentTeamProjection = {}
  for (const [id, entry] of Object.entries(state)) {
    view[id] = brandTeamState(entry)
  }
  return view
}

/** Host-only Team projection keyed by durable `teamId`. */
export const teamProjectionDefinition: ProjectionDefinition<'agentTeam', TeamProjectionState> = {
  key: 'agentTeam',
  schema: agentTeamProjectionSchema,
  init: () => ({}),
  apply: (state, event) => {
    if (event.type !== 'team/member'
      && event.type !== 'team/task'
      && event.type !== 'team/message/queued'
      && event.type !== 'team/message/delivered') {
      return state
    }
    const data = event.data as { teamId?: unknown }
    if (typeof data.teamId !== 'string' || data.teamId.length === 0) return state
    const current = state[data.teamId]
    const fold = current === undefined ? emptyTeamFoldState(toTeamId(data.teamId)) : toFoldState(current)
    applyTeamEvent(fold, event)
    return { ...state, [data.teamId]: fromFoldState(fold) }
  },
  view: viewProjection,
  stateVersion: 1,
}
