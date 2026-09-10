import { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@shres-code/shres-code-session'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/brand.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/types.ts'

export const ROOT = SessionId('team-root')
export const TEAM = TeamId(ROOT)
export const CHILD = SessionId('child-a')

export function event<T extends Extract<SessionEventType, `team/${string}`>>(
  type: T,
  data: SessionEventMap[T],
  seq: number,
): SessionEvent<T> {
  return { type, data, seq, time: seq, ignorable: true } as SessionEvent<T>
}

export function member(overrides: Partial<TeamMemberSnapshot> = {}): TeamMemberSnapshot {
  return {
    id: CHILD,
    name: 'worker-a',
    description: 'worker',
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
    ...overrides,
  }
}

export function task(overrides: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return {
    id: TeamTaskId('task-1'),
    revision: 1,
    subject: 'subject',
    description: 'description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

export function message(overrides: Partial<TeamMessageSnapshot> = {}): TeamMessageSnapshot {
  return {
    id: TeamMessageId('message-1'),
    senderId: ROOT,
    senderName: 'lead',
    targetId: CHILD,
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  }
}
