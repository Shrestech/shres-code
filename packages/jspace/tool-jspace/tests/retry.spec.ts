/** Retry and placeholder refusals while a J-Space card is open. */

import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { JSPACE_ALWAYS_OPEN_GOAL } from '@shres-code/shres-code-jspace'
import type { JspaceCard } from '@shres-code/shres-code-jspace'
import {
  PLACEHOLDER_DENY,
  REPEAT_DENY,
  canonicalizeArgs,
  shouldRefusePlaceholder,
  shouldRefuseRepeat,
} from '../src/retry.ts'

function call(name: string, args: string, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: args },
  } as SessionEvent
}

function result(callId: string, isError: boolean): SessionEvent {
  return {
    type: 'tool/result',
    seq: 2,
    time: 1,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId(callId),
        content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
        isError,
      }),
    },
  } as SessionEvent
}

function openCard(goal = 'Ship W3', over: Partial<JspaceCard> = {}): JspaceCard {
  return {
    seq: 1,
    sessionId: 's',
    goal,
    core: [],
    checked: [],
    open: [],
    next: 'Write tests',
    goalOpenedSeq: 1,
    ...over,
  }
}

function card(value = openCard()): SessionEvent {
  return { type: 'jspace/card', seq: 3, time: 2, data: value } as SessionEvent
}

function turn(): SessionEvent {
  return { type: 'turn/start', seq: 4, time: 3, data: { turn: 2 } } as SessionEvent
}

describe('shouldRefuseRepeat', () => {
  it('allows the first call, successful repeats, and card tools', () => {
    expect(shouldRefuseRepeat([], 'bash', { cmd: 'ls' }, 'now')).toBe(false)
    expect(shouldRefuseRepeat(
      [call('bash', '{"cmd":"ls"}', 'old'), result('old', false)],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
    expect(shouldRefuseRepeat(
      [call('jspace_note', '{"next":"x"}', 'old'), result('old', true)],
      'jspace_note',
      { next: 'x' },
      'now',
    )).toBe(false)
  })

  it('refuses an identical failed call while Goal, Core, Open, and Next are unchanged', () => {
    expect(shouldRefuseRepeat(
      [card(), call('bash', '{"cmd":"ls"}', 'old'), result('old', true)],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(true)
  })

  it('skips the in-flight call already logged by the loop', () => {
    expect(shouldRefuseRepeat(
      [card(), call('bash', '{"cmd":"ls"}', 'now')],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(false)
  })

  it('allows retry after Goal, Core, Open, or Next changes', () => {
    const previous = openCard()
    const mutations = [
      openCard('New goal'),
      openCard(undefined, { core: ['Diagnosis'] }),
      openCard(undefined, { open: [{ question: 'Why?' }] }),
      openCard(undefined, { next: 'Try another path' }),
    ]
    for (const mutation of mutations) {
      expect(shouldRefuseRepeat(
        [card(previous), call('bash', '{"cmd":"ls"}', 'old'), result('old', true), card(mutation)],
        'bash',
        { cmd: 'ls' },
        'now',
      )).toBe(false)
    }
  })

  it('does not treat a checkpoint-only card write as a changed diagnosis', () => {
    const previous = openCard()
    const checkpoint = openCard(undefined, {
      seq: 2,
      checked: [{ n: 1, check: 'read', by: 'unit tests', evidence: 'old' }],
    })
    expect(shouldRefuseRepeat(
      [card(previous), call('bash', '{"cmd":"ls"}', 'old'), result('old', true), card(checkpoint)],
      'bash',
      { cmd: 'ls' },
      'now',
    )).toBe(true)
  })

  it('allows a different call and resets on a later turn or close', () => {
    const history = [card(), call('bash', '{"cmd":"ls"}', 'old'), result('old', true)]
    expect(shouldRefuseRepeat(history, 'bash', { cmd: 'pwd' }, 'now')).toBe(false)
    expect(shouldRefuseRepeat([...history, turn()], 'bash', { cmd: 'ls' }, 'now')).toBe(false)
    const close = { type: 'jspace/closed', seq: 5, time: 4, data: {} } as SessionEvent
    expect(shouldRefuseRepeat([...history, close], 'bash', { cmd: 'ls' }, 'now')).toBe(false)
  })

  it('allows a retry when compaction shadowed the failed result', () => {
    const history = [card(), call('bash', '{"cmd":"ls"}', 'old'), result('old', true)]
    expect(shouldRefuseRepeat(
      history,
      'bash',
      { cmd: 'ls' },
      'now',
      [history[0]?.seq ?? 0],
    )).toBe(false)
    expect(shouldRefuseRepeat(
      history,
      'bash',
      { cmd: 'ls' },
      'now',
      [history[0]?.seq ?? 0, history[2]?.seq ?? 0],
    )).toBe(true)
  })

  it('canonicalizes object key order and handles opaque or circular arguments', () => {
    expect(canonicalizeArgs('{"b":2,"a":1}')).toBe(canonicalizeArgs({ a: 1, b: 2 }))
    expect(canonicalizeArgs('{')).toBe('{')
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(canonicalizeArgs(circular)).toBe('')
    expect(REPEAT_DENY).toContain('same failed tool call')
  })
})

describe('shouldRefusePlaceholder', () => {
  it('denies non-card tools while Goal is the placeholder and exempts card tools', () => {
    expect(shouldRefusePlaceholder(openCard(JSPACE_ALWAYS_OPEN_GOAL), 'bash')).toBe(true)
    expect(shouldRefusePlaceholder(openCard(JSPACE_ALWAYS_OPEN_GOAL), 'jspace_note')).toBe(false)
    expect(shouldRefusePlaceholder(openCard(), 'bash')).toBe(false)
    expect(PLACEHOLDER_DENY).toContain('placeholder Goal')
    expect(PLACEHOLDER_DENY).toContain('jspace_note')
  })
})
