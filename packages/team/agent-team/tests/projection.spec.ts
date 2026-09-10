import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import * as AgentTeamPlugin from '../src/index.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/brand.ts'
import { CHILD, ROOT, TEAM, event, member, message, task } from './helpers.ts'

async function harness(withPlugin: boolean) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPlugin) await ctx.plugin(AgentTeamPlugin)
  return { ctx, session: ctx.sessions.create(ROOT) }
}

describe('agentTeam projection unit', () => {
  it('serves an empty map on the empty log and isolates inherited ancestor records', async () => {
    const { ctx, session } = await harness(true)
    expect(ctx.sessionProjections.snapshot(session).values.agentTeam).toEqual({})
    session.append('team/member', { teamId: TeamId('ancestor'), member: member() }, { ignorable: true })
    const values = ctx.sessionProjections.snapshot(session).values.agentTeam
    expect(values?.[String(ROOT)]).toBeUndefined()
    expect(values?.ancestor).toMatchObject({ id: TeamId('ancestor'), members: [{ name: 'worker-a' }] })
  })

  it('folds native Team events under the Lead identity and notifies the change feed', async () => {
    const { ctx, session } = await harness(true)
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    const first = session.append('team/member', { teamId: TEAM, member: member() }, { ignorable: true })
    session.append('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, { ignorable: true })
    session.append('team/task', { teamId: TEAM, task: task() }, { ignorable: true })
    session.append('team/message/queued', { teamId: TEAM, message: message() }, { ignorable: true })
    const delivered = session.append('team/message/delivered', {
      teamId: TEAM,
      messageId: TeamMessageId('message-1'),
      targetId: CHILD,
    }, { ignorable: true })
    const own = ctx.sessionProjections.snapshot(session).values.agentTeam?.[String(ROOT)]
    expect(own).toMatchObject({
      id: TEAM,
      members: [{ id: CHILD, phase: 'active' }],
      tasks: [{ id: 'task-1', revision: 1 }],
      delivered: ['message-1'],
      nextTaskNumber: 2,
    })
    const firstView = changes[0]?.value as { [id: string]: { members: { phase: string }[] } } | undefined
    expect(changes[0]?.key).toBe('agentTeam')
    expect(changes[0]?.seq).toBe(first.seq)
    expect(firstView?.[String(ROOT)]?.members[0]?.phase).toBe('provisioning')
    expect(changes.at(-1)?.seq).toBe(delivered.seq)
  })

  it('returns the same reference for unrelated events', () => {
    const empty = teamProjectionDefinition.init()
    expect(teamProjectionDefinition.apply(empty, {
      type: 'turn/start',
      seq: 0,
      time: 0,
      data: { turn: 1 },
    })).toBe(empty)
    const inherited = teamProjectionDefinition.apply(empty, event('team/member', {
      teamId: TeamId('ancestor'),
      member: member(),
    }, 0))
    expect(teamProjectionDefinition.view(inherited).ancestor).toMatchObject({ id: TeamId('ancestor') })
    const native = teamProjectionDefinition.apply(inherited, event('team/member', {
      teamId: TEAM,
      member: member(),
    }, 1))
    expect(native.ancestor).toEqual(inherited.ancestor)
    expect(native[String(ROOT)]).toMatchObject({ id: TEAM })
    expect(teamProjectionDefinition.apply(empty, {
      type: 'team/member',
      seq: 0,
      time: 0,
      ignorable: true,
      data: { member: member() },
    } as never)).toBe(empty)
  })

  it('rebrands blockedBy ids in the projection view', () => {
    let state = teamProjectionDefinition.init()
    state = teamProjectionDefinition.apply(state, event('team/task', { teamId: TEAM, task: task() }, 0))
    state = teamProjectionDefinition.apply(state, event('team/task', {
      teamId: TEAM,
      task: task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1')],
      }),
    }, 1))
    expect(teamProjectionDefinition.view(state)[String(ROOT)]?.tasks[1]?.blockedBy).toEqual(['task-1'])
  })

  it('has no agentTeam key without the plugin, and drops it when the plugin unloads', async () => {
    const { ctx, session } = await harness(false)
    expect('agentTeam' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(AgentTeamPlugin)
    session.append('team/member', { teamId: TEAM, member: member() }, { ignorable: true })
    expect(ctx.sessionProjections.snapshot(session).values.agentTeam?.[String(ROOT)])
      .toMatchObject({ id: TEAM, members: [{ name: 'worker-a' }] })
    await fiber.dispose()
    expect('agentTeam' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('folds events already in the log when the plugin mounts late', async () => {
    const { ctx, session } = await harness(false)
    session.append('team/member', { teamId: TEAM, member: member() }, { ignorable: true })
    await ctx.plugin(AgentTeamPlugin)
    expect(ctx.sessionProjections.snapshot(session).values.agentTeam?.[String(ROOT)])
      .toMatchObject({ members: [{ phase: 'provisioning' }] })
  })

  it('keeps last-good native state after a malformed native payload', () => {
    let state = teamProjectionDefinition.init()
    state = teamProjectionDefinition.apply(state, event('team/member', { teamId: TEAM, member: member() }, 0))
    state = teamProjectionDefinition.apply(state, {
      ...event('team/task', { teamId: TEAM, task: task() }, 1),
      data: { teamId: TEAM, task: { ...task(), subject: 42 } },
    } as never)
    expect(state[String(ROOT)]?.fault).toMatch(/invalid/)
    expect(state[String(ROOT)]?.members).toHaveLength(1)
  })

  it('rejects invalid deployment limits at plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await expect(ctx.plugin(AgentTeamPlugin, {
      maxMembers: 1.5,
    })).rejects.toThrow(/maxMembers/)
    const resolved = AgentTeamPlugin.resolveConfig({
      maxMembers: 8,
      maxTasks: 256,
      maxPendingMessagesPerMember: 64,
      maxMessageBytes: 65_536,
      disposalTimeoutMs: 5_000,
    })
    expect(resolved.maxMembers).toBe(8)
    expect(() => AgentTeamPlugin.resolveConfig({
      maxMembers: 0,
      maxTasks: 256,
      maxPendingMessagesPerMember: 64,
      maxMessageBytes: 65_536,
      disposalTimeoutMs: 5_000,
    })).toThrow(/maxMembers/)
  })

  it('does not treat a forked Session as owning the ancestor Team', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentTeamPlugin)
    const child = ctx.sessions.create(SessionId('fork-child'))
    child.append('team/member', { teamId: TEAM, member: member() }, { ignorable: true })
    const values = ctx.sessionProjections.snapshot(child).values.agentTeam
    expect(values?.['fork-child']).toBeUndefined()
    expect(values?.[String(ROOT)]).toMatchObject({ id: TEAM })
  })
})
