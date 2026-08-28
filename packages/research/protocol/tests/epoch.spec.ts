import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@shres-code/shres-code-session'
import {
  completedDebateCalls,
  DESIGN_DEFENSE_DENY_PREFIX,
  designDefenseDeny,
  missingDebateTools,
} from '../src/epoch.ts'

let seq = 0

function callEvent(name: string, callId: string): SessionEvent {
  seq += 1
  return { type: 'tool/call', seq, data: { callId, name } } as unknown as SessionEvent
}

function resultEvent(callId: string, isError = false): SessionEvent {
  seq += 1
  return {
    type: 'tool/result',
    seq,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', isError: isError ? true : undefined }],
      },
    },
  } as unknown as SessionEvent
}

function completed(name: string, callId: string): SessionEvent[] {
  return [callEvent(name, callId), resultEvent(callId)]
}

describe('completedDebateCalls', () => {
  it('credits a call only when a non-error result follows', () => {
    const events = [...completed('aegis', 'a1'), callEvent('ward', 'w1')]
    const found = completedDebateCalls(events, ['aegis', 'ward'], 0)
    expect([...found.keys()]).toEqual(['aegis'])
  })

  it('withholds a call whose result is an error', () => {
    const events = [callEvent('aegis', 'a1'), resultEvent('a1', true)]
    expect(completedDebateCalls(events, ['aegis'], 0).size).toBe(0)
  })

  it('ignores calls strictly before the anchor, counting the anchor itself', () => {
    const events = completed('aegis', 'a1')
    const callSeq = events[0]!.seq
    expect(completedDebateCalls(events, ['aegis'], callSeq).size).toBe(1)
    expect(completedDebateCalls(events, ['aegis'], callSeq + 1).size).toBe(0)
  })

  it('keeps the latest call per tool and drops results of earlier calls', () => {
    const events = [...completed('aegis', 'a1'), callEvent('aegis', 'a2'), resultEvent('a2')]
    const found = completedDebateCalls(events, ['aegis'], 0)
    expect(found.get('aegis')?.callId).toBe('a2')
  })

  it('keeps the latest call even when it arrives out of order, uncredited without its result', () => {
    const events: SessionEvent[] = [
      { type: 'tool/call', seq: 5, data: { callId: 'late', name: 'aegis' } } as unknown as SessionEvent,
      { type: 'tool/call', seq: 3, data: { callId: 'early', name: 'aegis' } } as unknown as SessionEvent,
      resultEvent('early'),
    ]
    expect(completedDebateCalls(events, ['aegis'], 0).size).toBe(0)
    const withLateResult = [...events, resultEvent('late')]
    expect(completedDebateCalls(withLateResult, ['aegis'], 0).get('aegis')?.callId).toBe('late')
  })

  it('ignores a watched call whose event carries no call id', () => {
    const events: SessionEvent[] = [
      { type: 'tool/call', seq: 1, data: { name: 'aegis' } } as unknown as SessionEvent,
    ]
    expect(completedDebateCalls(events, ['aegis'], 0).size).toBe(0)
  })

  it('ignores unrelated tools and unwatched events', () => {
    const events = [...completed('bash', 'b1'), callEvent('aegis', 'a1')]
    expect(completedDebateCalls(events, ['aegis'], 0).size).toBe(0)
  })
})

describe('missingDebateTools', () => {
  it('lists every tool when the log is empty', () => {
    expect(missingDebateTools([], ['aegis', 'ward'], 0)).toEqual(['aegis', 'ward'])
  })

  it('preserves configured order for the partially satisfied set', () => {
    const events = completed('ward', 'w1')
    expect(missingDebateTools(events, ['aegis', 'ward'], 0)).toEqual(['aegis'])
    expect(missingDebateTools(events, ['ward', 'aegis'], 0)).toEqual(['aegis'])
  })

  it('returns empty when every debate tool completed in the epoch', () => {
    const events = [...completed('aegis', 'a1'), ...completed('ward', 'w1')]
    expect(missingDebateTools(events, ['aegis', 'ward'], 0)).toEqual([])
  })
})

describe('designDefenseDeny', () => {
  it('names the missing tools after the stable prefix', () => {
    const reason = designDefenseDeny(['aegis', 'ward'])
    expect(reason.startsWith(DESIGN_DEFENSE_DENY_PREFIX)).toBe(true)
    expect(reason).toBe(
      `${DESIGN_DEFENSE_DENY_PREFIX}: completed calls missing for: aegis, ward`,
    )
  })

  it('names a single tool without a trailing separator', () => {
    expect(designDefenseDeny(['ward']).endsWith('ward')).toBe(true)
  })
})
