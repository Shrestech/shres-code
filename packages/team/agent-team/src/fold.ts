/**
 * Pure replay fold for Agent Team log events.
 *
 * Native events (`teamId` equals the fold owner) apply in log order. Inherited
 * fork-seed events from another Team retain their ancestor id and never enter
 * the new root's state. A malformed native payload, an illegal lifecycle
 * transition, or a graph violation records `fault` and keeps the last good
 * native snapshot; later native events are ignored until the log is repaired.
 *
 * @module @shres-code/shres-code-agent-team/fold
 */

import { assertNever } from '@shres-code/shres-code-llm'
import type { ContentBlock } from '@shres-code/shres-code-llm'
import type { SessionEvent, SessionId } from '@shres-code/shres-code-session'
import { TeamId as toTeamId, TeamMessageId as toTeamMessageId, TeamTaskId as toTeamTaskId } from './brand.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import type {
  TeamId,
  TeamMemberPhase,
  TeamMemberSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamState,
  TeamTaskSnapshot,
  TeamTaskStatus,
} from './types.ts'

/** Whether one event belongs to the Team domain. */
export type TeamEventType =
  | 'team/member'
  | 'team/task'
  | 'team/message/queued'
  | 'team/message/delivered'

/** One event owned by the Team domain. */
export type TeamSessionEvent = SessionEvent<TeamEventType>

/** Mutable accumulator kept private to the fold. */
export interface TeamFoldState {
  readonly id: TeamId
  members: TeamMemberSnapshot[]
  tasks: TeamTaskSnapshot[]
  messages: TeamMessageSnapshot[]
  delivered: TeamMessageId[]
  nextTaskNumber: number
  fault: string | undefined
}

const NUMERIC_TASK_ID = /^task-(\d+)$/u
const MEMBER_PHASES: ReadonlySet<TeamMemberPhase> = new Set(['provisioning', 'active', 'failed'])
const TASK_STATUSES: ReadonlySet<TeamTaskStatus> = new Set(['pending', 'in_progress', 'completed', 'deleted'])
const MEMBER_CONTEXTS: ReadonlySet<TeamMemberSnapshot['context']> = new Set(['fresh', 'fork'])
const CORE_CONTENT_BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result', 'server-tool-call'])
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Test whether a Session event belongs to the Team domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Team-owned type.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member'
    || event.type === 'team/task'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/delivered'
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity, branded as the Team id.
 * @returns mutable empty Team fold state.
 */
export function emptyTeamFoldState(rootId: SessionId | TeamId): TeamFoldState {
  return {
    id: toTeamId(rootId),
    members: [],
    tasks: [],
    messages: [],
    delivered: [],
    nextTaskNumber: 1,
    fault: undefined,
  }
}

/**
 * Detach the current native Team records from a fold accumulator.
 * @param state - fold accumulator.
 * @returns a JSON-safe snapshot of native Team state.
 */
export function teamStateFromFold(state: TeamFoldState): TeamState {
  return {
    id: state.id,
    members: state.members.map(cloneMember),
    tasks: state.tasks.map(cloneTask),
    messages: state.messages.map(cloneMessage),
    delivered: [...state.delivered],
    nextTaskNumber: state.nextTaskNumber,
  }
}

/**
 * Replay one Session log into the Team owned by `rootId`.
 * @param rootId - projected Session identity selecting native Team records.
 * @param events - committed Session events in log order.
 * @returns native Team state, or `null` when no native Team event applied.
 */
export function foldTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamState | null {
  const state = emptyTeamFoldState(rootId)
  for (const event of events) applyTeamEvent(state, event)
  if (state.fault === undefined
    && state.members.length === 0
    && state.tasks.length === 0
    && state.messages.length === 0
    && state.delivered.length === 0) {
    return null
  }
  return teamStateFromFold(state)
}

/**
 * Apply one committed event through the strict Team decoder.
 * @param state - mutable fold accumulator for one Team identity.
 * @param event - next committed Session event.
 * @returns whether the event selected this Team identity.
 */
export function applyTeamEvent(state: TeamFoldState, event: SessionEvent): boolean {
  if (state.fault !== undefined) return false
  if (!isTeamEvent(event)) return false
  try {
    const teamId = decodeTeamId(event.data)
    if (teamId !== state.id) return false
    applyNativeTeamEvent(state, event)
    return true
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team decoder throws Error instances */
    state.fault = error instanceof Error ? error.message : String(error)
    return true
  }
}

