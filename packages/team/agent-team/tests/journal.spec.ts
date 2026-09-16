import { describe, expect, it } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import SessionStore from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import { TeamError } from '../src/error.ts'
import { TeamJournal } from '../src/journal.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { AgentTeamProjection, TeamState } from '../src/types.ts'
import { ROOT, TEAM, event, member } from './helpers.ts'

async function setup(options: { flush?: 'ok' | 'reject' | 'none' } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const order: string[] = []
  if (options.flush === 'ok') {
    ctx.on('session/flush', async (session) => {
      order.push(`flush:${session.id}`)
    })
  } else if (options.flush === 'reject') {
    ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
  }
  const session = ctx.sessions.create(ROOT)
  return { ctx, session, journal: new TeamJournal(ctx), order }
}

describe('TeamJournal', () => {
  it('appends an ignorable Team event and waits for the durability barrier', async () => {
    const { session, journal, order } = await setup({ flush: 'ok' })
    await journal.appendAndFlush(session, 'team/member', { teamId: TEAM, member: member() })
    expect(session.events[0]).toMatchObject({
      type: 'team/member',
      ignorable: true,
      data: { teamId: TEAM, member: { name: 'worker-a' } },
    })
    expect(order).toEqual([`flush:${session.id}`])
  })

  it('serializes per-team transactions and still runs the next after a rejection', async () => {
    const { journal } = await setup({ flush: 'ok' })
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = journal.transact(ROOT, async () => {
      seen.push('first-start')
      await gate
      seen.push('first-end')
      return 1
    })
    const second = journal.transact(ROOT, async () => {
      seen.push('second')
      return 2
    })
    await Promise.resolve()
    expect(seen).toEqual(['first-start'])
    release()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(seen).toEqual(['first-start', 'first-end', 'second'])

    await expect(journal.transact(ROOT, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(journal.transact(ROOT, async () => 'recovered')).resolves.toBe('recovered')
  })

  it('fails when no persistence listener participates', async () => {
    const { session, journal } = await setup({ flush: 'none' })
    await expect(journal.appendAndFlush(session, 'team/member', {
      teamId: TEAM,
      member: member(),
    })).rejects.toMatchObject({
      name: 'TeamError',
      code: 'TEAM_PERSISTENCE_FAILED',
    } satisfies Partial<TeamError>)
    expect(session.events).toHaveLength(1)
  })

  it('wraps a rejecting flush as TEAM_PERSISTENCE_FAILED', async () => {
    const { session, journal } = await setup({ flush: 'reject' })
    await expect(journal.flush(session)).rejects.toBeInstanceOf(TeamError)
  })

  it('fails loud when the agentTeam projection unit is not registered', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(ROOT)
    const journal = new TeamJournal(ctx)
    expect(() => journal.state({ id: ROOT, session } as Agent)).toThrow(/not registered/)
    await ctx.fiber.dispose()
  })

  /** Service stub providing one fixed projection snapshot. */
  class FaultedProjections extends Service {
    constructor(ctx: Context, private readonly faulted: AgentTeamProjection) {
      super(ctx, 'sessionProjections')
    }

    snapshot(): { values: { agentTeam: AgentTeamProjection } } {
      return { values: { agentTeam: this.faulted } }
    }
  }

  it('fails loud with TEAM_LOG_FAULT when replay recorded a fault', async () => {
    const seeded = member()
    // The write-side invariant rejects illegal transitions, so drive the
    // projection definition directly to reproduce a log written without it.
    const faulted = teamProjectionDefinition.apply({}, event('team/member', {
      teamId: TEAM,
      member: { ...seeded, name: 'worker-b', phase: 'active' },
    }, 1))
    expect(teamProjectionDefinition.view(faulted)[String(TEAM)]?.fault).toBeTypeOf('string')
    const ctx = new Context()
    await ctx.plugin(FaultedProjections, faulted as unknown as AgentTeamProjection)
    const journal = new TeamJournal(ctx)
    const state = (): TeamState => journal.state({ id: ROOT, session: {} as never } as unknown as Agent)
    expect(state).toThrow(TeamError)
    let caught: unknown
    try {
      state()
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ name: 'TeamError', code: 'TEAM_LOG_FAULT' } satisfies Partial<TeamError>)
  })
})
