import { describe, expect, it } from 'vitest'
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure } from '@shres-code/shres-code-invariants'
import type { Session } from '@shres-code/shres-code-session'
import { apply, triggerSatisfiedAt } from '../src/invariant.ts'

/** Minimal session stub carrying only the events the invariant reads. */
function sessionWith(events: readonly unknown[]): Session {
  return { events } as unknown as Session
}

/** A context stub that captures the internal/dispatch handler and records failures. */
function harness(): {
  ctx: Context
  failures: string[]
  dispatch: (session: Session, event: unknown) => void
} {
  const failures: string[] = []
  let handlerRef: (mode: string, eventName: string, args: unknown[]) => void = () => { /* no-op */ }
  const dispatch = (session: Session, event: unknown): void => {
    handlerRef('emit', 'session/event', [session, event])
  }
  const ctx = {
    on: (_name: string, handler: (mode: string, eventName: string, args: unknown[]) => void) => {
      handlerRef = handler
      return () => { /* no-op */ }
    },
    sessions: { list: () => [] },
    invariants: {
      register: (_name: string, installer: (c: Context, fail: InvariantFailure) => void) => {
        installer(ctx as unknown as Context, ((message: string) => { failures.push(message) }) as unknown as InvariantFailure)
        return () => { /* no-op */ }
      },
    },
  } as unknown as Context
  return { ctx, failures, dispatch }
}

function advisorEvent(trigger: string, triggerSeq: number, seq: number): unknown {
  return {
    type: 'jspace/advisor',
    seq,
    data: { sessionId: 's1', childId: 'c1', trigger, triggerSeq, verdict: 'on-track', advice: 'x', seq },
  }
}

function charterRun(seq: number, phase: string, passed: boolean): unknown {
  return { type: 'jspace/charter-run', seq, data: { phase, passed } }
}

describe('jspace-advisor invariant', () => {
  it('registers without failing on an empty session', () => {
    const { ctx, failures } = harness()
    void apply(ctx)
    expect(failures).toEqual([])
  })

  it('fails when triggerSeq points at no event', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([]), advisorEvent('charter-fail', 99, 1))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/no satisfying event at triggerSeq 99/)
  })

  it('passes when the pointed-at event satisfies the trigger', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([charterRun(1, 'checkpoint', false)]), advisorEvent('charter-fail', 1, 2))
    expect(failures).toEqual([])
  })

  it('does not accept a discrimination probe as a charter failure', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([charterRun(1, 'probe', false)]), advisorEvent('charter-fail', 1, 2))
    expect(failures).toHaveLength(1)
  })

  it('accepts a ship run as the ship-attempt pointer', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([charterRun(1, 'ship', true)]), advisorEvent('ship-attempt', 1, 2))
    expect(failures).toEqual([])
  })

  it('accepts a goal change as the goal-epoch pointer', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([
      { type: 'jspace/card', seq: 1, data: { goal: 'old' } },
      { type: 'jspace/card', seq: 2, data: { goal: 'new' } },
    ]), advisorEvent('goal-epoch', 2, 3))
    expect(failures).toEqual([])
  })

  it('rejects a goal-epoch pointer whose goal did not change', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([
      { type: 'jspace/card', seq: 1, data: { goal: 'same' } },
      { type: 'jspace/card', seq: 2, data: { goal: 'same' } },
    ]), advisorEvent('goal-epoch', 2, 3))
    expect(failures).toHaveLength(1)
  })

  it('accepts an errored tool result as the error-burst pointer', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([{
      type: 'tool/result',
      seq: 1,
      data: { message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', isError: true }] } },
    }]), advisorEvent('error-burst', 1, 2))
    expect(failures).toEqual([])
  })

  it('rejects a goal-epoch pointer at the first card', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([{ type: 'jspace/card', seq: 1, data: { goal: 'first' } }]), advisorEvent('goal-epoch', 1, 2))
    expect(failures).toHaveLength(1)
  })

  it('rejects a goal-epoch pointer at a non-card event', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([{ type: 'step/end', seq: 1, data: { turn: 1, step: 1 } }]), advisorEvent('goal-epoch', 1, 2))
    expect(failures).toHaveLength(1)
  })

  it('throws on an unknown trigger family', () => {
    expect(() => triggerSatisfiedAt(
      [{ type: 'step/end', seq: 1, data: { turn: 1, step: 1 } }] as never,
      1,
      'bogus' as never,
    )).toThrow(/unreachable variant/)
  })

  it('accepts a human user message as the user-intent pointer', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([{
      type: 'user/message',
      seq: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    }]), advisorEvent('user-intent', 1, 2))
    expect(failures).toEqual([])
  })

  it('rejects a machine-sourced user message as user-intent', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([{
      type: 'user/message',
      seq: 1,
      data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'hi' }] },
    }]), advisorEvent('user-intent', 1, 2))
    expect(failures).toHaveLength(1)
  })

  it('accepts a step/end as the drift-check pointer', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([{ type: 'step/end', seq: 1, data: { turn: 1, step: 1 } }]), advisorEvent('drift-check', 1, 2))
    expect(failures).toEqual([])
  })

  it('rejects a drift-check whose triggerSeq does not increase', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    const session = sessionWith([
      { type: 'step/end', seq: 1, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, data: { turn: 1, step: 2 } },
      advisorEvent('drift-check', 2, 3),
    ])
    dispatch(session, advisorEvent('drift-check', 2, 4))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/not increasing/)
  })

  it('accepts an increasing drift-check sequence', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    const session = sessionWith([
      { type: 'step/end', seq: 1, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, data: { turn: 1, step: 2 } },
      advisorEvent('drift-check', 1, 2),
      { type: 'step/end', seq: 3, data: { turn: 2, step: 1 } },
    ])
    dispatch(session, advisorEvent('drift-check', 3, 4))
    expect(failures).toEqual([])
  })

  it('ignores advice events at or after the checked seq', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    const session = sessionWith([
      { type: 'step/end', seq: 1, data: { turn: 1, step: 1 } },
      advisorEvent('drift-check', 1, 2),
      { type: 'step/end', seq: 3, data: { turn: 2, step: 1 } },
      advisorEvent('drift-check', 9, 5),
    ])
    dispatch(session, advisorEvent('drift-check', 3, 4))
    expect(failures).toEqual([])
  })
})