function applyNativeTeamEvent(state: TeamFoldState, event: TeamSessionEvent): void {
  switch (event.type) {
    case 'team/member': {
      const member = decodeMember(event.data.member)
      const index = state.members.findIndex(candidate => candidate.id === member.id)
      const prior = state.members[index]
      const named = state.members.find(candidate => candidate.name === member.name)
      if (named !== undefined && named.id !== member.id) {
        throw new Error(`teammate name "${member.name}" is reused by another member`)
      }
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
      } else {
        if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      if (index < 0) state.members.push(member)
      else state.members[index] = member
      return
    }
    case 'team/task': {
      const task = decodeTask(event.data.task)
      const index = state.tasks.findIndex(candidate => candidate.id === task.id)
      const prior = state.tasks[index]
      if (prior === undefined && task.revision !== 1) {
        throw new Error(`team task "${task.id}" must begin at revision 1`)
      }
      if (prior !== undefined && task.revision !== prior.revision + 1) {
        throw new Error(`team task "${task.id}" revision is not contiguous`)
      }
      assertTaskGraphCandidate(state.tasks, task)
      const match = NUMERIC_TASK_ID.exec(task.id)
      if (match !== null) {
        const number = Number(match[1])
        state.nextTaskNumber = Math.max(
          state.nextTaskNumber,
          number === Number.MAX_SAFE_INTEGER ? number : number + 1,
        )
      }
      if (index < 0) state.tasks.push(task)
      else state.tasks[index] = task
      return
    }
    case 'team/message/queued': {
      const message = decodeMessage(event.data.message)
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      state.messages.push(message)
      return
    }
    case 'team/message/delivered': {
      const payload = event.data
      const messageId = decodeNonEmptyString(payload.messageId, 'messageId')
      const targetId = decodeNonEmptyString(payload.targetId, 'targetId') as SessionId
      const queued = state.messages.find(message => message.id === messageId)
      if (queued === undefined) throw new Error(`team message "${messageId}" was delivered before queueing`)
      if (queued.targetId !== targetId) throw new Error(`team message "${messageId}" target changed`)
      if (state.delivered.includes(toTeamMessageId(messageId))) {
        throw new Error(`team message "${messageId}" was delivered twice`)
      }
      state.delivered.push(toTeamMessageId(messageId))
      return
    }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above */
    default: {
      const exhaustive: never = event
      return assertNever(exhaustive, 'TeamEventType')
    }
  }
}

function decodeTeamId(data: unknown): TeamId {
  if (!isRecord(data)) throw new Error('persisted Agent Teams payload is invalid')
  return toTeamId(decodeNonEmptyString(data['teamId'], 'teamId'))
}

function decodeMember(value: unknown): TeamMemberSnapshot {
  if (!isRecord(value)) throw new Error('persisted Agent Teams team/member payload is invalid')
  const phase = value['phase']
  const context = value['context']
  if (typeof phase !== 'string' || !MEMBER_PHASES.has(phase as TeamMemberPhase)) {
    throw new Error('persisted Agent Teams team/member payload is invalid')
  }
  if (typeof context !== 'string' || !MEMBER_CONTEXTS.has(context as TeamMemberSnapshot['context'])) {
    throw new Error('persisted Agent Teams team/member payload is invalid')
  }
  const member: TeamMemberSnapshot = {
    id: decodeNonEmptyString(value['id'], 'member.id') as SessionId,
    name: decodeString(value['name'], 'member.name'),
    description: decodeString(value['description'], 'member.description'),
    provider: decodeString(value['provider'], 'member.provider'),
    context: context as TeamMemberSnapshot['context'],
    phase: phase as TeamMemberPhase,
    ...value['error'] === undefined ? {} : { error: decodeString(value['error'], 'member.error') },
    ...value['agentProvider'] === undefined
      ? {}
      : { agentProvider: decodeNonEmptyString(value['agentProvider'], 'member.agentProvider') },
    ...value['agentModel'] === undefined
      ? {}
      : { agentModel: decodeNonEmptyString(value['agentModel'], 'member.agentModel') },
  }
  if (member.phase !== 'active' && (member.agentProvider !== undefined || member.agentModel !== undefined)) {
    throw new Error(`teammate "${member.name}" records an agent route outside the active phase`)
  }
  return member
}

function decodeTask(value: unknown): TeamTaskSnapshot {
  if (!isRecord(value)) throw new Error('persisted Agent Teams team/task payload is invalid')
  const status = value['status']
  if (typeof status !== 'string' || !TASK_STATUSES.has(status as TeamTaskStatus)) {
    throw new Error('persisted Agent Teams team/task payload is invalid')
  }
  const id = decodeNonEmptyString(value['id'], 'task.id')
  const match = NUMERIC_TASK_ID.exec(id)
  if (match !== null && !Number.isSafeInteger(Number(match[1]))) {
    throw new Error('numeric task id suffix must be a safe integer')
  }
  const blockedBy = decodeStringArray(value['blockedBy'], 'task.blockedBy').map(item => toTeamTaskId(item))
  const task: TeamTaskSnapshot = {
    id: toTeamTaskId(id),
    revision: positiveInteger(value['revision'], 'task.revision'),
    subject: decodeString(value['subject'], 'task.subject'),
    description: decodeString(value['description'], 'task.description'),
    status: status as TeamTaskStatus,
    blockedBy,
    writeScopes: decodeStringArray(value['writeScopes'], 'task.writeScopes'),
    ...value['ownerId'] === undefined ? {} : { ownerId: decodeNonEmptyString(value['ownerId'], 'task.ownerId') as SessionId },
  }
  return task
}

