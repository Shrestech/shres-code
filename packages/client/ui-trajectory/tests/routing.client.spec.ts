/**
 * Model-routing projections: the decision row, its streak transitions, the
 * effective route a request row reports, and where the decision lands in the
 * turn fold.
 */
import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot, RequestView } from '@shres-code/shres-code-client-runtime/client'
import type { TrajectoryRoutingDecision } from '../src/client/trajectory-contract.ts'
import { deriveTrajectoryLayout } from '../src/client/layout.ts'
import { ROUTING_BREAK_KEYS, ROUTING_REASON_KEYS, en } from '../src/client/locales.ts'
import {
  trajectoryRequestRoute, trajectoryRoutingRow, trajectoryRoutingStreak,
} from '../src/client/trajectory-routing.ts'

type AssistantRequest = Extract<RequestView, { purpose: 'assistant' }>

/** Fields a real decision leaves out entirely, so the fixture must drop them. */
type DecisionOmission = 'selection' | 'route' | 'turn' | 'step'

function decision(
  overrides: Partial<TrajectoryRoutingDecision> = {},
  omit: readonly DecisionOmission[] = [],
): TrajectoryRoutingDecision {
  const dropped = new Set<string>(omit)
  return {
    seq: 6,
    time: 1_700_000_000_006,
    ...(dropped.has('turn') ? {} : { turn: 1 }),
    ...(dropped.has('step') ? {} : { step: 1 }),
    outcome: 'downgraded',
    reason: 'gate-passed',
    stateHash: 'd0157f83',
    stateSeqs: [4],
    ...(dropped.has('selection')
      ? {}
      : {
        selection: {
          candidateId: 'flash',
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'high',
        },
      }),
    ...(dropped.has('route')
      ? {}
      : { route: { choice: 'flash', confidence: 0.9, probabilities: { flash: 0.9 } } }),
    sticky: {
      active: true,
      routeErrorLimit: 2,
      stepsElapsed: 0,
      enteredTurn: 1,
      entryBase: { provider: 'deepseek-official', model: 'deepseek-v4.1' },
    },
    ...overrides,
  } as unknown as TrajectoryRoutingDecision
}

function assistantRequest(overrides: Partial<AssistantRequest> = {}): AssistantRequest {
  return {
    purpose: 'assistant',
    startSeq: 7,
    turn: 1,
    step: 1,
    startedAt: 1_700_000_000_007,
    completedAt: 1_700_000_000_014,
    status: 'complete',
    provenance: { provider: 'p', model: 'cheap' },
    ...overrides,
  }
}

function nodes(): ConversationSnapshot['nodes'] {
  return [
    { kind: 'user', seq: 4, time: 1_700_000_000_004, content: [], source: null },
    {
      kind: 'assistant', seq: 14, time: 1_700_000_000_014, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'ROUTED_OK' }],
      provenance: { provider: 'p', model: 'cheap' },
    },
  ] as unknown as ConversationSnapshot['nodes']
}

describe('trajectoryRoutingStreak', () => {
  it('reads the entering turn, a held streak, and a broken one', () => {
    expect(trajectoryRoutingStreak(decision({
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0, enteredTurn: 5 },
    }))).toEqual({ kind: 'entered', turn: 5 })
    expect(trajectoryRoutingStreak(decision({
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 3, enteredTurn: 1 },
    }))).toBeUndefined()
    expect(trajectoryRoutingStreak(decision({
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 0 },
    }))).toBeUndefined()
    expect(trajectoryRoutingStreak(decision({
      outcome: 'kept-strong',
      reason: 'gate-failed',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed' },
    }, ['selection']))).toEqual({ kind: 'exited', reason: 'gate-failed' })
    expect(trajectoryRoutingStreak(decision({
      outcome: 'kept-strong',
      reason: 'thin-margin',
      sticky: { active: false, stepsElapsed: 0 },
    }, ['selection']))).toBeUndefined()
  })
})

