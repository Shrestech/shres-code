/**
 * The bounded worker digest and its anchor. A delegated worker's conversation
 * holds no human message, so the digest anchors on the Lead's assignment — the
 * first delivered team message, whose `team-message` source kind the
 * human-message fold drops — plus the latest card's charter; a log carrying
 * only human messages produces an empty anchor rather than the human's text.
 * The caps bound the trailing tool window, every excerpt, and the complete
 * render.
 */

import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import {
  TRUNCATION_MARKER,
  argsExcerpt,
  boundText,
  foldTeamMessages,
  foldWorkerCharter,
  foldWorkerDigest,
  renderWorkerDigest,
} from '../src/digest.ts'
import type { WorkerDigestCaps } from '../src/digest.ts'

/** One logged event carrying only the fields the digest reads. */
function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** A session stub carrying only the log, the folded-through seq, and the id. */
function sessionWith(events: readonly SessionEvent[], seq = 0, id = 'worker-session'): Session {
  return { events, seq, id } as unknown as Session
}

/** One user-role message of a given source kind, with explicit content parts. */
function message(seq: number, source: unknown, content: readonly unknown[]): SessionEvent {
  return event('user/message', seq, { source, content })
}

/** One delivered team message. */
function teamMessage(seq: number, text: string): SessionEvent {
  return message(seq, { kind: 'team-message' }, [{ type: 'text', text }])
}

/** One human prompt. */
function humanMessage(seq: number, text: string): SessionEvent {
  return message(seq, { kind: 'user' }, [{ type: 'text', text }])
}

/** One `tool/call` with the raw argument string the model produced. */
function call(seq: number, callId: string, name: string, args?: string): SessionEvent {
  return event('tool/call', seq, {
    turn: 1,
    step: 1,
    callId,
    name,
    ...args === undefined ? {} : { arguments: args },
  })
}

/** One tool result; `isError` marks a failure. */
function result(seq: number, callId: string, options: { readonly ok?: boolean; readonly text?: string } = {}): SessionEvent {
  return event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        isError: options.ok !== true,
        content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
      }],
    },
  })
}

/** One completed step. */
function stepEnd(seq: number): SessionEvent {
  return event('step/end', seq, { turn: 1, step: 1 })
}

/** One logged J-Space card carrying the given charter. */
function card(seq: number, charter: readonly { readonly id: string; readonly constraint: string }[]): SessionEvent {
  return event('jspace/card', seq, {
    seq: 1,
    sessionId: 'worker-session',
    goal: 'finish the assignment',
    core: [],
    checked: [],
    open: [],
    next: 'keep going',
    goalOpenedSeq: 0,
    charter,
  })
}

/** Digest caps with every bound explicit. */
function caps(overrides: Partial<WorkerDigestCaps> = {}): WorkerDigestCaps {
  return { maxTools: 12, maxChars: 4000, maxExcerpt: 200, maxArgs: 80, ...overrides }
}

describe('boundText', () => {
  it('returns short text unchanged and marks truncated text', () => {
    expect(boundText('abc', 5)).toBe('abc')
    expect(boundText('abcde', 5)).toBe('abcde')
    expect(boundText('abcdef', 5)).toBe('abcd' + TRUNCATION_MARKER)
  })
})

