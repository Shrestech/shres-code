import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import type { SubagentResult } from '@shres-code/shres-code-subagent'
import { foldAdvisorDigest } from '../src/digest.ts'
import {
  buildReviewPrompt,
  classifyDrift,
  classifyTrigger,
  isErroredToolResult,
  isRootSession,
  settleReview,
  suppressReview,
} from '../src/review.ts'

/** Minimal session stub carrying only the events the helpers read. */
function sessionWith(events: readonly unknown[], header: Record<string, unknown> = {}): Session {
  return { events, header } as unknown as Session
}

function toLog(events: readonly unknown[]): readonly SessionEvent[] {
  return events as unknown as readonly SessionEvent[]
}

function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

function erroredResult(callId: string, seq: number, isError = true) {
  return event('tool/result', {
    message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', isError }] },
  }, seq)
}

function toolCall(callId: string, name: string, seq: number) {
  return event('tool/call', { callId, name }, seq)
}

function result(stopReason: SubagentResult['stopReason'], structured?: unknown, output: unknown[] = []): SubagentResult {
  return { stopReason, output: output as SubagentResult['output'], ...structured === undefined ? {} : { structured } }
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
  it('classifies a failed checkpoint charter run', () => {
    expect(classifyTrigger(event('jspace/charter-run', { phase: 'checkpoint', passed: false }), [], 2)).toBe('charter-fail')
  })

  it('ignores a discrimination probe even when it fails', () => {
    expect(classifyTrigger(event('jspace/charter-run', { phase: 'probe', passed: false }), [], 2)).toBeUndefined()
  })

  it('classifies a ship attempt', () => {
    expect(classifyTrigger(event('jspace/charter-run', { phase: 'ship', passed: true }), [], 2)).toBe('ship-attempt')
  })

  it('ignores a passing checkpoint run', () => {
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

  it('classifies an error burst across interleaved tool calls', () => {
    const log = [
      toolCall('c1', 'bash', 1),
      erroredResult('c1', 2),
      toolCall('c2', 'bash', 3),
      erroredResult('c2', 4),
    ]
    expect(classifyTrigger(log[3] as SessionEvent, log, 2)).toBe('error-burst')
  })

  it('does not classify a single error below the threshold', () => {
    const log = [toolCall('c1', 'bash', 1), erroredResult('c1', 2)]
    expect(classifyTrigger(log[1] as SessionEvent, log, 2)).toBeUndefined()
  })

  it('stops the burst at a successful result', () => {
    const log = [
      toolCall('c1', 'bash', 1),
      erroredResult('c1', 2, false),
      toolCall('c2', 'bash', 3),
      erroredResult('c2', 4),
    ]
    expect(classifyTrigger(log[3] as SessionEvent, log, 2)).toBeUndefined()
  })
})

describe('classifyDrift', () => {
  it('fires once every N completed steps with no advice yet', () => {
    const steps = Array.from({ length: 8 }, (_, i) => event('step/end', { turn: 1, step: i + 1 }, i + 1))
    expect(classifyDrift(toLog(steps), 8)).toBe('drift-check')
    expect(classifyDrift(toLog(steps.slice(0, 7)), 8)).toBeUndefined()
  })

  it('counts steps since the last advice', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => event('step/end', { turn: 1, step: i + 1 }, i + 1)),
      event('jspace/advisor', { trigger: 'drift-check', triggerSeq: 8 }, 9),
      ...Array.from({ length: 4 }, (_, i) => event('step/end', { turn: 2, step: i + 1 }, 10 + i)),
    ]
    expect(classifyDrift(toLog(events), 8)).toBeUndefined()
    const more = [...events, ...Array.from({ length: 4 }, (_, i) => event('step/end', { turn: 2, step: 5 + i }, 14 + i))]
    expect(classifyDrift(toLog(more), 8)).toBe('drift-check')
  })
})

