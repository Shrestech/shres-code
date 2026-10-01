import { describe, expect, it } from 'vitest'
import { SubagentRouteRequestId } from '@shres-code/shres-code-subagent'
import type { ChildTurnOutcome } from '@shres-code/shres-code-subagent'
import type { SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import {
  classifyChildTurn,
  outcomeKey,
  outcomesFromChildTurns,
  recordedChildOutcomes,
  routedChildDecisions,
  suspendedChildCandidates,
} from '../src/child-outcomes.ts'
import type { ModelRoutingChildDecision } from '../src/types.ts'

const SELECTION = { candidateId: 'cheap', provider: 'cheap-provider', model: 'cheap-model' }

function turn(kind: ChildTurnOutcome['reason']['kind'], route = SELECTION, extra: Partial<ChildTurnOutcome> = {}): ChildTurnOutcome {
  const reason: TurnEndReason = kind === 'error'
    ? { kind: 'error', error: { code: 'QUOTA', message: 'quota' } }
    : kind === 'aborted'
      ? { kind: 'aborted', reason: { kind: 'user' } }
      : { kind }
  return { turn: 1, reason, route: { provider: route.provider, model: route.model }, ...extra }
}

describe('classifyChildTurn', () => {
  it('counts completed-on-selection as success', () => {
    expect(classifyChildTurn(turn('completed'), SELECTION)).toEqual({ countedAs: 'success' })
  })

  it('counts LlmError codes other than UNKNOWN on-selection as failure', () => {
    expect(classifyChildTurn(turn('error'), SELECTION)).toEqual({ countedAs: 'failure', failureCode: 'QUOTA' })
    for (const code of ['SERVER', 'TRANSPORT'] as const) {
      const known: ChildTurnOutcome = {
        turn: 1,
        reason: { kind: 'error', error: { code, message: code.toLowerCase() } },
        route: SELECTION,
      }
      expect(classifyChildTurn(known, SELECTION)).toEqual({ countedAs: 'failure', failureCode: code })
    }
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

  it('ignores inactive mode, a second sighting of the same pool id, and unrelated events', () => {
    const events: SessionEvent[] = [
      { type: 'request/header', seq: 0, time: 0, data: {} } as SessionEvent,
      { type: 'model-routing/mode', seq: 1, time: 1, data: { mode: 'off', active: false } } as SessionEvent,
      decision(2),
      decision(3),
      outcome(4, 'failure'),
    ]
    expect([...suspendedChildCandidates(events, 2)]).toEqual([])
  })

  it('resets a newly seen pool candidate and a configuration that becomes active', () => {
    const events: SessionEvent[] = [
      outcome(1, 'failure'),
      {
        type: 'model-routing/child-decision',
        seq: 2,
        time: 2,
        data: {
          outcome: 'routed',
          reason: 'child-policy',
          routeRequestId: 'r2',
          childKind: 'subagent',
          policyIndex: 0,
          inherited: {},
          selection: { candidateId: 'cheap', provider: 'cheap-provider', model: 'cheap-model' },
          effortApplied: false,
          promptChars: 1,
        },
      } as SessionEvent,
      { type: 'model-routing/configuration', seq: 3, time: 3, data: { mode: 'on', active: true } } as SessionEvent,
      outcome(4, 'failure'),
    ]
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

  it('reads recorded outcomes and ignores unrelated events', () => {
    const events = [
      { type: 'request/header', seq: 0, time: 0, data: {} },
      {
        type: 'model-routing/child-outcome',
        seq: 1,
        time: 1,
        data: {
          routeRequestId: 'r1',
          candidateId: 'cheap',
          childSessionId: 'child',
          childTurn: 1,
          route: { provider: SELECTION.provider, model: SELECTION.model },
          turnEnd: 'completed',
          countedAs: 'success',
        },
      },
    ] as SessionEvent[]
    expect(recordedChildOutcomes(events).has(outcomeKey('r1', 1))).toBe(true)
  })

  it('skips unavailable, mismatched ids, and already-recorded turns', () => {
    expect(outcomesFromChildTurns(decision, 'child', { unavailable: 'missing' }, new Map())).toEqual([])
    expect(outcomesFromChildTurns(decision, 'child', { routeRequestId: SubagentRouteRequestId('other'), turns: [] }, new Map())).toEqual([])
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
      routeRequestId: SubagentRouteRequestId('r1'),
      turns: [turn('completed')],
    }, recorded)).toEqual([])
  })

  it('appends a success without runId or reconciled', () => {
    expect(outcomesFromChildTurns(decision, 'child', {
      routeRequestId: SubagentRouteRequestId('r1'),
      turns: [turn('completed')],
    }, new Map())).toEqual([{
      routeRequestId: 'r1',
      candidateId: 'cheap',
      childSessionId: 'child',
      childTurn: 1,
      route: { provider: SELECTION.provider, model: SELECTION.model },
      turnEnd: 'completed',
      countedAs: 'success',
    }])
  })

  it('appends a classified failure with runId and reconciled', () => {
    const rows = outcomesFromChildTurns(decision, 'child', {
      routeRequestId: SubagentRouteRequestId('r1'),
      turns: [turn('error'), { turn: 2, reason: { kind: 'completed' } }],
    }, new Map(), 'run-1', true)
    expect(rows).toEqual([{
      routeRequestId: 'r1',
      candidateId: 'cheap',
      childSessionId: 'child',
      childTurn: 1,
      route: { provider: SELECTION.provider, model: SELECTION.model },
      turnEnd: 'error',
      failureCode: 'QUOTA',
      countedAs: 'failure',
      runId: 'run-1',
      reconciled: true,
    }])
  })

  it('skips a decision with no selection', () => {
    const { selection: _selection, ...withoutSelection } = decision
    const kept: ModelRoutingChildDecision = { ...withoutSelection, outcome: 'kept' }
    expect(outcomesFromChildTurns(kept, 'child', {
      routeRequestId: SubagentRouteRequestId('r1'),
      turns: [turn('completed')],
    }, new Map())).toEqual([])
  })
})

describe('routedChildDecisions', () => {
  it('returns only routed decisions that carry a selection', () => {
    const events = [
      {
        type: 'model-routing/child-decision',
        seq: 0,
        time: 0,
        data: {
          outcome: 'kept',
          reason: 'base-unlisted',
          routeRequestId: 'r0',
          childKind: 'subagent',
          policyIndex: 0,
          inherited: {},
          effortApplied: false,
          promptChars: 1,
        },
      },
      {
        type: 'model-routing/child-decision',
        seq: 1,
        time: 1,
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
      },
    ] as SessionEvent[]
    expect(routedChildDecisions([
      { type: 'request/header', seq: 9, time: 9, data: {} } as SessionEvent,
      ...events,
    ]).map(row => row.decision.routeRequestId)).toEqual(['r1'])
  })
})