describe('trajectoryRoutingRow', () => {
  it('shows an in-turn fallback as a visible streak exit, not a quiet marker', () => {
    const fallback = decision({
      outcome: 'kept-strong',
      reason: 'route-failed',
      failure: { code: 'AUTH', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      failedChunkSeq: 9,
      sticky: {
        active: false,
        stepsElapsed: 0,
        brokenBy: 'route-failed',
        entryBase: { provider: 'deepseek-official', model: 'deepseek-v4.1' },
      },
    }, ['selection', 'route'])

    expect(trajectoryRoutingRow(fallback)).toEqual({
      outcome: 'kept-strong',
      reason: 'route-failed',
      streak: { kind: 'exited', reason: 'route-failed' },
      quiet: false,
    })
  })

  it('shows a hold-cap exit as a visible streak exit and a re-entry cooldown as the quiet marker', () => {
    const capped = decision({
      outcome: 'kept-strong',
      reason: 'hold-cap',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'hold-cap' },
    }, ['selection', 'route'])
    expect(trajectoryRoutingRow(capped)).toEqual({
      outcome: 'kept-strong',
      reason: 'hold-cap',
      streak: { kind: 'exited', reason: 'hold-cap' },
      quiet: false,
    })
    const cooling = decision({
      outcome: 'kept-strong',
      reason: 'reentry-cooldown',
      sticky: { active: false, stepsElapsed: 0 },
    }, ['selection', 'route'])
    expect(trajectoryRoutingRow(cooling)).toEqual({ outcome: 'kept-strong', reason: 'reentry-cooldown', quiet: true })
    expect(ROUTING_REASON_KEYS['hold-cap']).toBe('routing.reason.holdCap')
    expect(ROUTING_BREAK_KEYS['hold-cap']).toBe('routing.reason.holdCap')
    expect(en[ROUTING_REASON_KEYS['reentry-cooldown']]).toBe('cooling down after a streak exit')
  })

  it('shows a judgment failure a streak survived as a held downgrade and an open breaker as the quiet marker', () => {
    const held = decision({
      reason: 'judgment-failure-held',
      engineFailure: { code: 'DEADLINE' },
      sticky: { active: true, routeErrorLimit: 2, stepsElapsed: 3, enteredTurn: 1, enteredStep: 1 },
    }, ['route'])
    expect(trajectoryRoutingRow(held, decision())).toEqual({
      outcome: 'downgraded',
      reason: 'judgment-failure-held',
      selection: {
        candidateId: 'flash',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
      },
      quiet: false,
    })
    const open = decision({ outcome: 'kept-strong', reason: 'breaker-open', sticky: { active: false, stepsElapsed: 0 } }, ['selection', 'route'])
    expect(trajectoryRoutingRow(open)).toEqual({ outcome: 'kept-strong', reason: 'breaker-open', quiet: true })
    expect(en[ROUTING_REASON_KEYS['judgment-failure-held']]).toBe('judgment failed, streak held')
    expect(en[ROUTING_REASON_KEYS['breaker-open']]).toBe('judgment paused after repeated failures')
  })

  it('shows base-unlisted as the quiet marker, and as a visible exit when it ends a streak', () => {
    const unlisted = decision({ outcome: 'kept-strong', reason: 'base-unlisted', sticky: { active: false, stepsElapsed: 0 } }, ['selection', 'route'])
    expect(trajectoryRoutingRow(unlisted)).toEqual({ outcome: 'kept-strong', reason: 'base-unlisted', quiet: true })
    const ended = decision({
      outcome: 'kept-strong',
      reason: 'base-unlisted',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'base-unlisted' },
    }, ['selection', 'route'])
    expect(trajectoryRoutingRow(ended)).toEqual({
      outcome: 'kept-strong',
      reason: 'base-unlisted',
      streak: { kind: 'exited', reason: 'base-unlisted' },
      quiet: false,
    })
    expect(en[ROUTING_REASON_KEYS['base-unlisted']]).toBe('routing does not start from this model')
    expect(ROUTING_BREAK_KEYS['base-unlisted']).toBe('routing.reason.baseUnlisted')
  })

  it('carries the route, confidence, and entering streak of a downgrade', () => {
    expect(trajectoryRoutingRow(decision())).toEqual({
      outcome: 'downgraded',
      reason: 'gate-passed',
      confidence: 0.9,
      selection: {
        candidateId: 'flash',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
      },
      streak: { kind: 'entered', turn: 1 },
      quiet: false,
    })
  })

  it('holds a streak without a transition and drops an unnamed effort', () => {
    const row = trajectoryRoutingRow(decision({
      reason: 'sticky-hold',
      selection: { candidateId: 'flash', provider: 'p', model: 'cheap' },
      sticky: {
        active: true,
        routeErrorLimit: 2,
        stepsElapsed: 2,
        enteredTurn: 1,
        entryBase: { provider: 'p', model: 'strong' },
      },
    }))
    expect(row.streak).toBeUndefined()
    expect(row.quiet).toBe(false)
    expect(row.selection).toEqual({ candidateId: 'flash', provider: 'p', model: 'cheap' })
  })

  it('collapses a kept-strong decision that changed nothing to the quiet marker', () => {
    const row = trajectoryRoutingRow(decision({
      outcome: 'kept-strong',
      reason: 'thin-margin',
      sticky: { active: false, stepsElapsed: 0 },
    }, ['selection']))
    expect(row).toEqual({
      outcome: 'kept-strong',
      reason: 'thin-margin',
      quiet: true,
    })
  })

  it('keeps a kept-strong decision that ended a streak out of the quiet marker', () => {
    const row = trajectoryRoutingRow(decision({
      outcome: 'kept-strong',
      reason: 'gate-failed',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed' },
    }, ['selection']))
    expect(row).toEqual({
      outcome: 'kept-strong',
      reason: 'gate-failed',
      confidence: 0.9,
      streak: { kind: 'exited', reason: 'gate-failed' },
      quiet: false,
    })
  })

  it('renders a failed judgment without a route or selection', () => {
    const row = trajectoryRoutingRow(decision({
      outcome: 'error',
      reason: 'judgment-error',
      sticky: { active: false, stepsElapsed: 0 },
    }, ['selection', 'route']))
    expect(row).toEqual({ outcome: 'error', reason: 'judgment-error', quiet: false })
  })
})

