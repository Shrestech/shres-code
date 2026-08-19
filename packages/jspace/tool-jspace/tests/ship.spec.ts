import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { JSPACE_ALWAYS_OPEN_GOAL } from '@shres-code/shres-code-jspace'
import type { JspaceCard } from '@shres-code/shres-code-jspace'
import { shipRefusal } from '../src/ship.ts'

const card: JspaceCard = {
  seq: 1,
  sessionId: 's',
  goal: 'Ship W3',
  core: [],
  checked: [],
  open: [],
  next: 'Write tests',
  goalOpenedSeq: 1,
}

function snapshot(
  seq: number,
  checked: JspaceCard['checked'],
  goalOpenedSeq = 1,
): SessionEvent {
  return {
    type: 'jspace/card',
    seq,
    time: 0,
    ignorable: true,
    data: {
      seq,
      sessionId: 's',
      goal: 'Ship W3',
      core: [],
      checked,
      open: [],
      next: 'Write tests',
      goalOpenedSeq,
    },
  }
}

describe('shipRefusal', () => {
  it('refuses a missing card, empty Goal, and empty Next', () => {
    expect(shipRefusal(null, [])).toBe('jspace card is not open')
    expect(shipRefusal({ ...card, goal: '' }, [])).toBe('jspace ship requires a non-empty Goal')
    expect(shipRefusal({ ...card, next: '' }, [])).toBe('jspace ship requires a non-empty Next')
  })

  it('accepts a checkpoint whose event seq is at least goalOpenedSeq', () => {
    const events = [
      snapshot(1, []),
      snapshot(2, [{ n: 1, check: 'done', by: 'unit tests covering the fold', evidence: 'c1' }]),
    ]
    expect(shipRefusal({ ...card, goalOpenedSeq: 1 }, events)).toBeUndefined()
  })

  it('refuses the placeholder Goal even with a checkpoint at goalOpenedSeq', () => {
    const events = [
      snapshot(1, []),
      snapshot(2, [{ n: 1, check: 'done', by: 'unit tests covering the fold', evidence: 'c1' }]),
    ]
    const placeholder = { ...card, goal: JSPACE_ALWAYS_OPEN_GOAL, goalOpenedSeq: 1 }
    expect(shipRefusal(placeholder, events))
      .toBe(`jspace ship refuses the placeholder Goal "${JSPACE_ALWAYS_OPEN_GOAL}"; `
        + "record the task's done-means as Goal with jspace_note or jspace_open first")
  })

  it('refuses after a goal change with no new checkpoint, including across a close', () => {
    const checked = [{ n: 1, check: 'done', by: 'unit tests covering the fold', evidence: 'c1' }] as const
    const afterGoal = [
      snapshot(1, []),
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1 } },
      snapshot(2, checked),
      snapshot(3, checked, 3),
    ]
    expect(shipRefusal({ ...card, goalOpenedSeq: 3 }, afterGoal))
      .toBe('jspace ship requires an evidence-backed checkpoint for the current Goal')

    const afterClose = [
      snapshot(1, []),
      snapshot(2, checked),
      { type: 'jspace/closed' as const, seq: 3, time: 0, ignorable: true as const, data: { seq: 3, sessionId: 's' } },
      snapshot(4, [], 4),
    ]
    expect(shipRefusal({ ...card, goalOpenedSeq: 4 }, afterClose))
      .toBe('jspace ship requires an evidence-backed checkpoint for the current Goal')

    const afterNewCheckpoint = [
      ...afterClose,
      snapshot(5, checked, 4),
    ]
    expect(shipRefusal({ ...card, goalOpenedSeq: 4 }, afterNewCheckpoint)).toBeUndefined()
  })
})

describe('shipRefusal on malformed card events', () => {
  it('does not throw on an unreadable checked list', () => {
    const malformed = [
      snapshot(1, []),
      { type: 'jspace/card' as const, seq: 2, time: 0, ignorable: true as const, data: { broken: true } },
      { type: 'jspace/card' as const, seq: 3, time: 0, ignorable: true as const, data: { ...card, checked: 'not-an-array' } },
    ] as unknown as SessionEvent[]
    expect(() => shipRefusal(card, malformed)).not.toThrow()
    expect(shipRefusal({ ...card, goalOpenedSeq: 2 }, malformed))
      .toBe('jspace ship requires an evidence-backed checkpoint for the current Goal')
  })

  it('does not treat a later same-length card as a checkpoint after a malformed event', () => {
    const events = [
      snapshot(1, [{ n: 1, check: 'replay', by: 'unit tests', evidence: 'c1' }]),
      { type: 'jspace/card' as const, seq: 2, time: 0, ignorable: true as const, data: { broken: true } },
      snapshot(3, [{ n: 1, check: 'replay', by: 'unit tests', evidence: 'c1' }]),
    ] as unknown as SessionEvent[]
    expect(shipRefusal({ ...card, goalOpenedSeq: 3 }, events))
      .toBe('jspace ship requires an evidence-backed checkpoint for the current Goal')
  })
})
