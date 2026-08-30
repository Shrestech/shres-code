import { describe, expect, it } from 'vitest'
import type { Session } from '@shres-code/shres-code-session'
import type { JspaceCard } from '@shres-code/shres-code-jspace'
import { boundText, foldAdvisorDigest, renderAdvisorDigest, TRUNCATION_MARKER } from '../src/digest.ts'

/** Minimal session stub carrying only the events the fold reads. */
function sessionWith(events: readonly unknown[], seq = 0): Session {
  return { events, seq } as unknown as Session
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

const CAPS = { maxTools: 12, maxChars: 4000, maxExcerpt: 200, maxIntent: 500 }

describe('boundText', () => {
  it('returns short text unchanged', () => {
    expect(boundText('abc', 5)).toBe('abc')
  })

  it('truncates long text with a marker', () => {
    expect(boundText('abcdef', 4)).toBe(`abc${TRUNCATION_MARKER}`)
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
  })

  it('keeps the trailing tool window, not the head', () => {
    const events: unknown[] = []
    for (let i = 0; i < 5; i += 1) {
      events.push({ type: 'tool/call', data: { callId: `c${i}`, name: `tool${i}` } })
      events.push({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId: `c${i}` }, content: [{ type: 'tool-result' }] } } })
    }
    const digest = foldAdvisorDigest(sessionWith(events), null, { ...CAPS, maxTools: 3 })
    expect(digest.recentTools.map(signal => signal.name)).toEqual(['tool2', 'tool3', 'tool4'])
  })

  it('records error excerpts only for failures', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
      { type: 'tool/call', data: { callId: 'b', name: 'bash' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'b' }, content: [{ type: 'tool-result', isError: true, text: 'boom' }] } } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([
      { name: 'read', ok: true },
      { name: 'bash', ok: false, errorExcerpt: 'boom' },
    ])
  })

  it('ignores tool results without a tool source', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'model', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
    ]), null, CAPS)
    expect(digest.recentTools).toEqual([])
  })

  it('captures the latest human user intent', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] } },
    ]), null, CAPS)
    expect(digest.userIntent).toBe('do the thing')
  })
})

describe('renderAdvisorDigest', () => {
  it('renders card, intent, steps, and tools', () => {
    const digest = foldAdvisorDigest(sessionWith([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
      { type: 'tool/call', data: { callId: 'a', name: 'read' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result' }] } } },
    ]), CARD, CAPS)
    const render = renderAdvisorDigest(digest)
    expect(render).toContain('Ship the feature')
    expect(render).toContain('Latest user intent: hi')
    expect(render).toContain('ok read')
  })

  it('caps the complete render at maxChars', () => {
    const digest = foldAdvisorDigest(sessionWith([]), CARD, { ...CAPS, maxChars: 20 })
    const render = renderAdvisorDigest(digest)
    expect(render.length).toBeLessThanOrEqual(20)
    expect(render.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})