describe('trajectoryRequestRoute', () => {
  it('reports nothing without an effective route or a judged turn', () => {
    expect(trajectoryRequestRoute(1, 1, 7, undefined, 'cheap', [decision()])).toBeUndefined()
    expect(trajectoryRequestRoute(1, 1, 7, 'p', undefined, [decision()])).toBeUndefined()
    expect(trajectoryRequestRoute(2, 1, 7, 'p', 'cheap', [decision()])).toBeUndefined()
  })

  it('badges the request whose effective route left the sticky selection', () => {
    expect(trajectoryRequestRoute(1, 1, 7, 'p', 'cheap', [decision()])).toEqual({
      provider: 'p',
      model: 'cheap',
      routed: true,
    })
    expect(trajectoryRequestRoute(1, 1, 7, 'deepseek-official', 'deepseek-v4.1', [decision()])).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4.1',
      routed: false,
    })
  })

  it('reports the effective route without a badge when no streak holds one', () => {
    const strong = decision({
      outcome: 'kept-strong',
      reason: 'thin-margin',
      sticky: { active: false, stepsElapsed: 0 },
    }, ['selection'])
    expect(trajectoryRequestRoute(1, 1, 7, 'p', 'cheap', [strong])).toEqual({
      provider: 'p',
      model: 'cheap',
      routed: false,
    })
  })

  it('reuses a prior-step decision until the request step has its own decision', () => {
    const entered = decision({ seq: 6 })
    const broken = decision({
      seq: 25,
      step: 2,
      outcome: 'kept-strong',
      reason: 'gate-failed',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed' },
    }, ['selection'])
    expect(trajectoryRequestRoute(1, 2, 23, 'p', 'cheap', [entered])).toEqual({
      provider: 'p',
      model: 'cheap',
      routed: true,
    })
    expect(trajectoryRequestRoute(1, 2, 23, 'p', 'cheap', [entered, broken])).toEqual({
      provider: 'p',
      model: 'cheap',
      routed: false,
    })
  })

  it('accepts a partial-window decision without a step only before the request anchor', () => {
    const loadedPrefix = decision({ seq: 20 }, ['step'])
    const loadedFuture = decision({ seq: 25 }, ['step'])
    expect(trajectoryRequestRoute(1, 2, 23, 'p', 'cheap', [loadedPrefix])).toEqual({
      provider: 'p',
      model: 'cheap',
      routed: true,
    })
    expect(trajectoryRequestRoute(1, 2, 23, 'p', 'cheap', [loadedFuture])).toBeUndefined()
  })

  it('does not let a later-step decision badge an earlier request', () => {
    const entered = decision({ seq: 6 })
    const later = decision({
      seq: 25,
      step: 2,
      outcome: 'kept-strong',
      reason: 'gate-failed',
      sticky: { active: false, stepsElapsed: 0, brokenBy: 'gate-failed' },
    }, ['selection'])
    expect(trajectoryRequestRoute(1, 1, 3, 'p', 'cheap', [entered, later])).toEqual({
      provider: 'p',
      model: 'cheap',
      routed: true,
    })
  })
})

