import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { Session, SessionId } from '@shres-code/shres-code-session'
import JspaceService, { JspaceError } from '../src/index.ts'

async function harness(config: ConstructorParameters<typeof JspaceService>[1] = { enabled: true }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JspaceService, config)
  const session = ctx.sessions.create(SessionId(`ws-${Math.random()}`))
  return { ctx, session }
}

describe('JspaceService remount', () => {
  it('stays inactive when enabled is false and writes nothing', async () => {
    const { ctx, session } = await harness({ enabled: false })
    expect(ctx.jspace.status).toEqual({ active: false, reason: 'disabled' })
    expect(() => ctx.jspace.open(session, { goal: 'x', next: 'y' })).toThrow(JspaceError)
    expect(session.events).toHaveLength(0)
  })

  it('publishes active when enabled is true', async () => {
    const { ctx } = await harness({ enabled: true })
    expect(ctx.jspace.status).toEqual({ active: true, reason: 'active' })
    expect(ctx.jspace.config.enabled).toBe(true)
  })

  it('snapshots open and closed counts without requiring the seat to be active', async () => {
    const { ctx, session } = await harness()
    expect(ctx.jspace.snapshot(session)).toMatchObject({
      cwd: null,
      open: false,
      closed: false,
      checkpoints: 0,
    })
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    ctx.jspace.checkpoint(session, { check: 'x', by: 'unit tests' })
    expect(ctx.jspace.snapshot(session)).toMatchObject({ open: true, closed: false, checkpoints: 1 })
    ctx.jspace.close(session)
    expect(ctx.jspace.snapshot(session)).toMatchObject({ open: false, closed: true, checkpoints: 0 })

    const withCwd = ctx.sessions.create(SessionId('ws-cwd'), { meta: { cwd: '/tmp/ws' } })
    expect(ctx.jspace.snapshot(withCwd).cwd).toBe('/tmp/ws')

    const faulted = Session.create(SessionId('ws-fault'))
    faulted.append('jspace/card', { seq: 1, sessionId: faulted.id } as never, { ignorable: true })
    expect(ctx.jspace.snapshot(faulted).fault).toMatch(/must be/)
  })

  it('notifies watchers when a settings service attaches as enabled', async () => {
    const { ctx } = await harness({ enabled: false })
    const seen: string[] = []
    const stop = ctx.jspace.watch((status) => { seen.push(status.reason) })
    await ctx.plugin({
      name: 'settings-stub',
      apply: (c: Context) => {
        c.provide('settings', {
          register: () => ({
            get: () => ({
              enabled: true,
              mode: 'available' as const,
              requireCoverage: true,
              coverageTerms: [],
              verifierTools: [],
              requireVerifiedEvidence: false,
            }),
            watch: () => () => {},
            update: async () => {},
            replace: async () => {},
          }),
        })
      },
    })
    expect(seen).toEqual(['active'])
    expect(ctx.jspace.status.active).toBe(true)
    stop()
  })
})