describe('argsExcerpt', () => {
  it('returns undefined for absent or empty arguments', () => {
    expect(argsExcerpt(undefined, 80)).toBeUndefined()
    expect(argsExcerpt('', 80)).toBeUndefined()
  })

  it('prefers the argument keys in priority order', () => {
    expect(argsExcerpt('{"command":"git log","file_path":"/tmp/a"}', 80)).toBe('git log')
    expect(argsExcerpt('{"file_path":"/tmp/a"}', 80)).toBe('/tmp/a')
    expect(argsExcerpt('{"path":"/tmp/b"}', 80)).toBe('/tmp/b')
    expect(argsExcerpt('{"target_file":"/tmp/c"}', 80)).toBe('/tmp/c')
    expect(argsExcerpt('{"url":"https://example.test"}', 80)).toBe('https://example.test')
    expect(argsExcerpt('{"query":"how to test"}', 80)).toBe('how to test')
    expect(argsExcerpt('{"question":"why?"}', 80)).toBe('why?')
  })

  it('falls back to the stringified record when no preferred key carries text', () => {
    expect(argsExcerpt('{"other":1,"command":""}', 80)).toBe('{"other":1,"command":""}')
    expect(argsExcerpt('{"other":"x"}', 80)).toBe('{"other":"x"}')
  })

  it('stringifies a parsed value that is not an object', () => {
    expect(argsExcerpt('"plain"', 80)).toBe('plain')
    expect(argsExcerpt('42', 80)).toBe('42')
    expect(argsExcerpt('null', 80)).toBe('null')
    expect(argsExcerpt('[1,2]', 80)).toBe('[1,2]')
  })

  it('bounds the excerpt, including a blob that does not parse as JSON', () => {
    expect(argsExcerpt('{"command":"0123456789"}', 8)).toBe('0123456' + TRUNCATION_MARKER)
    expect(argsExcerpt('not-json-at-all', 8)).toBe('not-jso' + TRUNCATION_MARKER)
  })
})

describe('foldTeamMessages', () => {
  it('folds an empty log to no assignment and no mail', () => {
    expect(foldTeamMessages([], 200, 4000)).toEqual({ assignment: '', mail: [], elided: 0 })
  })

  it('anchors on the first delivered team message and keeps later mail, oldest-first', () => {
    const folded = foldTeamMessages([
      teamMessage(1, 'ship the parser'),
      teamMessage(2, 'and the tests'),
      teamMessage(3, 'then stop'),
    ], 200, 4000)
    expect(folded).toEqual({ assignment: 'ship the parser', mail: ['and the tests', 'then stop'], elided: 0 })
  })

  it('skips human and machine user messages', () => {
    const folded = foldTeamMessages([
      humanMessage(1, 'a human prompt'),
      message(2, { kind: 'plugin', plugin: 'repeat-tool-reminder' }, [{ type: 'text', text: 'a reminder' }]),
      teamMessage(3, 'the assignment'),
    ], 200, 4000)
    expect(folded.assignment).toBe('the assignment')
    expect(folded.mail).toEqual([])
  })

  it('skips messages without text, including non-text-only content', () => {
    const folded = foldTeamMessages([
      message(1, { kind: 'team-message' }, []),
      message(2, { kind: 'team-message' }, [{ type: 'image', attachment: {} }]),
      message(3, { kind: 'team-message' }, [{ type: 'text', text: '   ' }]),
      message(4, { kind: 'team-message' }, [{ type: 'text', text: '' }, { type: 'text', text: 'kept' }]),
      message(5, { kind: 'team-message' }, [{ type: 'text', text: 'first line' }, { type: 'text', text: 'second line' }]),
    ], 200, 4000)
    expect(folded.assignment).toBe('kept')
    expect(folded.mail).toEqual(['first line\nsecond line'])
  })

  it('bounds each message and reports the mail the total cap dropped', () => {
    const folded = foldTeamMessages([
      teamMessage(1, 'assignment'),
      teamMessage(2, 'x'.repeat(10)),
      teamMessage(3, 'y'.repeat(10)),
      teamMessage(4, 'z'.repeat(10)),
    ], 5, 10)
    expect(folded.assignment).toBe('assi' + TRUNCATION_MARKER)
    // Each message is bounded first, then the newest bounded mail is retained to the total cap.
    expect(folded.mail).toEqual(['yyyy' + TRUNCATION_MARKER, 'zzzz' + TRUNCATION_MARKER])
    expect(folded.elided).toBe(1)
  })

  it('drops every later message when the total cap admits none', () => {
    const folded = foldTeamMessages([teamMessage(1, 'assignment'), teamMessage(2, 'later')], 200, 0)
    expect(folded).toEqual({ assignment: 'assignment', mail: [], elided: 1 })
  })
})