describe('suppressReview', () => {
  it('allows the first review when no advice exists', () => {
    expect(suppressReview(toLog([event('user/message', { source: { kind: 'user' } }, 1)]))).toBe(false)
  })

  it('suppresses while the latest advice is newer than the latest user message', () => {
    const log = [
      event('user/message', { source: { kind: 'user' } }, 1),
      event('jspace/advisor', { trigger: 'drift-check' }, 2),
    ]
    expect(suppressReview(toLog(log))).toBe(true)
  })

  it('allows again after the user speaks', () => {
    const log = [
      event('jspace/advisor', { trigger: 'drift-check' }, 1),
      event('user/message', { source: { kind: 'user' } }, 2),
    ]
    expect(suppressReview(toLog(log))).toBe(false)
  })

  it('suppresses when no user message exists at all', () => {
    expect(suppressReview(toLog([event('jspace/advisor', { trigger: 'drift-check' }, 1)]))).toBe(true)
  })
})

describe('settleReview', () => {
  it('returns an on-track verdict', () => {
    const review = settleReview(result('completed', { verdict: 'on-track', advice: 'serving the goal' }))
    expect(review.verdict).toBe('on-track')
  })

  it('returns a drift verdict with its redirect', () => {
    const review = settleReview(result('completed', { verdict: 'drift', advice: 'off course', redirect: 'drop X' }))
    expect(review.verdict).toBe('drift')
    expect(review.redirect).toBe('drop X')
  })

  it('throws on a non-completed stop reason', () => {
    expect(() => settleReview(result('max-tokens'))).toThrow(/token limit/)
  })

  it('throws when no structured verdict is present', () => {
    expect(() => settleReview(result('completed'))).toThrow(/no structured verdict/)
  })

  it('throws on an invalid verdict value', () => {
    expect(() => settleReview(result('completed', { verdict: 'meh', advice: 'x' }))).toThrow(/no structured verdict/)
  })
})

describe('classifyTrigger coverage paths', () => {
  it('returns undefined for a non-trigger event type', () => {
    expect(classifyTrigger(event('user/message', { source: { kind: 'user' } }, 1), [], 2)).toBeUndefined()
  })

  it('counts only events up to the checked seq', () => {
    const log = [
      toolCall('c1', 'bash', 1),
      erroredResult('c1', 2),
      erroredResult('c2', 5),
    ]
    expect(classifyTrigger(log[1] as SessionEvent, log, 2)).toBeUndefined()
  })

  it('skips non-tool-sourced results between errors', () => {
    const log = [
      toolCall('c1', 'bash', 1),
      erroredResult('c1', 2),
      event('tool/result', { message: { source: { kind: 'model' }, content: [{ type: 'tool-result', isError: true }] } }, 3),
      erroredResult('c1', 4),
    ]
    expect(classifyTrigger(log[3] as SessionEvent, log, 2)).toBe('error-burst')
  })

  it('tolerates holes in the log for latestAdvice and suppressReview', () => {
    const log = [
      undefined,
      event('jspace/advisor', { trigger: 'drift-check' }, 1),
      undefined,
    ]
    expect(suppressReview(toLog(log))).toBe(true)
  })
})

describe('isErroredToolResult', () => {
  it('is true for an errored tool-sourced result', () => {
    expect(isErroredToolResult(erroredResult('c1', 1))).toBe(true)
  })

  it('is false for a successful result', () => {
    expect(isErroredToolResult(erroredResult('c1', 1, false))).toBe(false)
  })

  it('is false for a non-tool-sourced result', () => {
    const e = event('tool/result', { message: { source: { kind: 'model' }, content: [{ type: 'tool-result', isError: true }] } }, 1)
    expect(isErroredToolResult(e)).toBe(false)
  })

  it('is false for a non-result event', () => {
    expect(isErroredToolResult(event('user/message', { source: { kind: 'user' } }, 1))).toBe(false)
  })
})

describe('buildReviewPrompt', () => {
  it('embeds the digest render and the trigger', () => {
    const digest = foldAdvisorDigest(sessionWith([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'goal' }] }, seq: 1 }]), null,
      { maxTools: 12, maxChars: 4000, maxExcerpt: 200, maxUserMessage: 300, maxUserHistory: 1500 })
    const prompt = buildReviewPrompt(digest, 'drift-check')
    expect(prompt).toContain('U1: goal')
    expect(prompt).toContain('drift-check')
  })
})
