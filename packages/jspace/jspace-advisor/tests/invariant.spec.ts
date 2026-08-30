import { describe, expect, it } from 'vitest'
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure } from '@shres-code/shres-code-invariants'
import type { Session } from '@shres-code/shres-code-session'
import { apply } from '../src/invariant.ts'

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
        installer(ctx as unknown as Context, (message: string) => { failures.push(message) })
        return () => { /* no-op */ }
      },
    },
  } as unknown as Context
  return { ctx, failures, dispatch }
}

function advisorEvent(trigger: string, seq: number): unknown {
  return { type: 'jspace/advisor', seq, data: { sessionId: 's1', childId: 'c1', trigger, advice: 'x', seq } }
}

function charterFail(seq: number): unknown {
  return { type: 'jspace/charter-run', seq, data: { phase: 'checkpoint', passed: false } }
}

describe('jspace-advisor invariant', () => {
  it('registers without failing on an empty session', () => {
    const { ctx, failures } = harness()
    void apply(ctx)
    expect(failures).toEqual([])
  })

  it('fails when a jspace/advisor event has no preceding satisfying trigger', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    dispatch(sessionWith([]), advisorEvent('charter-fail', 1))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/no preceding satisfying event/)
  })

  it('passes when a preceding event satisfies the trigger', () => {
    const { ctx, failures, dispatch } = harness()
    void apply(ctx)
    const session = sessionWith([charterFail(1)])
    dispatch(session, advisorEvent('charter-fail', 2))
    expect(failures).toEqual([])
  })
})
