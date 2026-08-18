import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import * as JspaceInvariant from '@shres-code/shres-code-jspace/invariant'
import InvariantRegistry, { InvariantError } from '@shres-code/shres-code-invariants'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { JspaceCard } from '../src/types.ts'

const card: JspaceCard = {
  seq: 1,
  sessionId: 'ws-invariant',
  goal: 'check the stream',
  core: [],
  checked: [],
  open: [],
  next: 'write a test',
  goalOpenedSeq: 1,
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(JspaceInvariant)
  return ctx
}

describe('jspace stream invariants', () => {
  it('accepts a canonical card and close', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-invariant'))
    expect(() => {
      session.append('jspace/card', card, { ignorable: true })
      session.append('jspace/closed', { seq: 2, sessionId: 'ws-invariant' }, { ignorable: true })
    }).not.toThrow()
  })

  it('rejects a regressing seq before the event is committed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-invariant'))
    session.append('jspace/card', card, { ignorable: true })
    expect(() => {
      session.append('jspace/card', { ...card, next: 'clobber' }, { ignorable: true })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@shres-code/shres-code-jspace',
    }))
    expect(session.seq).toBe(1)
  })

  it('rejects a malformed card on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('ws-invariant')).append('jspace/card', {
      seq: 1,
      sessionId: 'ws-invariant',
    } as never, { ignorable: true })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(JspaceInvariant).then(() => undefined)).rejects.toThrow(/must be/)
  })

  it('ignores unrelated session events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ws-unrelated'))
    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
  })
})
