import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import * as AgentTeamInvariant from '../src/invariant.ts'
import InvariantRegistry, { InvariantError } from '@shres-code/shres-code-invariants'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import { ROOT, TEAM, member, task } from './helpers.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(AgentTeamInvariant)
  return ctx
}

describe('Agent Team stream invariants', () => {
  it('accepts canonical native Team events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(ROOT)
    expect(() => {
      session.append('team/member', { teamId: TEAM, member: member() }, { ignorable: true })
      session.append('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, { ignorable: true })
      session.append('team/task', { teamId: TEAM, task: task() }, { ignorable: true })
    }).not.toThrow()
  })

  it('rejects an illegal native transition before the event is committed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(ROOT)
    session.append('team/member', { teamId: TEAM, member: member() }, { ignorable: true })
    expect(() => {
      session.append('team/member', { teamId: TEAM, member: member({ name: 'renamed', phase: 'active' }) }, { ignorable: true })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@shres-code/shres-code-agent-team',
    }))
    expect(session.seq).toBe(1)
  })

  it('rejects a malformed native payload on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(ROOT).append('team/member', {
      teamId: TEAM,
      member: { ...member(), name: 42 },
    } as never, { ignorable: true })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AgentTeamInvariant).then(() => undefined)).rejects.toThrow(/invalid/)
  })

  it('ignores unrelated session events and inherited ancestor records', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('unrelated'))
    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
    expect(() => {
      session.append('team/member', { teamId: TEAM, member: member({ phase: 'active' }) }, { ignorable: true })
    }).not.toThrow()
  })
})
