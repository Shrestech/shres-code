import { describe, expect, it } from 'vitest'
import type { ChildTurnOutcome } from '@shres-code/shres-code-subagent'
import type { SessionEvent } from '@shres-code/shres-code-session'
import {
  classifyChildTurn,
  outcomeKey,
  outcomesFromChildTurns,
  recordedChildOutcomes,
  suspendedChildCandidates,
} from '../src/child-outcomes.ts'
import type { ModelRoutingChildDecision } from '../src/types.ts'

const SELECTION = { candidateId: 'cheap', provider: 'cheap-provider', model: 'cheap-model' }

function turn(kind: ChildTurnOutcome['reason']['kind'], route = SELECTION, extra: Partial<ChildTurnOutcome> = {}): ChildTurnOutcome {
  const reason = kind === 'error'
    ? { kind: 'error' as const, error: { code: 'QUOTA', message: 'quota' } }
    : { kind }
  return { turn: 1, reason, route: { provider: route.provider, model: route.model }, ...extra }
}

describe('classifyChildTurn', () => {
  it('counts completed-on-selection as success', () => {
    expect(classifyChildTurn(turn('completed'), SELECTION)).toEqual({ countedAs: 'success' })
  })

  it('counts LlmError codes other than UNKNOWN on-selection as failure', () => {
    expect(classifyChildTurn(turn('error'), SELECTION)).toEqual({ countedAs: 'failure', failureCode: 'QUOTA' })
    const unknown: ChildTurnOutcome = {
      turn: 1,
      reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'tool' } },
      route: SELECTION,
    }
    expect(classifyChildTurn(unknown, SELECTION)).toEqual({ countedAs: 'neutral' })
  })

  it('treats max-tokens, aborted, interrupted, and blocked as neutral', () => {
    for (const kind of ['max-tokens', 'aborted', 'interrupted', 'blocked'] as const) {
      expect(classifyChildTurn(turn(kind), SELECTION)).toEqual({ countedAs: 'neutral' })
    }
  })

  it('treats an error off the selection as neutral', () => {
    expect(classifyChildTurn(turn('error', { candidateId: 'x', provider: 'other', model: 'other' }), SELECTION))
      .toEqual({ countedAs: 'neutral' })
  })
})

describe('suspendedChildCandidates', () => {
  const decision = (seq: number): SessionEvent => ({
    type: 'model-routing/child-decision',
    seq,
    time: seq,
    data: {
      outcome: 'routed',
      reason: 'child-policy',
      routeRequestId: 'r1',
      childKind: 'subagent',
      policyIndex: 0,
      inherited: {},
      selection: SELECTION,
      effortApplied: false,
      promptChars: 1,
    },
  } as SessionEvent)
  const outcome = (seq: number, countedAs: 'failure' | 'success' | 'neutral', candidateId = 'cheap'): SessionEvent => ({
    type: 'model-routing/child-outcome',
    seq,
    time: seq,
    data: {
      routeRequestId: 'r1',
      candidateId,
      childSessionId: 'child',
      childTurn: seq,
      route: SELECTION,
      turnEnd: countedAs === 'success' ? 'completed' : 'error',
      countedAs,
    },
  } as SessionEvent)

  it('suspends after N consecutive failures and skips neutrals', () => {
    const events = [decision(0), outcome(1, 'failure'), outcome(2, 'neutral'), outcome(3, 'failure')]
    expect([...suspendedChildCandidates(events, 2)]).toEqual(['cheap'])
  })

  it('resets on success', () => {
    const events = [decision(0), outcome(1, 'failure'), outcome(2, 'success'), outcome(3, 'failure')]
    expect([...suspendedChildCandidates(events, 2)]).toEqual([])
  })

  it('resets on mode becoming active', () => {
    const events: SessionEvent[] = [
      decision(0),
      outcome(1, 'failure'),
      { type: 'model-routing/mode', seq: 2, time: 2, data: { mode: 'on', active: true } } as SessionEvent,
      outcome(3, 'failure'),
    ]
    expect([...suspendedChildCandidates(events, 2)]).toEqual([])
  })
})

describe('outcomesFromChildTurns', () => {
  const decision: ModelRoutingChildDecision = {
    outcome: 'routed',
    reason: 'child-policy',
    routeRequestId: 'r1',
    childKind: 'subagent',
    policyIndex: 0,
    inherited: {},
    selection: SELECTION,
    effortApplied: false,
    promptChars: 1,
  }

  it('skips unavailable, mismatched ids, and already-recorded turns', () => {
    expect(outcomesFromChildTurns(decision, 'child', { unavailable: 'missing' }, new Map())).toEqual([])
    expect(outcomesFromChildTurns(decision, 'child', { routeRequestId: 'other', turns: [] }, new Map())).toEqual([])
    const recorded = recordedChildOutcomes([])
    recorded.set(outcomeKey('r1', 1), {
      routeRequestId: 'r1',
      candidateId: 'cheap',
      childSessionId: 'child',
      childTurn: 1,
      route: SELECTION,
      turnEnd: 'completed',
      countedAs: 'success',
    })
    expect(outcomesFromChildTurns(decision, 'child', {
      routeRequestId: 'r1',
      turns: [turn('completed')],
    }, recorded)).toEqual([])
  })
})
