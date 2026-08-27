/** Repeat-refuse while a J-Space card is open. */

import { describe, expect, it } from 'vitest'
import { CallId } from '@shres-code/shres-code-llm'
import type { SessionEvent } from '@shres-code/shres-code-session'
import {
  DEFAULT_MAX_NOTES_PER_TURN,
  REPEAT_DENY,
  canonicalizeArgs,
  countNotesThisTurn,
  noteCapDeny,
  shouldRefuseNoteCap,
  shouldRefuseRepeat,
} from '../src/retry.ts'

function call(name: string, args: string, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: args },
  }
}

function card(): SessionEvent {
  return { type: 'jspace/card', seq: 2, time: 1, data: {} } as SessionEvent
}

function turn(): SessionEvent {
  return { type: 'turn/start', seq: 3, time: 2, data: {} } as SessionEvent
}

describe('shouldRefuseRepeat', () => {
  it('allows the first call and card tools', () => {
    expect(shouldRefuseRepeat([undefined as unknown as SessionEvent], 'bash', { cmd: 'ls' }, 'now')).toBe(false)
    expect(shouldRefuseRepeat([], 'bash', { cmd: 'ls' }, 'now')).toBe(false)
    expect(shouldRefuseRepeat([call('jspace_note', '{"next":"x"}')], 'jspace_note', { next: 'x' }, 'now'))
      .toBe(false)
  })

  it('refuses the same name and arguments after a prior call', () => {
    const chatter = { type: 'assistant/message', seq: 0, time: 0, data: {} } as SessionEvent
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'prev'), chatter],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(true)
  })

  it('skips the in-flight call id already logged by the loop', () => {
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'now')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
  })

  it('allows a repeat after a card write and allows a different tool', () => {
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'prev'), card()],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'prev')],
      'read',
      { path: 'a' },
      'now',
    )).toBe(false)
  })

  it('refuses an identical call hidden behind a different tool since the last card write', () => {
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'a'), call('read', '{"path":"x"}', 'b')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(true)
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'a'), card(), call('read', '{"path":"x"}', 'b')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
  })

  it('refuses an identical call hidden behind a same-tool run with different arguments', () => {
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'a'), call('bash', '{"cmd":"pwd"}', 'b')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(true)
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"pwd"}', 'a')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
  })

  it('allows an identical re-issue in a later turn', () => {
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'a'), turn()],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
    expect(shouldRefuseRepeat(
      [turn(), call('bash', '{"cmd":"ls"}', 'a'), call('read', '{"path":"x"}', 'b'), turn()],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'a'), call('read', '{"path":"x"}', 'b'), turn(), call('read', '{"path":"y"}', 'c')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
  })

  it('canonicalizes logged strings and live objects the same way', () => {
    expect(canonicalizeArgs('{"cmd":"ls"}')).toBe(canonicalizeArgs({ cmd: 'ls' }))
    expect(canonicalizeArgs('{')).toBe('{')
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(canonicalizeArgs(circular)).toBe('')
    expect(REPEAT_DENY).toContain('jspace_note')
  })
})

describe('shouldRefuseNoteCap', () => {
  it('counts jspace_note calls since the last turn/start and skips the in-flight id', () => {
    expect(countNotesThisTurn([])).toBe(0)
    expect(countNotesThisTurn([undefined as unknown as SessionEvent])).toBe(0)
    expect(countNotesThisTurn([
      call('jspace_note', '{"next":"a"}', 'n1'),
      call('bash', '{"cmd":"ls"}', 'b1'),
      call('jspace_note', '{"next":"b"}', 'n2'),
    ], 'now')).toBe(2)
    expect(countNotesThisTurn([
      call('jspace_note', '{"next":"a"}', 'n1'),
      call('jspace_note', '{"next":"b"}', 'now'),
    ], 'now')).toBe(1)
    expect(countNotesThisTurn([
      call('jspace_note', '{"next":"old"}', 'prev'),
      turn(),
      call('jspace_note', '{"next":"a"}', 'n1'),
    ])).toBe(1)
  })

  it('refuses the next jspace_note once the turn budget is spent', () => {
    const notes = [
      call('jspace_note', '{"next":"1"}', 'n1'),
      call('jspace_note', '{"next":"2"}', 'n2'),
    ]
    expect(shouldRefuseNoteCap(notes, 'jspace_note', 2, 'now')).toBe(true)
    expect(shouldRefuseNoteCap(notes, 'jspace_note', 3, 'now')).toBe(false)
    expect(shouldRefuseNoteCap(notes, 'bash', 1, 'now')).toBe(false)
    expect(shouldRefuseNoteCap([
      call('jspace_note', '{"next":"1"}', 'n1'),
      card(),
      call('jspace_note', '{"next":"2"}', 'n2'),
    ], 'jspace_note', 2, 'now')).toBe(true)
    expect(shouldRefuseNoteCap([
      call('jspace_note', '{"next":"1"}', 'n1'),
      call('jspace_note', '{"next":"2"}', 'n2'),
      turn(),
    ], 'jspace_note', 2, 'now')).toBe(false)
    expect(DEFAULT_MAX_NOTES_PER_TURN).toBe(8)
    expect(noteCapDeny(8)).toBe(
      'jspace_note is limited to 8 calls this turn; write a checkpoint or do the work instead.',
    )
  })
})