describe('foldWorkerCharter', () => {
  it('reports no lines without a card or without a charter', () => {
    expect(foldWorkerCharter([stepEnd(1)], 200)).toEqual([])
    expect(foldWorkerCharter([card(1, [])], 200)).toEqual([])
  })

  it('folds the latest card charter as bounded id-and-constraint lines', () => {
    const events = [
      card(1, [{ id: 'check-1', constraint: 'run pnpm test' }]),
      card(2, [{ id: 'check-2', constraint: 'never commit' }]),
    ]
    expect(foldWorkerCharter(events, 200)).toEqual(['check-2: never commit'])
    expect(foldWorkerCharter([card(1, [{ id: 'check-1', constraint: 'x'.repeat(20) }])], 10))
      .toEqual(['check-1: ' + TRUNCATION_MARKER])
  })
})

describe('foldWorkerDigest anchors', () => {
  it('anchors on the delivered team message and the charter', () => {
    const digest = foldWorkerDigest(sessionWith([
      teamMessage(1, 'ship the parser'),
      teamMessage(2, 'and the tests'),
      card(3, [{ id: 'check-1', constraint: 'run pnpm test' }]),
    ], 3), caps())
    expect(digest.assignment).toBe('ship the parser')
    expect(digest.mail).toEqual(['and the tests'])
    expect(digest.charter).toEqual(['check-1: run pnpm test'])
    expect(digest.sessionId).toBe('worker-session')
    expect(digest.seq).toBe(3)
  })

  it('anchors on nothing when the log carries only human messages', () => {
    // The human-message fold anchors on this very message; a delegated worker
    // has no human, so the worker digest must not adopt it.
    const digest = foldWorkerDigest(sessionWith([
      humanMessage(1, 'a human prompt that is not the Lead\'s assignment'),
      stepEnd(2),
    ], 2), caps())
    expect(digest.assignment).toBe('')
    expect(digest.mail).toEqual([])
    expect(digest.elidedMail).toBe(0)
    expect(digest.charter).toEqual([])
    expect(renderWorkerDigest(digest)).toContain("Assignment (the Lead's team message): (none recorded)")
  })

  it('counts completed steps and echoes the caps it applied', () => {
    const digest = foldWorkerDigest(sessionWith([stepEnd(1), stepEnd(2)], 2), caps({ maxTools: 3, maxChars: 100 }))
    expect(digest.steps).toBe(2)
    expect(digest.maxTools).toBe(3)
    expect(digest.maxChars).toBe(100)
  })

  it('keeps the trailing tool window and bounds it by maxTools', () => {
    const events: SessionEvent[] = []
    for (let index = 0; index < 4; index += 1) {
      events.push(call(index * 2, 'c' + String(index), 'tool' + String(index), '{"command":"run ' + String(index) + '"}'))
      events.push(result(index * 2 + 1, 'c' + String(index), { ok: true }))
    }
    const digest = foldWorkerDigest(sessionWith(events, 8), caps({ maxTools: 2 }))
    expect(digest.recentTools).toEqual([
      { seq: 4, name: 'tool2', ok: true, argsExcerpt: 'run 2' },
      { seq: 6, name: 'tool3', ok: true, argsExcerpt: 'run 3' },
    ])
  })

  it('records error excerpts only for failures and bounds the argument excerpt', () => {
    const digest = foldWorkerDigest(sessionWith([
      call(1, 'c1', 'bash', '{"command":"' + 'x'.repeat(20) + '"}'),
      result(2, 'c1', { ok: true, text: 'all good' }),
      call(3, 'c2', 'bash', '{"command":"pnpm test"}'),
      result(4, 'c2', { text: 'boom' }),
      call(5, 'c3', 'bash'),
      result(6, 'c3', { text: '' }),
    ], 6), caps({ maxArgs: 6, maxExcerpt: 4 }))
    expect(digest.recentTools).toEqual([
      { seq: 1, name: 'bash', ok: true, argsExcerpt: 'xxxxx' + TRUNCATION_MARKER },
      { seq: 3, name: 'bash', ok: false, argsExcerpt: 'pnpm ' + TRUNCATION_MARKER, errorExcerpt: 'boom' },
      { seq: 5, name: 'bash', ok: false },
    ])
  })

  it('skips tool signals without both a call and its result', () => {
    const digest = foldWorkerDigest(sessionWith([
      call(1, 'orphan', 'bash'),
      call(2, 'c1', 'bash', '{"command":"pnpm test"}'),
      result(3, 'unmatched'),
      result(4, 'c1'),
    ], 4), caps())
    expect(digest.recentTools).toEqual([{ seq: 2, name: 'bash', ok: false, argsExcerpt: 'pnpm test' }])
  })
})

