import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import {
  captureSettlement,
  classifyTrigger,
  existingReviewer,
  isRootSession,
  reviewInFlight,
  userTurnOpen,
} from '../src/review.ts'

/** Minimal session stub carrying only the events the helpers read. */
function sessionWith(events: readonly unknown[], header: Record<string, unknown> = {}): Session {
  return { events, header } as unknown as Session
}

function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

describe('isRootSession', () => {
  it('is true for a session with no parent', () => {
    expect(isRootSession(sessionWith([], {}))).toBe(true)
  })

  it('is false for a delegated child', () => {
    expect(isRootSession(sessionWith([], { parentSession: 'p1' }))).toBe(false)
  })
})

describe('classifyTrigger', () => {
  it('classifies a failed charter run', () => {
    expect(classifyTrigger(event('jspace/charter-run', { phase: 'checkpoint', passed: false }), [], 2)).toBe('charter-fail')
  })

  it('classifies a ship attempt', () => {
    expect(classifyTrigger(event('jspace/charter-run', { phase: 'ship', passed: true }), [], 2)).toBe('ship-attempt')
  })

  it('ignores a passing non-ship charter run', () => {
    expect(classifyTrigger(event('jspace/charter-run', { phase: 'checkpoint', passed: true }), [], 2)).toBeUndefined()
  })

  it('classifies a goal epoch change', () => {
    const log = [event('jspace/card', { goal: 'old' }, 1)]
    expect(classifyTrigger(event('jspace/card', { goal: 'new' }, 2), log, 2)).toBe('goal-epoch')
  })

  it('ignores a same-goal card update', () => {
    const log = [event('jspace/card', { goal: 'same' }, 1)]
    expect(classifyTrigger(event('jspace/card', { goal: 'same' }, 2), log, 2)).toBeUndefined()
  })

  it('classifies an error burst at the threshold', () => {
    const log = [
      event('tool/result', { message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', isError: true }] } }, 1),
      event('tool/result', { message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', isError: true }] } }, 2),
    ]
    expect(classifyTrigger(log[1] as SessionEvent, log, 2)).toBe('error-burst')
  })

  it('does not classify a single error below the threshold', () => {
    const log = [
      event('tool/result', { message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', isError: true }] } }, 1),
    ]
    expect(classifyTrigger(log[0] as SessionEvent, log, 2)).toBeUndefined()
  })
})

describe('userTurnOpen', () => {
  it('is true after a user message with no turn end', () => {
    const log = [event('user/message', { source: { kind: 'user' } }, 1)]
    expect(userTurnOpen(log)).toBe(true)
  })

  it('is false after a turn end', () => {
    const log = [
      event('user/message', { source: { kind: 'user' } }, 1),
      event('turn/end', { reason: 'completed' }, 2),
    ]
    expect(userTurnOpen(log)).toBe(false)
  })
})

describe('reviewInFlight', () => {
  it('is true when a jspace/advisor event is the latest', () => {
    const log = [event('jspace/advisor', { sessionId: 's1' }, 1)]
    expect(reviewInFlight(log)).toBe(true)
  })

  it('is false after a turn end', () => {
    const log = [
      event('jspace/advisor', { sessionId: 's1' }, 1),
      event('turn/end', { reason: 'completed' }, 2),
    ]
    expect(reviewInFlight(log)).toBe(false)
  })
})

describe('existingReviewer', () => {
  it('finds a continuable child by label', () => {
    const children = [{ kind: 'child', id: 'c1', activity: 'running', hasChildren: false, mode: 'continuable', label: 'jspace-advisor reviewer' }]
    expect(existingReviewer(children as never, 'jspace-advisor reviewer')).toBe('c1')
  })

  it('returns undefined when no child matches', () => {
    expect(existingReviewer([], 'jspace-advisor reviewer')).toBeUndefined()
  })
})

describe('captureSettlement', () => {
  it('captures a reviewer settlement as advice', () => {
    const session = sessionWith([])
    const notice = event('user/message', {
      source: { kind: 'subagent-settled', senderSessionId: 'c1' },
      content: [{ type: 'text', text: 'you drifted from the goal' }],
    }, 5)
    const advice = captureSettlement(session, notice as SessionEvent<'user/message'>, 'goal-epoch', 1000)
    expect(advice).toBeDefined()
    expect(advice?.childId).toBe('c1')
    expect(advice?.trigger).toBe('goal-epoch')
    expect(advice?.advice).toContain('drifted')
  })

  it('ignores non-settlement user messages', () => {
    const session = sessionWith([])
    const notice = event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, 5)
    expect(captureSettlement(session, notice as SessionEvent<'user/message'>, 'goal-epoch', 1000)).toBeUndefined()
  })

  it('bounds the advice to maxAdvice', () => {
    const session = sessionWith([])
    const notice = event('user/message', {
      source: { kind: 'subagent-settled', senderSessionId: 'c1' },
      content: [{ type: 'text', text: 'x'.repeat(2000) }],
    }, 5)
    const advice = captureSettlement(session, notice as SessionEvent<'user/message'>, 'goal-epoch', 10)
    expect(advice?.advice.length).toBeLessThanOrEqual(10)
  })
})
