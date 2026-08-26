import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import SessionProjectionRegistry from '@shres-code/shres-code-session-projection'
import JspaceService, { applyJspaceProjection } from '../src/index.ts'
import type { JspaceProjection } from '../src/types.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JspaceService, { enabled: true })
  const session = ctx.sessions.create(SessionId('ws-proj'))
  return { ctx, session }
}

describe('jspace projection unit', () => {
  it('starts empty, then last-wins on card and close', async () => {
    const { ctx, session } = await harness()
    expect(ctx.sessionProjections.snapshot(session).values.jspace).toEqual({
      card: null,
      closed: false,
    })
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    const open = ctx.sessionProjections.snapshot(session).values.jspace as JspaceProjection
    expect(open.card?.goal).toBe('A')
    expect(open.closed).toBe(false)
    ctx.jspace.close(session)
    const closed = ctx.sessionProjections.snapshot(session).values.jspace as JspaceProjection
    expect(closed.card).toBeNull()
    expect(closed.closed).toBe(true)
  })

  it('keeps the last good projection when apply sees a malformed event', () => {
    const prior: JspaceProjection = {
      card: {
        seq: 1,
        sessionId: 'ws-proj',
        goal: 'A',
        core: [],
        checked: [],
        open: [],
        next: 'B',
        goalOpenedSeq: 1,
        charter: [],
      },
      closed: false,
    }
    const next = applyJspaceProjection(prior, {
      type: 'jspace/card',
      seq: 1,
      time: 0,
      data: { seq: 2, sessionId: 'ws-proj' },
    } as never)
    expect(next.card?.goal).toBe('A')
    expect(next.fault).toMatch(/must be/)
    expect(applyJspaceProjection(prior, {
      type: 'turn/start',
      seq: 0,
      time: 0,
      data: { turn: 1 },
    })).toBe(prior)
    expect(applyJspaceProjection(prior, {
      type: 'jspace/closed',
      seq: 2,
      time: 0,
      data: { seq: 2, sessionId: 'ws-proj' },
    })).toEqual({ card: null, closed: true })
    expect(applyJspaceProjection(prior, {
      type: 'jspace/closed',
      seq: 2,
      time: 0,
      data: { seq: 'bad', sessionId: 'ws-proj' },
    } as never).fault).toMatch(/positive/)
  })
})
