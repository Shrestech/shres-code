import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import type { JspaceCard } from '@shres-code/shres-code-jspace'
import { argsExcerpt, boundText, foldAdvisorDelta, foldAdvisorDigest, foldUserMessages, renderAdvisorDelta, renderAdvisorDigest, TRUNCATION_MARKER } from '../src/digest.ts'

/** Minimal session stub carrying only the events the fold reads. */
function sessionWith(events: readonly unknown[], seq = 0): Session {
  return { events, seq, id: 's1' } as unknown as Session
}

/** Cast raw fixture events to the fold's log type. */
function toLog(events: readonly unknown[]): readonly SessionEvent[] {
  return events as unknown as readonly SessionEvent[]
}

const CARD: JspaceCard = {
  seq: 1,
  sessionId: 's1',
  goal: 'Ship the feature',
  core: ['one', 'two'],
  checked: [],
  open: [],
  next: 'write tests',
  goalOpenedSeq: 0,
  charter: [],
}

const CAPS = { maxTools: 12, maxChars: 4000, maxExcerpt: 200, maxUserMessage: 300, maxUserHistory: 1500, maxArgs: 80 }

function userMsg(text: string, seq: number) {
  return { type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

describe('boundText', () => {
  it('returns short text unchanged', () => {
    expect(boundText('abc', 5)).toBe('abc')
  })

  it('truncates long text with a marker', () => {
    expect(boundText('abcdef', 4)).toBe('abc' + TRUNCATION_MARKER)
  })
})

describe('argsExcerpt', () => {
  it('prefers command and file_path over the rest of the JSON', () => {
    expect(argsExcerpt('{"command":"git log","timeout":1}', 80)).toBe('git log')
    expect(argsExcerpt('{"file_path":"/tmp/a.ts"}', 80)).toBe('/tmp/a.ts')
  })

  it('bounds a raw non-JSON blob', () => {
    expect(argsExcerpt('not-json-at-all', 8)).toBe('not-jso' + TRUNCATION_MARKER)
  })

  it('returns undefined for empty arguments', () => {
    expect(argsExcerpt(undefined, 80)).toBeUndefined()
    expect(argsExcerpt('', 80)).toBeUndefined()
  })
})

describe('foldUserMessages', () => {
  it('keeps every user message oldest-first and skips machine sources', () => {
    const { messages, elided } = foldUserMessages(toLog([
      userMsg('first goal', 1),
      { type: 'user/message', seq: 2, data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: 'machine' }] } },
      userMsg('second ask', 3),
    ]), 300, 1500)
    expect(messages).toEqual(['first goal', 'second ask'])
    expect(elided).toBe(0)
  })

  it('bounds each message', () => {
    const { messages } = foldUserMessages(toLog([userMsg('x'.repeat(400), 1)]), 300, 1500)
    expect(messages[0]).toHaveLength(300)
  })

  it('drops the oldest droppable messages under the total cap but always retains the first', () => {
    const events = [
      userMsg('goal statement', 1),
      userMsg('aaaaaaaaaa', 2),
      userMsg('bbbbbbbbbb', 3),
      userMsg('cccccccccc', 4),
    ]
    const { messages, elided } = foldUserMessages(toLog(events), 300, 34)
    expect(messages).toEqual(['goal statement', 'bbbbbbbbbb', 'cccccccccc'])
    expect(elided).toBe(1)
  })

  it('skips messages without text', () => {
    const { messages } = foldUserMessages(toLog([
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [] } },
    ]), 300, 1500)
    expect(messages).toEqual([])
  })
})

describe('foldAdvisorDigest', () => {
  it('counts completed steps and folds the card', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 2 } },
    ]), CARD, CAPS)
    expect(digest.steps).toBe(2)
    expect(digest.card).toContain('Ship the feature')
    expect(digest.seq).toBe(0)
    expect(digest.sessionId).toBe('s1')
  })

  it('keeps the trailing tool window, not the head', () => {
    const events: unknown[] = []
    for (let i = 0; i < 5; i += 1) {
      events.push({ type: 'tool/call', data: { callId: 'c' + String(i), name: 'tool' + String(i) } })
      events.push({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c' + String(i) }, content: [{ type: 'tool-result' }] } } })
    }
    const digest = foldAdvisorDigest(sessionWith(events), null, { ...CAPS, maxTools: 3 })
    expect(digest.recentTools.map(signal => signal.name)).toEqual(['tool2', 'tool3', 'tool4'])
  })

  it('records seq and a truncated argument excerpt on each tool signal', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', seq: 9, data: { callId: 'a', name: 'write', arguments: '{"file_path":"/tmp/out.ts"}' } },
      { type: 'tool/result', seq: 10, data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([
      { seq: 9, name: 'write', ok: true, argsExcerpt: '/tmp/out.ts' },
    ])
    expect(renderAdvisorDigest(digest)).toContain('ok write seq=9 /tmp/out.ts')
  })

  it('records error excerpts only for failures', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
      { type: 'tool/call', data: { callId: 'b', name: 'bash' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'b' }, content: [{ type: 'tool-result', isError: true, text: 'boom' }] } } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([
      { seq: 0, name: 'read', ok: true },
      { seq: 0, name: 'bash', ok: false, errorExcerpt: 'boom' },
    ])
  })

  it('ignores tool results without a tool source', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'model', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([])
  })

  it('tolerates holes in the trailing tool walk', () => {
    const events: unknown[] = [
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
      undefined,
    ]
    const digest = foldAdvisorDigest(sessionWith(events), null, CAPS)
    expect(digest.recentTools).toEqual([{ seq: 0, name: 'read', ok: true }])
  })

  it('folds the user message history', () => {
    const digest = foldAdvisorDigest(sessionWith([userMsg('the goal', 1)]), null, CAPS)
    expect(digest.userMessages).toEqual(['the goal'])
    expect(digest.elidedUserMessages).toBe(0)
  })
})