describe('JspaceService card log', () => {
  it('opens a card that replays from the session log', async () => {
    const { ctx, session } = await harness()
    const written = ctx.jspace.open(session, {
      goal: 'Ship J-Space',
      next: 'Write tests',
      core: ['seat'],
    })
    expect(written.seq).toBe(1)
    expect(written.goalOpenedSeq).toBe(session.events[0]?.seq)
    expect(session.events).toHaveLength(1)
    expect(session.events[0]?.type).toBe('jspace/card')
    expect(session.events[0]?.ignorable).toBe(true)
    expect(ctx.jspace.card(session)?.goal).toBe('Ship J-Space')

    const replayed = new Context()
    await replayed.plugin(SessionStore)
    await replayed.plugin(JspaceService, { enabled: true })
    const copy = replayed.sessions.create(SessionId('ws-replay'), { seed: session.events })
    expect(replayed.jspace.card(copy)?.next).toBe('Write tests')
  })

  it('rejects a second open and a core longer than two', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    expect(() => ctx.jspace.open(session, { goal: 'C', next: 'D' })).toThrow(/already open/)
    const { session: other } = await harness()
    expect(() => ctx.jspace.open(other, {
      goal: 'A',
      next: 'B',
      core: ['one', 'two', 'three'],
    })).toThrow(/at most two/)
  })

  it('swaps core only when the departing line is named', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B', core: ['old', 'keep'] })
    const { ctx: grow, session: emptyCore } = await harness()
    grow.jspace.open(emptyCore, { goal: 'A', next: 'B' })
    expect(grow.jspace.note(emptyCore, { core: 'first' }).core).toEqual(['first'])
    expect(() => ctx.jspace.note(session, { core: 'new' })).toThrow(/departing/)
    expect(() => ctx.jspace.note(session, { departing: 'missing', core: 'new' })).toThrow(/does not hold/)
    expect(() => ctx.jspace.note(session, { departing: 'old' })).toThrow(/departing/)
    const next = ctx.jspace.note(session, { departing: 'old', core: 'new', next: 'C' })
    expect(next.core).toEqual(['new', 'keep'])
    expect(next.next).toBe('C')
  })

  it('refuses a checkpoint without a coverage term and accepts one with evidence', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    expect(() => ctx.jspace.checkpoint(session, { check: 'done', by: 'I looked' })).toThrow(/coverage/)
    expect(() => ctx.jspace.checkpoint(session, {
      check: 'done',
      by: 'the community reviewed the latest notes',
    })).toThrow(/coverage claim: state in `by` who verified and what they covered/)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call-1'),
      name: 'read',
      arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const checked = ctx.jspace.checkpoint(session, {
      check: 'read the file',
      by: 'unit tests covering the fold',
      evidence: 'call-1',
    })
    expect(checked.checked).toEqual([
      { n: 1, check: 'read the file', by: 'unit tests covering the fold', evidence: 'call-1' },
    ])
    expect(checked.checked[0]?.verified).toBeUndefined()
    session.append('tool/call', {
      turn: 1,
      step: 2,
      callId: CallId('call-err'),
      name: 'bash',
      arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId: CallId('call-err'),
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      }),
    }, { surfaceOp: 'append' })
    expect(() => ctx.jspace.checkpoint(session, {
      check: 'ran the command',
      by: 'unit tests covering the fold',
      evidence: 'call-err',
    })).toThrow(/non-error tool call/)
    expect(() => ctx.jspace.checkpoint(session, {
      check: 'again',
      by: 'unit tests',
      evidence: 'missing',
    })).toThrow(/non-error tool call/)
  })

  it('accepts prose verifier-and-coverage claims without keyword scaffolding', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    const first = ctx.jspace.checkpoint(session, {
      check: 'defect status verified against source',
      by: 'direct source reads: git show d7eabfb diff; correlation.py lines 400-680; grep redeem across src',
    })
    expect(first.checked[0]?.by).toContain('direct source reads')
    const second = ctx.jspace.checkpoint(session, {
      check: 'gate chain verified',
      by: 'ox-alpha direct file reads + bash git-history scan covering roe.py and targets.py',
    })
    expect(second.checked).toHaveLength(2)
  })

  it('closes the card and copies it onto a fork', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    const child = ctx.sessions.fork(session, undefined, SessionId('ws-child'))
    expect(ctx.jspace.card(child)?.sessionId).toBe('ws-child')
    expect(ctx.jspace.card(child)?.seq).toBe(1)
    expect(ctx.jspace.card(child)?.goal).toBe('A')
    ctx.jspace.note(session, { next: 'parent-only' })
    expect(ctx.jspace.card(child)?.next).toBe('B')
    ctx.jspace.close(session)
    expect(ctx.jspace.card(session)).toBeNull()
    expect(ctx.jspace.fold(session).closed).toBe(true)
    expect(ctx.jspace.card(child)?.next).toBe('B')
  })

  it('does not copy on fork while disabled', async () => {
    const enabled = await harness({ enabled: true })
    enabled.ctx.jspace.open(enabled.session, { goal: 'A', next: 'B' })
    const disabled = new Context()
    await disabled.plugin(SessionStore)
    await disabled.plugin(JspaceService, { enabled: false })
    const parent = disabled.sessions.create(SessionId('ws-disabled-parent'), {
      seed: enabled.session.events,
    })
    const child = disabled.sessions.fork(parent, undefined, SessionId('ws-disabled-child'))
    expect(disabled.jspace.card(child)).toBeNull()
    expect(disabled.jspace.fold(child).inherited?.goal).toBe('A')
  })

  it('refuses a JSON-array packed into one Core, Checked, or Open line', async () => {
    const { ctx, session } = await harness()
    const packed = '["Zombie-goal root cause: a", "Fix (scoped): b"]'
    expect(() => ctx.jspace.open(session, { goal: 'A', next: 'B', core: [packed] })).toThrow(JspaceError)
    try {
      ctx.jspace.open(session, { goal: 'A', next: 'B', core: [packed] })
    } catch (error) {
      expect(error).toBeInstanceOf(JspaceError)
      expect((error as JspaceError).code).toBe('JSPACE_LINE_PACKED')
      expect((error as JspaceError).message).toBe(
        'jspace line must be one item per slot; Core holds at most 2 live items',
      )
    }
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    expect(() => ctx.jspace.note(session, { core: packed })).toThrow(/one item per slot/)
    expect(() => ctx.jspace.note(session, { open: [{ question: packed }] })).toThrow(/one item per slot/)
    expect(() => ctx.jspace.checkpoint(session, { check: packed, by: 'unit tests' })).toThrow(/one item per slot/)
    try {
      ctx.jspace.note(session, { open: [{ question: packed }] })
    } catch (error) {
      expect((error as JspaceError).code).toBe('JSPACE_LINE_PACKED')
    }
    try {
      ctx.jspace.checkpoint(session, { check: packed, by: 'unit tests' })
    } catch (error) {
      expect((error as JspaceError).code).toBe('JSPACE_LINE_PACKED')
    }
  })

  it('accepts a Core line that merely starts with [ and is not JSON', async () => {
    const { ctx, session } = await harness()
    const opened = ctx.jspace.open(session, {
      goal: 'A',
      next: 'B',
      core: ['[shield] fix the gate'],
    })
    expect(opened.core).toEqual(['[shield] fix the gate'])
    const noted = ctx.jspace.note(session, { core: '[guard] keep the hinge' })
    expect(noted.core).toEqual(['[shield] fix the gate', '[guard] keep the hinge'])
    expect(ctx.jspace.note(session, { open: [{ question: '[open] who owns the latch?' }] }).open)
      .toEqual([{ question: '[open] who owns the latch?' }])
    expect(ctx.jspace.checkpoint(session, {
      check: '[checked] latch holds',
      by: 'unit tests',
    }).checked[0]?.check).toBe('[checked] latch holds')
  })

  it('accepts a line that parses as a JSON object or string', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B', core: ['{"kind":"hint"}'] })
    expect(ctx.jspace.card(session)?.core).toEqual(['{"kind":"hint"}'])
    expect(ctx.jspace.note(session, { next: '"quoted next"' }).next).toBe('"quoted next"')
  })

  it('refuses a note that leaves Goal, Next, Core, and Open unchanged', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B', core: ['keep'] })
    ctx.jspace.note(session, { open: [{ question: 'Q', settles: 'S' }] })
    expect(() => ctx.jspace.note(session, {})).toThrow(JspaceError)
    try {
      ctx.jspace.note(session, { next: 'B', goal: 'A' })
    } catch (error) {
      expect(error).toBeInstanceOf(JspaceError)
      expect((error as JspaceError).code).toBe('JSPACE_NOTE_NOOP')
      expect((error as JspaceError).message).toBe(
        'the card already says this; proceed with the work or write a checkpoint',
      )
    }
    expect(() => ctx.jspace.note(session, {
      departing: 'keep',
      core: 'keep',
      open: [{ question: 'Q', settles: 'S' }],
    })).toThrow(/already says this/)
    const bounced = ctx.jspace.note(session, { next: 'C' })
    expect(bounced.next).toBe('C')
    expect(ctx.jspace.note(session, { next: 'B' }).next).toBe('B')
  })

  it('rejects a Goal identity change and allows same-goal note', async () => {
    const { ctx, session } = await harness()
    expect(() => ctx.jspace.note(session, { next: 'x' })).toThrow(/not open/)
    expect(() => ctx.jspace.checkpoint(session, { check: 'a', by: 'unit tests' })).toThrow(/not open/)
    expect(() => ctx.jspace.close(session)).toThrow(/not open/)
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    expect(() => ctx.jspace.note(session, { goal: '   ' })).toThrow(JspaceError)
    expect(() => ctx.jspace.note(session, { next: 'Goal: injected' })).toThrow(/card label/)
    expect(() => ctx.jspace.note(session, { next: 'two\nlines' })).toThrow(/single line/)
    ctx.jspace.close(session)
    const afterReopen = ctx.jspace.open(session, { goal: 'A', next: 'B' })
    expect(() => ctx.jspace.note(session, { goal: 'B-goal', open: [{ question: 'Q' }] })).toThrow(JspaceError)
    try {
      ctx.jspace.note(session, { goal: 'B-goal', open: [{ question: 'Q' }] })
    } catch (error) {
      expect(error).toBeInstanceOf(JspaceError)
      expect((error as JspaceError).code).toBe('JSPACE_NOTE_GOAL_CHANGE')
      expect((error as JspaceError).message).toContain('jspace_open')
    }
    const sameGoal = ctx.jspace.note(session, { goal: 'A', open: [{ question: 'Q' }] })
    expect(sameGoal.goalOpenedSeq).toBe(afterReopen.goalOpenedSeq)
    expect(sameGoal.open).toEqual([{ question: 'Q' }])
    expect(ctx.jspace.note(session, {
      open: [{ question: 'Q2', settles: 'S' }],
    }).open).toEqual([{ question: 'Q2', settles: 'S' }])
    expect(ctx.jspace.note(session, { next: 'later' }).next).toBe('later')
  })

  it('openGoal resets Core and Checked on a Goal epoch change and carries Open', async () => {
    const { ctx, session } = await harness()
    const opened = ctx.jspace.open(session, { goal: 'G1', next: 'B', core: ['one', 'two'] })
    ctx.jspace.checkpoint(session, { check: 'c1', by: 'unit tests' })
    ctx.jspace.checkpoint(session, { check: 'c2', by: 'unit tests' })
    const noted = ctx.jspace.note(session, { open: [{ question: 'Q' }] })
    const epoch = ctx.jspace.openGoal(session, { goal: 'D1', next: 'Start' })
    expect(epoch.goal).toBe('D1')
    expect(epoch.next).toBe('Start')
    expect(epoch.core).toEqual([])
    expect(epoch.checked).toEqual([])
    expect(epoch.open).toEqual([{ question: 'Q' }])
    expect(epoch.goalOpenedSeq).toBeGreaterThan(noted.goalOpenedSeq)
    expect(ctx.jspace.card(session)?.checked).toEqual([])
    const replay = new Context()
    await replay.plugin(SessionStore)
    await replay.plugin(JspaceService, { enabled: true })
    const copy = replay.sessions.create(SessionId('ws-reopen-replay'), { seed: session.events })
    expect(replay.jspace.card(copy)?.checked).toEqual([])
    expect(replay.jspace.card(copy)?.core).toEqual([])
    void opened
  })

  it('openGoal with the same Goal updates Goal and Next in place without resetting', async () => {
    const { ctx, session } = await harness()
    const opened = ctx.jspace.open(session, { goal: 'A', next: 'B', core: ['keep'] })
    ctx.jspace.checkpoint(session, { check: 'c1', by: 'unit tests' })
    const same = ctx.jspace.openGoal(session, { goal: 'A', next: 'C' })
    expect(same.goal).toBe('A')
    expect(same.next).toBe('C')
    expect(same.core).toEqual(['keep'])
    expect(same.checked).toHaveLength(1)
    expect(same.goalOpenedSeq).toBe(opened.goalOpenedSeq)
  })

  it('openGoal requires an active seat and an open card', async () => {
    const disabled = await harness({ enabled: false })
    expect(() => disabled.ctx.jspace.openGoal(disabled.session, { goal: 'A', next: 'B' }))
      .toThrow(/disabled/)
    const { ctx, session } = await harness()
    expect(() => ctx.jspace.openGoal(session, { goal: 'A', next: 'B' })).toThrow(/not open/)
  })

  it('marks a verifier citation evidence-grade and leaves ordinary evidence unmarked', async () => {
    const { ctx, session } = await harness({
      enabled: true,
      verifierTools: ['bash'],
    })
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call-bash'),
      name: 'bash',
      arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-bash'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1,
      step: 2,
      callId: CallId('call-read'),
      name: 'read',
      arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId: CallId('call-read'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const verified = ctx.jspace.checkpoint(session, {
      check: 'tests ran',
      by: 'unit tests covering the fold',
      evidence: 'call-bash',
    })
    expect(verified.checked[0]).toEqual({
      n: 1,
      check: 'tests ran',
      by: 'unit tests covering the fold',
      evidence: 'call-bash',
      verified: true,
    })
    const ordinary = ctx.jspace.checkpoint(session, {
      check: 'read the file',
      by: 'unit tests covering the fold',
      evidence: 'call-read',
    })
    expect(ordinary.checked[1]).toEqual({
      n: 2,
      check: 'read the file',
      by: 'unit tests covering the fold',
      evidence: 'call-read',
    })
    expect(() => ctx.jspace.checkpoint(session, {
      check: 'missing',
      by: 'unit tests covering the fold',
      evidence: 'call-absent',
    })).toThrow(/non-error tool call/)
  })

  it('does not mark evidence-grade when verifierTools is empty', async () => {
    const { ctx, session } = await harness({ enabled: true })
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call-bash'),
      name: 'bash',
      arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-bash'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const checked = ctx.jspace.checkpoint(session, {
      check: 'tests ran',
      by: 'unit tests covering the fold',
      evidence: 'call-bash',
    })
    expect(checked.checked[0]?.verified).toBeUndefined()
    expect(checked.checked[0]?.evidence).toBe('call-bash')
  })

  it('accepts a checkpoint without coverage when requireCoverage is false', async () => {
    const { ctx, session } = await harness({ enabled: true, requireCoverage: false })
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    const checked = ctx.jspace.checkpoint(session, { check: 'done', by: 'I looked' })
    expect(checked.checked[0]?.by).toBe('I looked')
  })

  it('matches extra coverage terms', async () => {
    const { ctx, session } = await harness({ enabled: true, coverageTerms: ['覆盖'] })
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    const checked = ctx.jspace.checkpoint(session, { check: '解析', by: '覆盖全部' })
    expect(checked.checked).toHaveLength(1)
    const second = ctx.jspace.checkpoint(session, { check: 'again', by: 'unit tests' })
    expect(second.checked.map(line => line.n)).toEqual([1, 2])
  })

  it('skips copy-on-fork when the child already has a native card', async () => {
    const { ctx } = await harness()
    const nativeId = SessionId('ws-already-native')
    const seeded = ctx.sessions.create(nativeId, {
      seed: [{
        type: 'jspace/card',
        seq: 0,
        time: 0,
        ignorable: true,
        data: {
          seq: 4,
          sessionId: nativeId,
          goal: 'seeded',
          core: [],
          checked: [],
          open: [],
          next: 'stay',
          goalOpenedSeq: 1,
        },
      }],
    })
    expect(ctx.jspace.card(seeded)?.seq).toBe(4)
  })

  it('advances seq past a native close', async () => {
    const { ctx, session } = await harness()
    ctx.jspace.open(session, { goal: 'A', next: 'B' })
    ctx.jspace.close(session)
    const reopened = ctx.jspace.open(session, { goal: 'C', next: 'D' })
    expect(reopened.seq).toBe(3)
  })

  it('skips a malformed close when computing the next seq on an unattached session', async () => {
    const { ctx } = await harness()
    const loose = (await import('@shres-code/shres-code-session')).Session.create(SessionId('ws-loose'))
    ctx.jspace.open(loose, { goal: 'A', next: 'B' })
    ctx.jspace.close(loose)
    loose.append('jspace/closed', { seq: 'bad', sessionId: loose.id } as never, { ignorable: true })
    const reopened = ctx.jspace.open(loose, { goal: 'C', next: 'D' })
    expect(reopened.seq).toBe(3)
  })
})
