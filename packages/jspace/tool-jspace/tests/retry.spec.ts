/** Repeat-refuse while a J-Space card is open. */

import { describe, expect, it } from 'vitest'
import { CallId } from '@shres-code/shres-code-llm'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { REPEAT_DENY, canonicalizeArgs, shouldRefuseRepeat } from '../src/retry.ts'

function call(name: string, args: string, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: args },
  } as SessionEvent
}

function card(): SessionEvent {
  return { type: 'jspace/card', seq: 2, time: 1, data: {} } as SessionEvent
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

  it('canonicalizes logged strings and live objects the same way', () => {
    expect(canonicalizeArgs('{"cmd":"ls"}')).toBe(canonicalizeArgs({ cmd: 'ls' }))
    expect(canonicalizeArgs('{')).toBe('{')
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(canonicalizeArgs(circular)).toBe('')
    expect(REPEAT_DENY).toContain('jspace_note')
  })
})