describe('renderWorkerDigest', () => {
  it('renders the identity, the assignment, the charter, the mail, the steps, and the tools in order', () => {
    const digest = foldWorkerDigest(sessionWith([
      teamMessage(1, 'ship the parser'),
      card(2, [{ id: 'check-1', constraint: 'run pnpm test' }]),
      teamMessage(3, 'and the tests'),
      call(4, 'c1', 'bash', '{"command":"pnpm test"}'),
      result(5, 'c1', { text: 'failing' }),
      stepEnd(6),
    ], 6), caps())
    const render = renderWorkerDigest(digest)
    expect(render).toContain('Worker session id: worker-session')
    expect(render).toContain('Folded through seq: 6')
    expect(render).toContain("Assignment (the Lead's team message): ship the parser")
    expect(render).toContain('Charter:\ncheck-1: run pnpm test')
    expect(render).toContain('Later team mail:\nM1: and the tests')
    expect(render).toContain('Completed steps: 1')
    expect(render).toContain('Recent tool outcomes:\nFAIL bash seq=4 pnpm test: failing')
    expect(render.indexOf('Assignment')).toBeLessThan(render.indexOf('Charter:'))
    expect(render.indexOf('Charter:')).toBeLessThan(render.indexOf('Later team mail:'))
    expect(render.indexOf('Later team mail:')).toBeLessThan(render.indexOf('Recent tool outcomes:'))
  })

  it('renders a successful tool signal without an error excerpt', () => {
    const digest = foldWorkerDigest(sessionWith([
      call(1, 'c1', 'read', '{"file_path":"/tmp/a"}'),
      result(2, 'c1', { ok: true }),
    ], 2), caps())
    expect(renderWorkerDigest(digest)).toContain('Recent tool outcomes:\nok read seq=1 /tmp/a')
  })

  it('renders a failure with neither an argument nor an error excerpt', () => {
    const digest = foldWorkerDigest(sessionWith([
      call(1, 'c1', 'bash'),
      result(2, 'c1', { text: '' }),
    ], 2), caps())
    expect(renderWorkerDigest(digest)).toContain('Recent tool outcomes:\nFAIL bash seq=1')
  })

  it('renders the elided mail count ahead of the retained mail', () => {
    const digest = foldWorkerDigest(sessionWith([
      teamMessage(1, 'assignment'),
      teamMessage(2, 'a'.repeat(80)),
      teamMessage(3, 'b'.repeat(80)),
      teamMessage(4, 'c'.repeat(80)),
    ], 4), caps({ maxExcerpt: 80, maxChars: 200 }))
    expect(digest.elidedMail).toBe(1)
    const render = renderWorkerDigest(digest)
    expect(render).toContain('(1 earlier team messages elided)')
    expect(render.indexOf('(1 earlier team messages elided)')).toBeLessThan(render.indexOf('M1:'))
  })

  it('caps the complete render at maxChars, eating the trailing tools first', () => {
    const digest = foldWorkerDigest(sessionWith([
      teamMessage(1, 'ship the parser'),
      call(2, 'c1', 'bash', '{"command":"pnpm test"}'),
      result(3, 'c1', { ok: true }),
    ], 3), caps({ maxChars: 120 }))
    const render = renderWorkerDigest(digest)
    expect(render.length).toBeLessThanOrEqual(120)
    expect(render.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(render.startsWith('Worker session id: worker-session')).toBe(true)
    expect(render).toContain("Assignment (the Lead's team message): ship the parser")
    expect(render).not.toContain('Recent tool outcomes:')
  })
})
