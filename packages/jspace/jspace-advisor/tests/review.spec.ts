import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { foldAdvisorDelta, foldAdvisorDigest } from '../src/digest.ts'
import {
  buildReviewDeltaPrompt,
  buildReviewPrompt,
  DEFAULT_REVIEWER_PERSONA,
  classifyDrift,
  classifyTrigger,
  isErroredToolResult,
  isRootSession,
  parseFinalVerdict,
  parseReviewVerdict,
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

describe('parseReviewVerdict', () => {
  it('parses a bare JSON object', () => {
    const verdict = parseReviewVerdict('{"verdict":"on-track","advice":"serving the goal"}')
    expect(verdict).toEqual({ verdict: 'on-track', advice: 'serving the goal' })
  })

  it('parses a fenced code block', () => {
    const verdict = parseReviewVerdict('```json\n{"verdict":"drift","advice":"off course","redirect":"drop X"}\n```')
    expect(verdict).toEqual({ verdict: 'drift', advice: 'off course', redirect: 'drop X' })
  })

  it('parses an object embedded in stray prose', () => {
    const verdict = parseReviewVerdict('Here it is: {"verdict":"drift","advice":"off course"} — done.')
    expect(verdict?.verdict).toBe('drift')
  })

  it('rejects an invalid verdict value', () => {
    expect(parseReviewVerdict('{"verdict":"meh","advice":"x"}')).toBeUndefined()
  })

  it('rejects a missing advice field', () => {
    expect(parseReviewVerdict('{"verdict":"on-track"}')).toBeUndefined()
  })

  it('rejects a non-string redirect', () => {
    expect(parseReviewVerdict('{"verdict":"drift","advice":"x","redirect":3}')).toBeUndefined()
  })

  it('rejects prose without a verdict object', () => {
    expect(parseReviewVerdict('looks fine to me')).toBeUndefined()
  })
})

describe('parseFinalVerdict', () => {
  it('reads the latest parseable assistant reply of the child turn', () => {
    const session = sessionWith([
      event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 're-reading the goal' }] } }, 1),
      event('tool/call', { callId: 'c1', name: 'wiki_read' }, 2),
      event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '{"verdict":"on-track","advice":"ok"}' }] } }, 3),
    ])
    expect(parseFinalVerdict(session)).toEqual({ verdict: 'on-track', advice: 'ok' })
  })

  it('skips reasoning-only assistant messages', () => {
    const session = sessionWith([
      event('assistant/message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] } }, 1),
      event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '{"verdict":"drift","advice":"off"}' }] } }, 2),
    ])
    expect(parseFinalVerdict(session)?.verdict).toBe('drift')
  })

  it('is undefined when no reply parses', () => {
    const session = sessionWith([
      event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'I could not tell.' }] } }, 1),
    ])
    expect(parseFinalVerdict(session)).toBeUndefined()
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

describe('DEFAULT_REVIEWER_PERSONA', () => {
  it('frames the input as sufficient, forbids session hunting, and fixes the reply protocol', () => {
    expect(DEFAULT_REVIEWER_PERSONA).toContain('standing reviewer of one main session')
    expect(DEFAULT_REVIEWER_PERSONA).toContain('do not search for other sessions')
    expect(DEFAULT_REVIEWER_PERSONA).toContain('a single JSON object')
    expect(DEFAULT_REVIEWER_PERSONA).toContain('Omit redirect when on-track')
  })
})

describe('buildReviewPrompt', () => {
  it('embeds the digest render and the trigger', () => {
    const digest = foldAdvisorDigest(sessionWith([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'goal' }] }, seq: 1 }]), null,
      { maxTools: 12, maxChars: 4000, maxExcerpt: 200, maxUserMessage: 300, maxUserHistory: 1500 })
    const prompt = buildReviewPrompt(digest, 'drift-check')
    expect(prompt).toContain('U1: goal')
    expect(prompt).toContain('drift-check')
    expect(prompt).toContain('The digest above is the main session')
    expect(prompt).toContain('reply with only the verdict JSON now')
  })

  it('builds the delta prompt from the folded delta and the trigger', () => {
    const delta = foldAdvisorDelta(sessionWith([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'goal' }] }, seq: 1 },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'new ask' }] }, seq: 5 },
    ]), null,
    { maxTools: 12, maxChars: 4000, maxExcerpt: 200, maxUserMessage: 300, maxUserHistory: 1500 }, 3)
    const prompt = buildReviewDeltaPrompt(delta, 'goal-epoch')
    expect(prompt).toContain('Goal (U1): goal')
    expect(prompt).toContain('N1: new ask')
    expect(prompt).toContain('since your last review')
    expect(prompt).toContain('goal-epoch')
  })
})