describe('deriveTrajectoryLayout routing rows', () => {
  function cells(routing: readonly TrajectoryRoutingDecision[]) {
    return deriveTrajectoryLayout({
      nodes: nodes(),
      partial: null,
      runningCalls: [],
      requests: [assistantRequest()],
      routing,
    }).flatMap(turn => turn.groups.flatMap(group =>
      group.cells.map(cell => ({ group: group.title, cell }))))
  }

  it('renders the decision at its seq inside its step', () => {
    const laid = cells([decision()])
    const routing = laid.find(entry => entry.cell.kind === 'routing')
    expect(routing?.group).toBe('Step 1')
    expect(routing?.cell.index).toBeLessThan(
      laid.find(entry => entry.cell.kind === 'message')?.cell.index ?? 0,
    )
    expect(routing?.cell).toMatchObject({
      kind: 'routing',
      text: 'downgraded · gate-passed',
      sourceSeq: 6,
      timeSeconds: 0,
      startedAt: 1_700_000_000_006,
      routing: { outcome: 'downgraded', reason: 'gate-passed', quiet: false },
    })
  })

  it('folds a decision outside a step into the turn message group', () => {
    const laid = cells([decision({}, ['step'])])
    expect(laid.find(entry => entry.cell.kind === 'routing')?.group).toBe('Message')
  })

  it('reports one entry across repeated judgments on the same entering turn', () => {
    const entered = decision()
    const continued = decision({ seq: 16, step: 2 })
    const changed = decision({
      seq: 26, step: 3,
      selection: { candidateId: 'other', provider: 'p', model: 'other-cheap' },
    })
    const routing = cells([entered, continued, changed])
      .filter(entry => entry.cell.kind === 'routing')
      .map(entry => entry.cell.routing?.streak)
    expect(routing).toEqual([{ kind: 'entered', turn: 1 }, undefined, { kind: 'entered', turn: 1 }])
  })

  it('renders a decision whose logged time is unusable as a time-less marker', () => {
    const turns = deriveTrajectoryLayout({
      nodes: nodes(),
      partial: null,
      runningCalls: [],
      requests: [assistantRequest()],
      routing: [decision({ time: Number.NaN })],
    })
    const routing = turns
      .flatMap(turn => turn.groups.flatMap(group => group.cells))
      .find(cell => cell.kind === 'routing')
    expect(routing?.startedAt).toBeNull()
    expect(routing?.timeSeconds).toBe(0)
  })

  it('resolves an unlocated decision to the turn that consumed it', () => {
    const turns = deriveTrajectoryLayout({
      nodes: nodes(),
      partial: null,
      runningCalls: [],
      requests: [assistantRequest()],
      routing: [decision({}, ['turn', 'step'])],
    })
    expect(turns.map(turn => turn.turn)).toEqual([1])
    expect(turns[0]?.groups.flatMap(group => group.cells)
      .some(cell => cell.kind === 'routing')).toBe(true)
  })
})