describe('foldAdvisorDigest edges', () => {
  it('skips results and calls without a callId', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/result', data: { message: { source: { kind: 'tool' }, content: [{ type: 'tool-result' }] } } },
      { type: 'tool/call', data: { name: 'no-call-id' } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([])
  })

  it('renders an unnamed call as unknown', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', data: { callId: 'a' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([{ seq: 0, name: '<unknown>', ok: true }])
  })
})

describe('renderAdvisorDigest', () => {
  it('renders user messages first and tools last', () => {
    const digest = foldAdvisorDigest(sessionWith([
      userMsg('hi', 1),
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
    ]), CARD, CAPS)
    const render = renderAdvisorDigest(digest)
    expect(render).toContain('U1: hi')
    expect(render).toContain('Ship the feature')
    expect(render).toContain('Main session id: s1')
    expect(render).toContain('ok read seq=0')
    expect(render.indexOf('U1: hi')).toBeLessThan(render.indexOf('ok read seq=0'))
  })

  it('renders the elision count between the first message and the suffix', () => {
    const events = [userMsg('goal', 1), userMsg('aaaaaaaaaa', 2), userMsg('bbbbbbbbbb', 3), userMsg('cccccccccc', 4)]
    const digest = foldAdvisorDigest(sessionWith(events), null, { ...CAPS, maxUserHistory: 30 })
    expect(renderAdvisorDigest(digest)).toContain('earlier user messages elided')
  })

  it('renders failures with and without an excerpt', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', data: { callId: 'a', name: 'bash' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result', isError: true, text: 'denied' }] } } },
      { type: 'tool/call', data: { callId: 'b', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'b' }, content: [{ type: 'tool-result', isError: true }] } } },
    ]), null, CAPS)
    const render = renderAdvisorDigest(digest)
    expect(render).toContain('FAIL bash seq=0: denied')
    expect(render).toContain('FAIL read seq=0')
  })

  it('caps the complete render at maxChars, eating the trailing tools first', () => {
    const digest = foldAdvisorDigest(sessionWith([userMsg('hi', 1)]), CARD, { ...CAPS, maxChars: 30 })
    const render = renderAdvisorDigest(digest)
    expect(render.length).toBeLessThanOrEqual(30)
    expect(render.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(render.startsWith('Main session id:')).toBe(true)
  })
})

describe('foldAdvisorDelta', () => {
  it('folds only user messages and steps beyond sinceSeq while restating the goal', () => {
    const delta = foldAdvisorDelta(sessionWith([
      userMsg('goal', 1),
      { type: 'step/end', seq: 2, data: {} },
      userMsg('new ask', 5),
      { type: 'step/end', seq: 6, data: {} },
      { type: 'step/end', seq: 7, data: {} },
    ], 7), CARD, CAPS, 3)
    expect(delta.goal).toBe('goal')
    expect(delta.userMessages).toEqual(['new ask'])
    expect(delta.steps).toBe(2)
    expect(delta.sinceSeq).toBe(3)
    expect(delta.seq).toBe(7)
  })

  it('pairs only tool signals that fall inside the delta window', () => {
    const delta = foldAdvisorDelta(sessionWith([
      { type: 'tool/call', seq: 1, data: { callId: 'old', name: 'bash' } },
      { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'old' }, content: [{ type: 'tool-result' }] } } },
      { type: 'tool/call', seq: 5, data: { callId: 'new', name: 'read' } },
      { type: 'tool/result', seq: 6, data: { message: { source: { kind: 'tool', callId: 'new' }, content: [{ type: 'tool-result' }] } } },
    ], 6), null, CAPS, 3)
    expect(delta.recentTools).toEqual([{ seq: 5, name: 'read', ok: true }])
  })

  it('renders the goal, the delta boundary, and the new messages', () => {
    const delta = foldAdvisorDelta(sessionWith([
      userMsg('goal', 1),
      userMsg('new ask', 4),
    ], 4), CARD, CAPS, 3)
    const render = renderAdvisorDelta(delta)
    expect(render).toContain('Main session id: s1')
    expect(render).toContain('Folded events: 3 → 4')
    expect(render).toContain('Goal (U1): goal')
    expect(render).toContain('New user messages since event 3:')
    expect(render).toContain('N1: new ask')
    expect(render).toContain('Steps completed since the last review: 0')
    expect(render.indexOf('Goal (U1)')).toBeLessThan(render.indexOf('N1: new ask'))
  })

  it('states when no new user message arrived', () => {
    const delta = foldAdvisorDelta(sessionWith([userMsg('goal', 1)], 2), null, CAPS, 1)
    expect(renderAdvisorDelta(delta)).toContain('New user messages since event 1: (none)')
  })
})
