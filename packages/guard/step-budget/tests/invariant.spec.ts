import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import * as StepBudgetInvariant from '@shres-code/shres-code-step-budget/invariant'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'

/**
 * The stop record's relationship to the loop's turn stream: it belongs to the
 * turn it ends, once, one step past a positive budget.
 */

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(StepBudgetInvariant)
  return ctx
}

describe('step-budget stream invariants', () => {
  it('accepts a stop inside the turn it ends', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-budget'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
      session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    }).not.toThrow()
  })

  it('rejects a stop outside any open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-budget'))
    expect(() => {
      session.append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
    }).toThrow(/INVARIANT|step-budget/)
    expect(session.seq).toBe(0)
  })

  it('rejects a stop naming a different turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-budget'))
    session.append('turn/start', { turn: 2 })
    expect(() => {
      session.append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
    }).toThrow(/the open turn is 2/)
  })

  it('rejects a second stop in one turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-budget'))
    session.append('turn/start', { turn: 1 })
    session.append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
    expect(() => {
      session.append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
    }).toThrow(/second stop/)
  })

  it('clears the one-stop rule at the next turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-budget'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('step-budget/exhausted', { turn: 1, step: 2, limit: 1 }, { ignorable: true })
      session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
      session.append('turn/start', { turn: 2 })
      session.append('step-budget/exhausted', { turn: 2, step: 2, limit: 1 }, { ignorable: true })
    }).not.toThrow()
  })

  it.each([
    [{ turn: 1, step: 3, limit: 0 }, /expected an integer >= 1/],
    [{ turn: 1, step: 3, limit: 1.5 }, /expected an integer >= 1/],
    [{ turn: 1, step: 9, limit: 2 }, /expected 3/],
  ])('rejects a malformed stop payload', async (data, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-budget'))
    session.append('turn/start', { turn: 1 })
    expect(() => {
      session.append('step-budget/exhausted', data, { ignorable: true })
    }).toThrow(message)
  })

  it('rejects a violating stop already in a loaded log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('ws-budget'))
      .append('step-budget/exhausted', { turn: 1, step: 3, limit: 2 }, { ignorable: true })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(StepBudgetInvariant).then(() => undefined)).rejects.toThrow(/the open turn is undefined/)
  })

  it('ignores unrelated session events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-unrelated'))
    expect(() => { session.append('todo/write', { todos: [] }) }).not.toThrow()
  })
})
