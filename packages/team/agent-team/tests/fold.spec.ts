import { describe, expect, it } from 'vitest'
import { SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/brand.ts'
import { applyTeamEvent, emptyTeamFoldState, foldTeam, isTeamEvent, teamStateFromFold } from '../src/fold.ts'
import { CHILD, ROOT, TEAM, event, member, message, task } from './helpers.ts'
import type { TeamState } from '../src/types.ts'

function pending(state: TeamState) {
  return state.messages.filter(item => !state.delivered.includes(item.id))
}

describe('Agent Team fold', () => {
  it('returns null for a log with no native Team records', () => {
    expect(foldTeam(ROOT, [])).toBeNull()
    expect(foldTeam(ROOT, [
      event('team/member', { teamId: TeamId('ancestor'), member: member() }, 0),
    ])).toBeNull()
    expect(isTeamEvent({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })).toBe(false)
  })

  it('projects native records independently from inherited records', () => {
    const state = foldTeam(ROOT, [
      event('team/member', { teamId: TeamId('ancestor'), member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member() }, 1),
      event('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, 2),
      event('team/task', { teamId: TEAM, task: task({ id: TeamTaskId('task-7') }) }, 3),
      event('team/message/queued', { teamId: TEAM, message: message() }, 4),
    ])
    expect(state).toMatchObject({ id: TEAM })
    expect(state?.members).toHaveLength(1)
    expect(state?.tasks).toHaveLength(1)
    expect(state && pending(state)).toHaveLength(1)
    expect(state?.nextTaskNumber).toBe(8)
    expect(state?.members.find(row => row.id === CHILD)?.name).toBe('worker-a')
  })

  it('enforces teammate identity and lifecycle', () => {
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, 0),
    ])).toThrow(/must begin provisioning/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member({ name: 'renamed', phase: 'active' }) }, 1),
    ])).toThrow(/immutable identity/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, 1),
      event('team/member', { teamId: TEAM, member: member({ phase: 'failed' }) }, 2),
    ])).toThrow(/invalid active -> failed/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member({ id: SessionId('child-b') }) }, 1),
    ])).toThrow(/name .* reused/)
  })

  it('keeps the agent route recorded on the active edge and omits it on older rows', () => {
    const routed = foldTeam(ROOT, [
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', {
        teamId: TEAM,
        member: member({ phase: 'active', agentProvider: 'child-llm', agentModel: 'child-model' }),
      }, 1),
    ])
    expect(routed?.members[0]).toMatchObject({ agentProvider: 'child-llm', agentModel: 'child-model' })
    const legacy = foldTeam(ROOT, [
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, 1),
    ])
    expect(legacy?.members[0]).not.toHaveProperty('agentProvider')
    expect(legacy?.members[0]).not.toHaveProperty('agentModel')
  })

  it('rejects a malformed agent route or one recorded outside the active edge', () => {
    for (const [route, pattern] of [
      [{ agentModel: '' }, /member\.agentModel is invalid/],
      [{ agentProvider: 7 }, /member\.agentProvider is invalid/],
      [{ agentModel: null }, /member\.agentModel is invalid/],
    ] as const) {
      expect(() => teamStateFromThrow([
        event('team/member', { teamId: TEAM, member: member() }, 0),
        event('team/member', { teamId: TEAM, member: { ...member({ phase: 'active' }), ...route } as never }, 1),
      ])).toThrow(pattern)
    }
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member({ agentModel: 'early' }) }, 0),
    ])).toThrow(/agent route outside the active phase/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member({ phase: 'failed', agentProvider: 'late' }) }, 1),
    ])).toThrow(/agent route outside the active phase/)
  })

  it('keeps a failed provisioning row and reserves its name', () => {
    const state = foldTeam(ROOT, [
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', {
        teamId: TEAM,
        member: member({ phase: 'failed', error: 'provider refused' }),
      }, 1),
    ])
    expect(state?.members[0]).toMatchObject({ phase: 'failed', error: 'provider refused' })
    const later = emptyTeamFoldState(ROOT)
    for (const record of [
      event('team/member', { teamId: TEAM, member: member() }, 0),
      event('team/member', { teamId: TEAM, member: member({ phase: 'failed' }) }, 1),
      event('team/member', { teamId: TEAM, member: member({ id: SessionId('child-b') }) }, 2),
    ]) applyTeamEvent(later, record)
    expect(later.fault).toMatch(/name .* reused/)
  })

  it('enforces task revision continuity and graph relations', () => {
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ revision: 2 }) }, 0),
    ])).toThrow(/begin at revision 1/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task() }, 0),
      event('team/task', { teamId: TEAM, task: task({ revision: 3 }) }, 1),
    ])).toThrow(/revision is not contiguous/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ blockedBy: [TeamTaskId('missing')] }) }, 0),
    ])).toThrow(/missing or deleted/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ blockedBy: [TeamTaskId('task-1')] }) }, 0),
    ])).toThrow(/cannot block itself/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task() }, 0),
      event('team/task', {
        teamId: TEAM,
        task: task({
          id: TeamTaskId('task-2'),
          blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')],
        }),
      }, 1),
    ])).toThrow(/repeats blocker/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task() }, 0),
      event('team/task', {
        teamId: TEAM,
        task: task({ id: TeamTaskId('task-2'), blockedBy: [TeamTaskId('task-1')] }),
      }, 1),
      event('team/task', { teamId: TEAM, task: task({ revision: 2, blockedBy: [TeamTaskId('task-2')] }) }, 2),
    ])).toThrow(/dependency cycle/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task() }, 0),
      event('team/task', {
        teamId: TEAM,
        task: task({ id: TeamTaskId('task-2'), blockedBy: [TeamTaskId('task-1')] }),
      }, 1),
      event('team/task', { teamId: TEAM, task: task({ revision: 2, status: 'deleted' }) }, 2),
    ])).toThrow(/missing or deleted/)
  })

  it('leaves numeric allocation unchanged for a branded nonstandard task id', () => {
    const state = foldTeam(ROOT, [
      event('team/task', { teamId: TEAM, task: task({ id: TeamTaskId('external-task') }) }, 0),
    ])
    expect(state?.nextTaskNumber).toBe(1)
  })

  it('caps nextTaskNumber at Number.MAX_SAFE_INTEGER', () => {
    const state = foldTeam(ROOT, [
      event('team/task', {
        teamId: TEAM,
        task: task({ id: TeamTaskId(`task-${String(Number.MAX_SAFE_INTEGER)}`) }),
      }, 0),
    ])
    expect(state?.nextTaskNumber).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('replaces a prior task snapshot on a contiguous revision', () => {
    const state = foldTeam(ROOT, [
      event('team/task', { teamId: TEAM, task: task() }, 0),
      event('team/task', { teamId: TEAM, task: task({ revision: 2, status: 'in_progress', ownerId: CHILD }) }, 1),
    ])
    expect(state?.tasks).toEqual([
      expect.objectContaining({ revision: 2, status: 'in_progress', ownerId: CHILD }),
    ])
  })

  it('ignores non-Team events and empty identity strings', () => {
    const fold = emptyTeamFoldState(ROOT)
    expect(applyTeamEvent(fold, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })).toBe(false)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member({ id: SessionId('') }) }, 0),
    ])).toThrow(/member.id/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member({ phase: 'unknown' as never }) }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ revision: 0 }) }, 0),
    ])).toThrow(/revision/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: '' } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: 'image' } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
  })

  it('rejects a persisted numeric task id outside the safe integer range', () => {
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ id: TeamTaskId('task-9007199254740992') }) }, 0),
    ])).toThrow(/safe integer/)
  })

  it('enforces mailbox queue and acknowledgement relations', () => {
    const queued = event('team/message/queued', { teamId: TEAM, message: message() }, 0)
    const delivered = event('team/message/delivered', {
      teamId: TEAM,
      messageId: TeamMessageId('message-1'),
      targetId: CHILD,
    }, 1)
    expect(pending(foldTeam(ROOT, [queued, delivered])!)).toEqual([])
    expect(() => teamStateFromThrow([queued, queued])).toThrow(/queued twice/)
    expect(() => teamStateFromThrow([delivered])).toThrow(/delivered before queueing/)
    expect(() => teamStateFromThrow([queued, event('team/message/delivered', {
      teamId: TEAM,
      messageId: TeamMessageId('message-1'),
      targetId: SessionId('other'),
    }, 1)])).toThrow(/target changed/)
    expect(() => teamStateFromThrow([queued, delivered, { ...delivered, seq: 2 }])).toThrow(/delivered twice/)
  })

  it('validates persisted payloads and retains plugin content blocks', () => {
    expect(() => teamStateFromThrow([
      { ...event('team/member', { teamId: TEAM, member: member() }, 0), data: { teamId: TEAM, member: { ...member(), name: 42 } } } as unknown as SessionEvent,
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      { ...event('team/task', { teamId: TEAM, task: task() }, 0), data: { teamId: TEAM, task: { ...task(), blockedBy: [42] } } } as unknown as SessionEvent,
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      {
        ...event('team/message/queued', { teamId: TEAM, message: message() }, 0),
        data: { teamId: TEAM, message: { ...message(), content: [{ type: 'text', text: 42 }] } },
      } as unknown as SessionEvent,
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      {
        ...event('team/message/delivered', {
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: CHILD,
        }, 0),
        data: { teamId: TEAM, messageId: TeamMessageId('message-1'), targetId: 42 },
      } as unknown as SessionEvent,
    ])).toThrow(/invalid/)
    const extension = { type: 'plugin/custom', payload: { value: 1 } } as never
    const image = {
      type: 'image' as const,
      attachment: {
        attachmentId: 'att-1' as never,
        mediaType: 'image/png' as const,
        bytes: 4,
        width: 1,
        height: 1,
      },
    }
    const toolCall = { type: 'tool-call' as const, id: 'call-1' as never, name: 'echo', arguments: '{}' }
    const toolResult = {
      type: 'tool-result' as const,
      toolCallId: 'call-1' as never,
      content: [{ type: 'text' as const, text: 'ok' }],
    }
    const serverTool = { type: 'server-tool-call' as const, kind: 'web_search', status: 'completed' as const }
    const unreported = { type: 'server-tool-call' as const, kind: 'x_search', name: 'x_keyword_search' }
    const reasoning = { type: 'reasoning' as const, text: 'think' }
    const state = foldTeam(ROOT, [
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [extension, image, toolCall, toolResult, serverTool, unreported, reasoning] }),
      }, 0),
    ])
    expect(pending(state!)[0]?.content).toEqual([extension, image, toolCall, toolResult, serverTool, unreported, reasoning])
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: 'image', attachment: { attachmentId: '' } } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: 'tool-call', id: '', name: 'x', arguments: '{}' } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: 'tool-result', toolCallId: 'c', content: 'nope' } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: 'server-tool-call', kind: 'web_search', status: 'nope' } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', {
        teamId: TEAM,
        message: message({ content: [{ type: 'reasoning', text: 1 } as never] }),
      }, 0),
    ])).toThrow(/content\[0\]/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: member({ context: 'clone' as never }) }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ status: 'running' as never }) }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      { ...event('team/member', { teamId: TEAM, member: member() }, 0), data: 'nope' } as unknown as SessionEvent,
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/member', { teamId: TEAM, member: 'nope' as never }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: 'nope' as never }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', { teamId: TEAM, message: 'nope' as never }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/message/queued', { teamId: TEAM, message: message({ content: 'nope' as never }) }, 0),
    ])).toThrow(/invalid/)
    expect(() => teamStateFromThrow([
      event('team/task', { teamId: TEAM, task: task({ ownerId: SessionId('owner-1'), writeScopes: [1 as never] }) }, 0),
    ])).toThrow(/invalid/)
    const owned = foldTeam(ROOT, [
      event('team/task', { teamId: TEAM, task: task({ ownerId: SessionId('owner-1') }) }, 0),
    ])
    expect(owned?.tasks[0]?.ownerId).toBe('owner-1')
  })

  it('records a native fault and ignores later native events', () => {
    const state = emptyTeamFoldState(ROOT)
    applyTeamEvent(state, event('team/task', { teamId: TEAM, task: task({ revision: 2 }) }, 0))
    expect(state.fault).toMatch(/begin at revision 1/)
    applyTeamEvent(state, event('team/task', { teamId: TEAM, task: task() }, 1))
    expect(state.tasks).toEqual([])
    expect(teamStateFromFold(state).id).toBe(TEAM)
  })

  it('ignores malformed inherited records from another Team', () => {
    const inherited = {
      ...event('team/task', { teamId: TeamId('ancestor'), task: task() }, 0),
      data: { teamId: TeamId('ancestor'), task: { ...task(), subject: 42 } },
    } as unknown as SessionEvent
    expect(foldTeam(ROOT, [inherited])).toBeNull()
  })
})

function teamStateFromThrow(events: readonly SessionEvent[]): TeamState {
  const state = emptyTeamFoldState(ROOT)
  for (const record of events) applyTeamEvent(state, record)
  if (state.fault !== undefined) throw new Error(state.fault)
  const folded = foldTeam(ROOT, events)
  if (folded === null) throw new Error('expected native Team state')
  return folded
}