function decodeMessage(value: unknown): TeamMessageSnapshot {
  if (!isRecord(value)) throw new Error('persisted Agent Teams team/message/queued payload is invalid')
  if (!Array.isArray(value['content'])) {
    throw new Error('persisted Agent Teams team/message/queued payload is invalid')
  }
  return {
    id: toTeamMessageId(decodeNonEmptyString(value['id'], 'message.id')),
    senderId: decodeNonEmptyString(value['senderId'], 'message.senderId') as SessionId,
    senderName: decodeString(value['senderName'], 'message.senderName'),
    targetId: decodeNonEmptyString(value['targetId'], 'message.targetId') as SessionId,
    content: value['content'].map((block, index) => decodeContentBlock(block, index)),
  }
}

function decodeContentBlock(value: unknown, index: number): ContentBlock {
  if (!isRecord(value) || typeof value['type'] !== 'string' || value['type'].length === 0) {
    throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
  }
  const type = value['type']
  if (!CORE_CONTENT_BLOCK_TYPES.has(type)) return value as unknown as ContentBlock
  switch (type) {
    case 'text':
    case 'reasoning':
      if (typeof value['text'] !== 'string') {
        throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
      }
      return value as unknown as ContentBlock
    case 'image':
      if (!isRecord(value['attachment'])) {
        throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
      }
      decodeImageAttachment(value['attachment'], index)
      return value as unknown as ContentBlock
    case 'tool-call':
      if (typeof value['id'] !== 'string' || value['id'].length === 0
        || typeof value['name'] !== 'string'
        || typeof value['arguments'] !== 'string') {
        throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
      }
      return value as unknown as ContentBlock
    case 'tool-result':
      if (typeof value['toolCallId'] !== 'string' || value['toolCallId'].length === 0
        || !Array.isArray(value['content'])) {
        throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
      }
      value['content'].forEach((block, nested) => decodeContentBlock(block, nested))
      return value as unknown as ContentBlock
    case 'server-tool-call':
      if (typeof value['kind'] !== 'string'
        || (value['status'] !== undefined && value['status'] !== 'completed' && value['status'] !== 'failed')) {
        throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
      }
      return value as unknown as ContentBlock
    /* v8 ignore next 2 -- CORE_CONTENT_BLOCK_TYPES is closed and every member is handled above. */
    default:
      return assertNever(type as never, 'core content block')
  }
}

function decodeImageAttachment(value: Record<string, unknown>, index: number): void {
  if (typeof value['attachmentId'] !== 'string' || value['attachmentId'].length === 0
    || typeof value['mediaType'] !== 'string' || !IMAGE_MEDIA_TYPES.has(value['mediaType'])
    || typeof value['bytes'] !== 'number' || !Number.isSafeInteger(value['bytes']) || value['bytes'] < 0
    || typeof value['width'] !== 'number' || !Number.isSafeInteger(value['width']) || value['width'] < 1
    || typeof value['height'] !== 'number' || !Number.isSafeInteger(value['height']) || value['height'] < 1) {
    throw new Error(`persisted Agent Teams message content[${String(index)}] is invalid`)
  }
}

function cloneMember(member: TeamMemberSnapshot): TeamMemberSnapshot {
  return {
    ...member,
    ...member.error === undefined ? {} : { error: member.error },
  }
}

function cloneTask(task: TeamTaskSnapshot): TeamTaskSnapshot {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ...task.ownerId === undefined ? {} : { ownerId: task.ownerId },
  }
}

function cloneMessage(message: TeamMessageSnapshot): TeamMessageSnapshot {
  return {
    ...message,
    content: message.content.map(block => structuredClone(block)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`persisted Agent Teams ${field} is invalid`)
  return value
}

function decodeNonEmptyString(value: unknown, field: string): string {
  const text = decodeString(value, field)
  if (text.length === 0) throw new Error(`persisted Agent Teams ${field} is invalid`)
  return text
}

function decodeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`persisted Agent Teams ${field} is invalid`)
  }
  return value as string[]
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`persisted Agent Teams ${field} is invalid`)
  }
  return value
}
