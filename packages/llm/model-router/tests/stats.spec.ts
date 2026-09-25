/**
 * The `modelRoutingStats` fold over hand-built logs whose every expected value
 * is derived from the stat definitions in the fold's module documentation: a
 * live-shaped log (routing on, the strong route kept on every decision), an
 * active log (streaks, a route failure, a manual switch, idle expiry, a
 * compaction, and unreported usage), the retention caps, and the projection
 * unit rules (same reference for ignored events, plain-JSON state).
 */

import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@shres-code/shres-code-llm'
import type { SessionEvent } from '@shres-code/shres-code-session'
import {
  COLD_TTL_FALLBACK_MS,
  LATENCY_BUCKETS_MS,
  RETAINED_CONSULTS,
  RETAINED_RECENT_DECISIONS,
  RETAINED_TIMELINE_EVENTS,
  RETAINED_TURN_SPANS,
  TIMELINE_STEP_LIMIT,
  applyStatsEvent,
  createStatsState,
  foldModelRoutingStats,
  modelRoutingStatsSchema,
  positionBefore,
  viewStats,
} from '../src/stats.ts'
import type { ModelRoutingStatsState } from '../src/stats.ts'
import type {
  ModelRoutingBreakReason,
  ModelRoutingCandidateEligibility,
  ModelRoutingDecision,
  ModelRoutingRouteAnswer,
  ModelRoutingSelection,
  ModelRoutingStatsSnapshot,
  ModelRoutingStickyView,
} from '../src/types.ts'

interface Route {
  provider: string
  model: string
}

const STRONG: Route = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const FLASH: Route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const VISION: Route = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
const OTHER: Route = { provider: 'other-provider', model: 'other-model' }

/** Builds a log the way a session commits one: contiguous seqs and explicit times. */
class Log {
  readonly events: SessionEvent[] = []

  step(time: number, turn: number, step: number): SessionEvent {
    return this.add('step/start', { turn, step }, time)
  }

  decide(time: number, fields: Partial<ModelRoutingDecision> = {}): SessionEvent {
    return this.add('model-routing/decision', {
      outcome: 'kept-strong',
      reason: 'current-preferred',
      stateHash: '00000000',
      stateSeqs: [],
      sticky: ended(),
      ...fields,
    }, time)
  }

  call(time: number, turn: number, step: number, route: Route, usage?: TokenUsage): SessionEvent {
    return this.add('assistant/message', {
      turn,
      step,
      message: { id: 'message-' + String(this.events.length), role: 'assistant', content: [], source: { kind: 'model', ...route } },
      ...usage === undefined ? {} : { usage },
    }, time)
  }

  select(time: number, route: Route): SessionEvent {
    return this.add('agent/model-selection', route, time)
  }

  compacted(time: number, error?: string): SessionEvent {
    return this.add('compaction/end', { compactionId: 'compaction', turn: null, ...error === undefined ? {} : { error } }, time)
  }

  add(type: string, data: unknown, time: number): SessionEvent {
    const event = { type, seq: this.events.length, time, data } as unknown as SessionEvent
    this.events.push(event)
    return event
  }
}

/** A held streak's sticky facts; `null` records no entry base. */
function held(entryBase: Route | null = STRONG, stepsElapsed = 0): ModelRoutingStickyView {
  return { active: true, stepsElapsed, routeErrorLimit: 2, ...entryBase === null ? {} : { entryBase } }
}

/** Inactive sticky facts, with what ended a streak when this decision ended one. */
function ended(brokenBy?: ModelRoutingBreakReason): ModelRoutingStickyView {
  return { active: false, stepsElapsed: 0, ...brokenBy === undefined ? {} : { brokenBy } }
}

function answer(choice: string, confidence: number, probabilities: Record<string, number>): ModelRoutingRouteAnswer {
  return { choice, confidence, probabilities }
}

function selection(candidateId: string, route: Route): ModelRoutingSelection {
  return { candidateId, ...route }
}

/** The configured candidate list a decision records, in configuration order. */
function pool(...routes: Route[]): Pick<ModelRoutingDecision, 'candidateEligibility'> {
  return {
    candidateEligibility: {
      requirements: {},
      candidates: routes.map((route, at) => ({ id: 'candidate-' + String(at), ...route, description: 'candidate' })),
      eligibleCandidates: [],
      assessments: [],
    } as unknown as ModelRoutingCandidateEligibility,
  }
}

/** The judgment input a decision records, reduced to its selected state text. */
function judged(state: string): Pick<ModelRoutingDecision, 'judgmentInput'> {
  return { judgmentInput: { state } as unknown as NonNullable<ModelRoutingDecision['judgmentInput']> }
}

function projected(maxChars: number): Pick<ModelRoutingDecision, 'stateProjection'> {
  return { stateProjection: { renderer: 'conversation-v1', contextTurns: 2, maxChars, omittedSeqs: [] } }
}

function reported(input: number, read: number, write: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}

function unreported(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output }
}

/** Fold a log and check the value passes the projection's wire schema unchanged. */
function fold(log: Log): ModelRoutingStatsSnapshot {
  const snapshot = foldModelRoutingStats(log.events)
  expect(modelRoutingStatsSchema.parse(snapshot)).toEqual(snapshot)
  return snapshot
}

function coldOf(snapshot: ModelRoutingStatsSnapshot): Record<string, [number, number]> {
  return Object.fromEntries(snapshot.cold.map(entry => [entry.cause, [entry.count, entry.tokens]]))
}

/** The live demo's shape: 22 turns, every consult kept the strong route. */
function liveShapedLog(): { log: Log; decisions: SessionEvent[] } {
  const log = new Log()
  const decisions: SessionEvent[] = []
  for (let turn = 1; turn <= 22; turn += 1) {
    const time = turn * 1_000
    log.step(time, turn, 1)
    decisions.push(log.decide(time + 10, {
      reason: turn % 6 === 0 ? 'low-confidence' : 'current-preferred',
      route: answer('keep-current', 0.61, { 'keep-current': 0.61, flash: turn === 7 ? 0.39 : 0.25, vision: 0.14 }),
      engine: 'jev-typesafe',
      latencyMs: 800,
      objective: 'dollars',
      ...pool(FLASH, VISION),
      ...projected(12_000),
    }))
    log.call(time + 100, turn, 1, STRONG, turn === 1 ? reported(20_000, 0, 20_000, 10) : reported(300, 20_000, 200, 10))
  }
  return { log, decisions }
}

/** The active log: three streaks, a route failure, a manual switch, idle expiry, compaction, and unreported usage. */
function activeLog(): { log: Log; decisions: SessionEvent[]; calls: SessionEvent[]; selection: SessionEvent } {
  const log = new Log()
  const decisions: SessionEvent[] = []
  const calls: SessionEvent[] = []
  log.step(1_000, 1, 1)
  calls.push(log.call(1_100, 1, 1, STRONG, reported(6_000, 0, 0, 100)))
  log.step(2_000, 2, 1)
  decisions.push(log.decide(2_010, {
    outcome: 'downgraded',
    reason: 'gate-passed',
    selection: selection('flash', FLASH),
    route: answer('flash', 0.9, { flash: 0.9, 'keep-current': 0.1 }),
    engine: 'typesafe',
    latencyMs: 150,
    sticky: held(),
    objective: 'dollars',
    ...pool(FLASH, VISION),
    ...judged('x'.repeat(40)),
  }))
  calls.push(log.call(2_100, 2, 1, FLASH, reported(5_000, 0, 5_000, 50)))
  log.step(2_200, 2, 2)
  decisions.push(log.decide(2_210, {
    outcome: 'downgraded',
    reason: 'sticky-hold',
    selection: selection('flash', FLASH),
    route: answer('keep-current', 0.6, { 'keep-current': 0.6, flash: 0.3, vision: 0.1 }),
    difficulty: { score: 0.4, confidence: 0.8 },
    engine: 'typesafe',
    latencyMs: 3_000,
    sticky: held(STRONG, 1),
    ...projected(12_000),
  }))
  calls.push(log.call(2_300, 2, 2, FLASH, reported(200, 9_800, 0, 20)))
  log.step(3_000, 3, 1)
  decisions.push(log.decide(3_010, {
    reason: 'current-preferred',
    route: answer('keep-current', 0.8, { 'keep-current': 0.8, flash: 0.2 }),
    difficulty: { score: 1.5, confidence: 0.7 },
    engine: 'laya',
    latencyMs: 40,
    sticky: ended('current-preferred'),
    objective: 'quota',
    ...judged('yy'),
  }))
  calls.push(log.call(3_100, 3, 1, STRONG, reported(4_500, 100, 3_000, 10)))
  log.step(3_200, 3, 2)
  decisions.push(log.decide(3_210, {
    reason: 'engine-unavailable',
    engineFailure: { code: 'DEADLINE' },
    engine: 'laya',
    ...projected(500),
  }))
  calls.push(log.call(3_300, 3, 2, STRONG, reported(100, 7_000, 0, 5)))
  log.step(4_000, 4, 1)
  decisions.push(log.decide(4_010, {
    outcome: 'downgraded',
    reason: 'gate-passed',
    selection: selection('vision', VISION),
    route: answer('vision', 0.85, { vision: 0.85, 'keep-current': 0.15 }),
    engine: 'typesafe',
    latencyMs: 45_000,
    sticky: held(),
  }))
  decisions.push(log.decide(4_020, {
    reason: 'route-failed',
    failure: { code: 'RATE_LIMIT', ...VISION },
    sticky: ended('route-failed'),
  }))
  calls.push(log.call(4_100, 4, 1, STRONG, reported(5_000, 0, 0, 10)))
  const manual = log.select(4_500, OTHER)
  log.step(5_000, 5, 1)
  calls.push(log.call(5_100, 5, 1, OTHER, reported(8_000, 0, 8_000, 10)))
  log.step(5_000 + COLD_TTL_FALLBACK_MS + 1, 6, 1)
  calls.push(log.call(305_100, 6, 1, OTHER, reported(6_000, 0, 0, 10)))
  log.compacted(305_200)
  log.compacted(305_210, 'summary refused')
  log.step(305_300, 7, 1)
  calls.push(log.call(305_400, 7, 1, OTHER, reported(5_000, 0, 0, 10)))
  log.step(305_500, 8, 1)
  calls.push(log.call(305_600, 8, 1, OTHER, reported(5_000, 0, 0, 10)))
  log.step(305_700, 9, 1)
  calls.push(log.call(305_800, 9, 1, OTHER, unreported(3_000, 30)))
  log.step(305_900, 10, 1)
  decisions.push(log.decide(305_910, {
    outcome: 'downgraded',
    reason: 'gate-passed',
    selection: selection('flash', FLASH),
    route: answer('flash', 0.95, { flash: 0.95, vision: 0.03, 'keep-current': 0.02 }),
    engine: 'typesafe',
    latencyMs: 1,
    sticky: held(OTHER),
    objective: 'quota',
  }))
  // One step served twice: the candidate, then the manual route.
  calls.push(log.call(306_000, 10, 1, FLASH, reported(3_000, 2_000, 0, 10)))
  calls.push(log.call(306_100, 10, 1, OTHER, unreported(1_000, 5)))
  // A decision logged after the step's calls points at that step.
  decisions.push(log.decide(306_200, {
    outcome: 'downgraded',
    reason: 'judgment-failure-held',
    selection: selection('flash', FLASH),
    engineFailure: { code: 'UNAVAILABLE' },
    engine: 'typesafe',
    sticky: held(OTHER),
  }))
  return { log, decisions, calls, selection: manual }
}

describe('modelRoutingStats fold', () => {
  it('reports a live-shaped log whose every consult kept the strong route', () => {
    const { log, decisions } = liveShapedLog()
    const stats = fold(log)

    expect(stats.counts).toEqual({
      decisions: 22,
      consults: 22,
      downgradedSteps: 0,
      steps: 22,
      streaks: 0,
      keptStrong: 22,
      routeFailed: 0,
      judgeFailed: 0,
      deadlineHits: 0,
      warmUps: 0,
      turnsWithDecisions: 22,
    })
    expect(stats.reasons).toEqual([
      { reason: 'current-preferred', group: 'judge-no', count: 19 },
      { reason: 'low-confidence', group: 'judge-no', count: 3 },
    ])
    expect(stats.keptReasons).toEqual([
      { reason: 'current-preferred', count: 19 },
      { reason: 'low-confidence', count: 3 },
    ])
    expect(stats.exits).toEqual([])
    expect(stats.streakLengths).toEqual({ median: null, max: null })
    // The best challenger is the strongest non-keep option of each keep-current answer.
    expect(stats.confidence.max).toBe(0.39)
    expect(stats.confidence.total).toBe(22)
    expect(stats.confidence.values).toEqual(Array.from({ length: 22 }, (_, at) => at === 6 ? 0.39 : 0.25))
    expect(stats.latency.counts).toEqual(LATENCY_BUCKETS_MS.map(bound => bound === 1_000 ? 22 : 0))
    expect(stats.latency).toMatchObject({ failed: 0, p50: 1_000, p95: 1_000, includesFailed: false })
    expect(stats.models).toEqual([{
      ...STRONG,
      role: 'strong',
      colorSlot: 'strong',
      steps: 22,
      calls: 22,
      uncached: 20_000 + 21 * 300,
      unreported: 0,
      cacheRead: 21 * 20_000,
      cacheWrite: 20_000 + 21 * 200,
      output: 220,
      reportedCalls: 22,
    }])
    expect(coldOf(stats)['session-start']).toEqual([1, 40_000])
    expect(stats.coldTtl).toEqual({ ms: COLD_TTL_FALLBACK_MS, fallback: true })
    expect(stats.unreportedCallShare).toBe(0)
    expect(stats.moved).toEqual({ tokensOffStrong: 0, returnReprefill: 0, objective: 'dollars' })
    expect(stats.egress).toEqual([{ engine: 'jev-typesafe', asks: 22, chars: 22 * 12_000, bound: 'at-most' }])
    expect(stats.engines).toEqual([{ name: 'jev-typesafe', decisions: 22 }])
    expect(stats.timeline.aggregated).toBe(false)
    expect(stats.timeline.marks).toEqual([])
    expect(stats.timeline.decisions.map(decision => decision.i)).toEqual(Array.from({ length: 22 }, (_, at) => at))
    expect(stats.recent.map(row => row.seq)).toEqual(decisions.map(decision => decision.seq).reverse())
  })

  it('reports streaks, exits, failures, cold prefills, and moved tokens of an active log', () => {
    const { log, decisions, calls, selection: manual } = activeLog()
    const stats = fold(log)

    expect(stats.counts).toEqual({
      decisions: 8,
      consults: 5,
      downgradedSteps: 3,
      steps: 12,
      streaks: 3,
      keptStrong: 3,
      routeFailed: 1,
      judgeFailed: 2,
      deadlineHits: 1,
      warmUps: 0,
      turnsWithDecisions: 4,
    })
    expect(stats.reasons).toEqual([
      { reason: 'gate-passed', group: 'switched', count: 3 },
      { reason: 'current-preferred', group: 'judge-no', count: 1 },
      { reason: 'engine-unavailable', group: 'engine', count: 1 },
      { reason: 'judgment-failure-held', group: 'switched', count: 1 },
      { reason: 'route-failed', group: 'engine', count: 1 },
      { reason: 'sticky-hold', group: 'switched', count: 1 },
    ])
    expect(stats.keptReasons).toEqual([
      { reason: 'current-preferred', count: 1 },
      { reason: 'engine-unavailable', count: 1 },
      { reason: 'route-failed', count: 1 },
    ])
    expect(stats.exits).toEqual([
      { brokenBy: 'current-preferred', count: 1 },
      { brokenBy: 'route-failed', count: 1 },
    ])
    // Two steps, a failed entry with none, and the open streak's one step.
    expect(stats.streakLengths).toEqual({ median: 1, max: 2 })
    expect(stats.confidence.values).toEqual([0.9, 0.3, 0.2, 0.85, 0.95])
    for (const [at, margin] of [0.8, 0.3, 0.6, 0.7, 0.92].entries()) {
      expect(stats.confidence.margins[at]).toBeCloseTo(margin)
    }
    expect(stats.confidence).toMatchObject({ max: 0.95, total: 5 })
    // 1 ms, 40 ms, 150 ms, 3 s, and 45 s, which counts in the 30 s bucket.
    expect(stats.latency.counts).toEqual(LATENCY_BUCKETS_MS.map(bound => [1, 50, 200, 5_000, 30_000].includes(bound) ? 1 : 0))
    expect(stats.latency).toMatchObject({ failed: 2, p50: 200, p95: 30_000 })
    // The manual route in force is OTHER; STRONG was an earlier manual choice.
    expect(stats.models).toEqual([
      { ...OTHER, role: 'strong', colorSlot: 'strong', steps: 6, calls: 6, uncached: 24_000, unreported: 4_000, cacheRead: 0, cacheWrite: 8_000, output: 75, reportedCalls: 4 },
      { ...FLASH, role: 'candidate', colorSlot: 1, steps: 2, calls: 3, uncached: 8_200, unreported: 0, cacheRead: 11_800, cacheWrite: 5_000, output: 80, reportedCalls: 3 },
      { ...STRONG, role: 'other', colorSlot: 'other', steps: 4, calls: 4, uncached: 15_600, unreported: 0, cacheRead: 7_100, cacheWrite: 3_000, output: 125, reportedCalls: 4 },
    ])
    expect(coldOf(stats)).toEqual({
      'routed-switch': [1, 10_000],
      // The route-failed retry on the manual route is a return, not a switch.
      'routed-return': [2, 12_500],
      'manual-switch': [1, 16_000],
      'idle-expiry': [1, 6_000],
      'session-start': [1, 6_000],
      'post-compaction': [1, 5_000],
      'other': [1, 5_000],
    })
    expect(stats.unreportedCallShare).toBeCloseTo(2 / 13)
    expect(stats.moved).toEqual({ tokensOffStrong: 10_050 + 10_020 + 5_010, returnReprefill: 7_500 + 5_000, objective: 'mixed' })
    expect(stats.egress).toEqual([
      { engine: 'typesafe', asks: 5, chars: 40 + 12_000, bound: 'at-most' },
      { engine: 'laya', asks: 2, chars: 2 + 500, bound: 'at-most' },
    ])
    expect(stats.engines).toEqual([{ name: 'typesafe', decisions: 4 }, { name: 'laya', decisions: 1 }])

    // Step 10/1's last call is calls[12]: calls[11] and calls[12] share that step.
    const lastCallOfStep = [...calls.slice(0, 11), calls[12]]
    expect(stats.timeline.steps).toEqual([
      [1, 1, 2], [2, 1, 1], [2, 2, 1], [3, 1, 2], [3, 2, 2], [4, 1, 2],
      [5, 1, 0], [6, 1, 0], [7, 1, 0], [8, 1, 0], [9, 1, 0], [10, 1, 0],
    ].map(([turn, step, model], at) => ({ turn, step, lastTurn: turn, model, seq: lastCallOfStep[at]!.seq, t: lastCallOfStep[at]!.time })))
    expect(stats.timeline.marks).toEqual([
      { i: 1, kind: 'down' },
      { i: 3, kind: 'return' },
      { i: 5, kind: 'down' },
      { i: 5, kind: 'failed' },
      { i: 6, kind: 'manual' },
      { i: 7, kind: 'idle' },
      { i: 11, kind: 'down' },
      { i: 11, kind: 'idle' },
    ])
    expect(stats.timeline.decisions.map(decision => [decision.i, decision.engine])).toEqual([
      [1, 0], [2, 0], [3, 1], [4, null], [5, 0], [5, null], [11, 0], [11, null],
    ])
    expect(manual.seq).toBeLessThan(calls[6]!.seq)
    expect(stats.recent.map(row => [row.seq, row.turn, row.step])).toEqual([
      [decisions[7]!.seq, 10, 1],
      [decisions[6]!.seq, 10, 1],
      [decisions[5]!.seq, 4, 1],
      [decisions[4]!.seq, 4, 1],
      [decisions[3]!.seq, 3, 2],
      [decisions[2]!.seq, 3, 1],
      [decisions[1]!.seq, 2, 2],
      [decisions[0]!.seq, 2, 1],
    ])
    expect(stats.recent[4]).toEqual({
      seq: decisions[3]!.seq,
      t: 3_210,
      turn: 3,
      step: 2,
      outcome: 'kept-strong',
      reason: 'engine-unavailable',
      best: null,
      difficulty: null,
      engine: 'laya',
      latencyMs: null,
    })
    expect(stats.recent[5]).toMatchObject({ best: 0.2, difficulty: 1.5, engine: 'laya', latencyMs: 40 })
  })

  it('handles decisions and calls without a step, answers without an engine, and exits without an entry', () => {
    const log = new Log()
    // Before any step/start: position 0/0, a consult no engine answered, no entry base.
    log.decide(10, {
      outcome: 'downgraded',
      reason: 'gate-passed',
      selection: selection('flash', FLASH),
      route: answer('flash', 0.8, { flash: 0.8, 'keep-current': 0.2 }),
      sticky: held(null),
    })
    log.call(20, 0, 0, FLASH, reported(1_000, 0, 0, 5))
    // A second call on the same model in the same step changes no attribution.
    log.call(30, 0, 0, FLASH, reported(1_000, 0, 0, 5))
    log.select(40, FLASH)
    log.select(50, STRONG)
    log.select(55, STRONG)
    log.decide(60, { reason: 'mode-off', sticky: ended('mode-off') })
    // A held record whose outcome is not a downgrade enters no streak, so its exit records no length.
    log.decide(70, { outcome: 'skipped', reason: 'sticky-hold', sticky: held(null) })
    log.decide(80, { reason: 'gate-failed', sticky: ended('gate-failed') })
    log.step(100, 1, 1)
    log.call(110, 1, 1, STRONG, unreported(5_000, 5))
    log.decide(120, {
      route: answer('keep-current', 1, { 'keep-current': 1 }),
      engine: 'solo',
      ...judged('abcd'),
    })
    log.step(200, 2, 1)
    log.decide(210, { reason: 'no-candidates' })
    const stats = fold(log)

    expect(stats.recent.at(-1)).toMatchObject({ turn: 0, step: 0, engine: null, latencyMs: null, best: 0.8 })
    expect(stats.engines).toEqual([{ name: 'solo', decisions: 1 }])
    expect(stats.egress).toEqual([{ engine: 'solo', asks: 1, chars: 4, bound: 'exact' }])
    // A keep-current answer that lists no candidate option reaches 0.
    expect(stats.confidence.values).toEqual([0.8, 0])
    expect(stats.latency).toMatchObject({ p50: null, p95: null })
    expect(stats.streakLengths).toEqual({ median: 1, max: 1 })
    expect(stats.counts).toMatchObject({ streaks: 1, downgradedSteps: 1, steps: 2 })
    // The unreported first call on the manual route after the exit re-writes its whole prompt.
    expect(stats.moved).toEqual({ tokensOffStrong: 2_010, returnReprefill: 5_000, objective: null })
    expect(stats.models.map(model => [model.model, model.role, model.colorSlot, model.steps, model.calls])).toEqual([
      [STRONG.model, 'strong', 'strong', 1, 1],
      [FLASH.model, 'candidate', 1, 1, 2],
    ])
    // The first selection sets the manual route with no prior one to switch from; the switch from
    // FLASH to STRONG marks the next step; the repeated selection marks nothing. Both exits are
    // logged in step 0/0, which already has a call.
    expect(stats.timeline.marks).toEqual([
      { i: 0, kind: 'down' },
      { i: 1, kind: 'manual' },
      { i: 0, kind: 'return' },
      { i: 0, kind: 'return' },
    ])
    // The last decision's step has no call, so it points at the last point.
    expect(stats.timeline.decisions.at(-1)?.i).toBe(1)
  })

  it('orders models strong first, then by pool order with five colour slots, then by first appearance', () => {
    const candidates = Array.from({ length: 6 }, (_, at) => ({ provider: 'pool', model: 'candidate-' + String(at + 1) }))
    const extraA = { provider: 'extra', model: 'a' }
    const extraB = { provider: 'extra', model: 'b' }
    const log = new Log()
    log.step(0, 1, 1)
    log.decide(1, { ...pool(...candidates) })
    const served = [candidates[5]!, extraA, candidates[0]!, extraB, candidates[1]!, candidates[2]!, candidates[3]!, candidates[4]!, STRONG]
    for (const [at, route] of served.entries()) log.call(10 + at, 1, at + 1, route, reported(10, 0, 0, 1))
    const stats = fold(log)

    expect(stats.models.map(model => [model.model, model.role, model.colorSlot])).toEqual([
      [STRONG.model, 'strong', 'strong'],
      ['candidate-1', 'candidate', 1],
      ['candidate-2', 'candidate', 2],
      ['candidate-3', 'candidate', 3],
      ['candidate-4', 'candidate', 4],
      ['candidate-5', 'candidate', 5],
      ['candidate-6', 'candidate', 'other'],
      ['a', 'other', 'other'],
      ['b', 'other', 'other'],
    ])
  })

  it('reports empty statistics for a log without decisions or calls', () => {
    const stats = fold(new Log())
    expect(stats.counts.decisions).toBe(0)
    expect(stats.models).toEqual([])
    expect(stats.unreportedCallShare).toBeNull()
    expect(stats.confidence).toEqual({ values: [], margins: [], max: null, total: 0 })
    expect(stats.latency).toMatchObject({ p50: null, p95: null, failed: 0 })
    expect(stats.timeline).toEqual({ steps: [], marks: [], decisions: [], aggregated: false })
    expect(stats.recent).toEqual([])
  })

  it('reads the median of an even number of streak lengths as the mean of the middle two', () => {
    expect(viewStats({ ...createStatsState(), streakLengths: { '1': 1, '4': 1 } }).streakLengths).toEqual({ median: 2.5, max: 4 })
  })

  it('breaks count ties by code units, which a locale collation would order the other way', () => {
    // 'Zulu' < 'alpha' in UTF-16 code units; an English collation puts 'alpha' first.
    expect(viewStats({ ...createStatsState(), exits: { alpha: 2, Zulu: 2, beta: 3 } }).exits.map(entry => entry.brokenBy))
      .toEqual(['beta', 'Zulu', 'alpha'])
  })

  it('caps retained values and aggregates a long timeline to at most 400 points of whole turns', () => {
    const log = new Log()
    const decisions: SessionEvent[] = []
    for (let turn = 1; turn <= 501; turn += 1) {
      const time = turn * 10
      log.step(time, turn, 1)
      const entry = turn % 2 === 1
      decisions.push(log.decide(time + 1, {
        ...entry
          ? { outcome: 'downgraded', reason: 'gate-passed', selection: selection('flash', FLASH), sticky: held() }
          : { sticky: ended('current-preferred') },
        route: answer('flash', turn === 1 ? 0.99 : 0.5, { flash: turn === 1 ? 0.99 : 0.5, 'keep-current': 0.1 }),
        latencyMs: 10,
      }))
      log.call(time + 2, turn, 1, entry ? FLASH : STRONG, reported(100, 0, 0, 1))
      // Turn 2 splits its two steps between the two models: a tie.
      if (turn === 2) {
        log.step(time + 3, turn, 2)
        log.call(time + 4, turn, 2, FLASH, reported(100, 0, 0, 1))
      }
    }
    const state = log.events.reduce(applyStatsEvent, createStatsState())
    const stats = fold(log)

    expect(stats.counts).toMatchObject({ consults: 501, steps: 502, streaks: 251 })
    expect(stats.confidence.values).toHaveLength(RETAINED_CONSULTS)
    // The largest value is the first consult's, which the retained values dropped.
    expect(stats.confidence).toMatchObject({ max: 0.99, total: 501 })
    expect(stats.confidence.values[0]).toBe(0.5)
    expect(stats.recent).toHaveLength(RETAINED_RECENT_DECISIONS)
    expect(stats.recent[0]?.seq).toBe(decisions.at(-1)?.seq)
    expect(state.steps).toEqual([])
    expect(stats.counts.steps).toBeGreaterThan(TIMELINE_STEP_LIMIT)
    expect(stats.timeline.aggregated).toBe(true)
    expect(stats.timeline.steps).toHaveLength(TIMELINE_STEP_LIMIT)
    // 501 turns over 400 points: each point covers one or two whole turns, in order.
    expect(stats.timeline.steps[0]).toMatchObject({ turn: 1, lastTurn: 1 })
    expect(stats.timeline.steps.at(-1)).toMatchObject({ lastTurn: 501, seq: log.events.at(-1)!.seq })
    for (const [at, point] of stats.timeline.steps.entries()) {
      if (at > 0) expect(point.turn).toBe(stats.timeline.steps[at - 1]!.lastTurn + 1)
      expect(point.lastTurn - point.turn).toBeLessThanOrEqual(1)
    }
    expect(stats.timeline.decisions).toHaveLength(RETAINED_TIMELINE_EVENTS)
    expect(stats.timeline.decisions[0]?.seq).toBe(decisions[501 - RETAINED_TIMELINE_EVENTS]?.seq)
    expect(stats.timeline.decisions.at(-1)?.i).toBe(TIMELINE_STEP_LIMIT - 1)
    expect(stats.timeline.marks).toHaveLength(RETAINED_TIMELINE_EVENTS)
    // FLASH served first in the session, so it wins turn 2's tie.
    const flashIndex = stats.models.findIndex(model => model.model === FLASH.model)
    expect(stats.timeline.steps[1]).toMatchObject({ turn: 2, step: 1, lastTurn: 2, model: flashIndex })
    expect(stats.streakLengths).toEqual({ median: 1, max: 1 })
  })

  it('shows 401 one-step turns as 400 points, one of them two turns wide', () => {
    const log = new Log()
    for (let turn = 1; turn <= 401; turn += 1) {
      log.step(turn * 10, turn, 1)
      log.call(turn * 10 + 1, turn, 1, turn === 401 ? FLASH : STRONG, reported(100, 0, 0, 1))
    }
    const stats = fold(log)
    expect(stats.timeline.aggregated).toBe(true)
    expect(stats.timeline.steps).toHaveLength(TIMELINE_STEP_LIMIT)
    expect(stats.timeline.steps.filter(point => point.lastTurn > point.turn)).toHaveLength(1)
    expect(stats.timeline.steps.at(-1)).toMatchObject({ lastTurn: 401 })
  })

  it('keeps the unit state to bounded spans of whole turns however long the log is', () => {
    const log = new Log()
    const turns = 2 * RETAINED_TURN_SPANS + 5
    for (let turn = 1; turn <= turns; turn += 1) {
      log.step(turn * 10, turn, 1)
      // The last 3 turns of every 4 run on the candidate.
      log.call(turn * 10 + 1, turn, 1, turn % 4 === 1 ? STRONG : FLASH, reported(100, 0, 0, 1))
    }
    const state = log.events.reduce(applyStatsEvent, createStatsState())
    expect(state.turns.length).toBeLessThanOrEqual(RETAINED_TURN_SPANS)
    expect(state.turnWidth).toBe(4)
    expect(state.turns.reduce((sum, span) => sum + span.turns, 0)).toBe(turns)
    for (const [at, span] of state.turns.entries()) {
      if (at > 0) expect(span.turn).toBe(state.turns[at - 1]!.lastTurn + 1)
    }
    const stats = viewStats(state)
    expect(stats.timeline.steps).toHaveLength(TIMELINE_STEP_LIMIT)
    expect(stats.timeline.steps[0]).toMatchObject({ turn: 1 })
    expect(stats.timeline.steps.at(-1)).toMatchObject({ lastTurn: turns })
    // The first point is one span of four turns, three of them on the candidate.
    const flashIndex = stats.models.findIndex(model => model.model === FLASH.model)
    expect(stats.timeline.steps[0]).toMatchObject({ lastTurn: 4, model: flashIndex })
  })

  it('returns the same state for events it does not read and keeps its state plain JSON', () => {
    const initial = createStatsState()
    const ignored = new Log()
    for (const event of [
      ignored.add('turn/start', { turn: 1 }, 1),
      ignored.add('request/header', { header: { config: STRONG }, reason: 'initial' }, 2),
      ignored.call(3, 1, 1, STRONG),
      ignored.compacted(4, 'summary refused'),
    ]) {
      expect(applyStatsEvent(initial, event)).toBe(initial)
    }
    expect(applyStatsEvent(initial, ignored.step(5, 1, 1))).not.toBe(initial)

    const { log } = activeLog()
    let state: ModelRoutingStatsState = createStatsState()
    const split = Math.floor(log.events.length / 2)
    for (const event of log.events) {
      const before = JSON.stringify(state)
      state = applyStatsEvent(state, event)
      // A transition never mutates the state it was given.
      expect(JSON.stringify(state) === before || state !== JSON.parse(before)).toBe(true)
    }
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state)

    // A checkpoint restored from JSON continues to the same value.
    const prefix = log.events.slice(0, split).reduce(applyStatsEvent, createStatsState())
    const checkpoint = JSON.parse(JSON.stringify(prefix)) as ModelRoutingStatsState
    expect(viewStats(log.events.slice(split).reduce(applyStatsEvent, checkpoint))).toEqual(foldModelRoutingStats(log.events))
  })

  it('never mutates a prior state', () => {
    const { log } = activeLog()
    let state = createStatsState()
    for (const event of log.events) {
      const frozen = JSON.stringify(state)
      const next = applyStatsEvent(state, event)
      expect(JSON.stringify(state)).toBe(frozen)
      state = next
    }
  })

  it('positions a decision at the latest step/start before it', () => {
    const log = new Log()
    log.decide(1)
    log.step(2, 3, 4)
    log.decide(3)
    log.decide(4)
    expect(positionBefore(log.events, 0)).toEqual({ turn: 0, step: 0 })
    expect(positionBefore(log.events, 2)).toEqual({ turn: 3, step: 4 })
    expect(positionBefore(log.events, 3)).toEqual({ turn: 3, step: 4 })
  })
})

describe('decisions recording judgment-call facts', () => {
  const usage = (inputTokens: number, outputTokens: number, cacheReadTokens?: number): TokenUsage => ({
    inputTokens, outputTokens, ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
  })
  const consult = (fields: Partial<ModelRoutingDecision>): Partial<ModelRoutingDecision> => ({
    route: answer('keep-current', 0.9, { 'keep-current': 0.9, 'flash': 0.1 }),
    ...fields,
  })

  it('names engines by registry id on answers and failures, and counts exact input sizes', () => {
    const log = new Log()
    log.step(0, 1, 1)
    log.decide(1, consult({ engine: 'Jev (TypeSafe)', engineId: 'typesafe', inputChars: 3_000, latencyMs: 40 }))
    log.decide(2, { reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' }, engineId: 'typesafe', inputChars: 2_000, latencyMs: 90 })
    log.decide(3, consult({ engine: 'laya', ...projected(12_000), latencyMs: 20 }))
    log.decide(4, { reason: 'judgment-error', engineFailure: { code: 'INVALID_ANSWER' } })
    const stats = fold(log)

    expect(stats.engines).toEqual([{ name: 'typesafe', decisions: 1 }, { name: 'laya', decisions: 1 }])
    // The failed ask cannot show whether its request left, so typesafe's total is an upper bound.
    expect(stats.egress).toEqual([
      { engine: 'typesafe', asks: 2, chars: 5_000, bound: 'at-most' },
      { engine: 'laya', asks: 1, chars: 12_000, bound: 'at-most' },
    ])
    expect(stats.recent.map(row => row.engine)).toEqual([null, 'laya', 'typesafe', 'typesafe'])
    expect(stats.counts.judgeFailed).toBe(2)
    // The failed ask's 90 ms lands in the histogram beside the answers.
    expect(stats.latency.counts.reduce((sum, count) => sum + count, 0)).toBe(3)
    expect(stats.latency.includesFailed).toBe(true)
  })

  it('counts nothing sent for an engine the dispatcher reports unconfigured', () => {
    const log = new Log()
    log.step(0, 1, 1)
    // The review's probe: TypeSafe selected without a key.
    log.decide(1, {
      reason: 'engine-unavailable', engineFailure: { code: 'UNCONFIGURED' }, engineId: 'typesafe', inputChars: 12_000, latencyMs: 2,
    })
    const refused = fold(log)
    expect(refused.egress).toEqual([])
    expect(refused.counts.judgeFailed).toBe(1)
    // A refusal before any request is not a judge call.
    expect(refused.latency.counts.every(count => count === 0)).toBe(true)
    expect(refused.criticalPath.totalMs).toBe(2)
    log.decide(2, { reason: 'engine-unavailable', engineFailure: { code: 'DEADLINE' }, engineId: 'typesafe', inputChars: 12_000, latencyMs: 1_500 })
    expect(fold(log).egress).toEqual([{ engine: 'typesafe', asks: 1, chars: 12_000, bound: 'at-most' }])
  })

  it('counts nothing sent for a call the dispatcher refused before dispatching it, and still counts the failure', () => {
    const log = new Log()
    log.step(0, 1, 1)
    // TypeSafe registered without a key reports `unconfigured`; the dispatcher refuses it UNAVAILABLE.
    log.decide(1, {
      reason: 'engine-unavailable',
      engineFailure: { code: 'UNAVAILABLE', refusedBeforeDispatch: true },
      engineId: 'typesafe',
      inputChars: 12_000,
      latencyMs: 1,
    })
    const refused = fold(log)
    expect(refused.egress).toEqual([])
    expect(refused.counts.judgeFailed).toBe(1)
    expect(refused.counts.warmUps).toBe(0)
    expect(refused.latency.counts.every(count => count === 0)).toBe(true)
    // The same failure from the engine itself may have left the machine.
    log.decide(2, { reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' }, engineId: 'typesafe', inputChars: 12_000, latencyMs: 40 })
    expect(fold(log).egress).toEqual([{ engine: 'typesafe', asks: 1, chars: 12_000, bound: 'at-most' }])
    expect(fold(log).counts.judgeFailed).toBe(2)
  })

  it('counts a rejected fit as an upper bound', () => {
    const log = new Log()
    log.step(0, 1, 1)
    log.decide(1, { reason: 'judgment-input-too-large', engine: 'Laya', engineId: 'laya', inputChars: 30_000, latencyMs: 5 })
    expect(fold(log).egress).toEqual([{ engine: 'laya', asks: 1, chars: 30_000, bound: 'at-most' }])
  })

  it('times the judge call alone and folds the eligibility assessment and the critical path apart', () => {
    const log = new Log()
    log.step(0, 1, 1)
    // The review's probe: a 1000 ms answer after an 800 ms assessment, against a 1500 ms deadline.
    log.decide(1, consult({ engine: 'laya', latencyMs: 1_000, eligibilityMs: 800 }))
    log.decide(2, { reason: 'candidate-ineligible', eligibilityMs: 400 })
    log.step(1, 2, 3)
    log.decide(4, consult({ engine: 'laya', latencyMs: 30 }))
    const stats = fold(log)
    expect(stats.latency.counts[LATENCY_BUCKETS_MS.indexOf(1_000)]).toBe(1)
    expect(stats.latency.counts[LATENCY_BUCKETS_MS.indexOf(50)]).toBe(1)
    expect(stats.latency.counts.reduce((sum, count) => sum + count, 0)).toBe(2)
    expect(stats.latency).toMatchObject({ includesFailed: false, p95: 1_000 })
    expect(stats.eligibility.counts[LATENCY_BUCKETS_MS.indexOf(1_000)]).toBe(1)
    expect(stats.eligibility.counts[LATENCY_BUCKETS_MS.indexOf(500)]).toBe(1)
    expect(stats.eligibility).toMatchObject({ p50: 500, p95: 1_000 })
    // Two turns with decisions share 2230 ms; the last decision recorded no assessment time.
    expect(stats.criticalPath).toEqual({ totalMs: 2_230, perTurnMs: 1_115, judgeOnly: 1 })
  })

  it('sums the judge\'s reported usage', () => {
    const log = new Log()
    log.step(0, 1, 1)
    log.decide(1, consult({ engine: 'llm:x', judgeUsage: usage(1_000, 20, 500) }))
    log.decide(2, consult({ engine: 'llm:x' }))
    log.decide(3, { reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' }, judgeUsage: usage(300, 0) })
    expect(fold(log).judge).toEqual({ calls: 2, promptTokens: 1_800, outputTokens: 20 })
  })

  it('counts consults under the distinct thresholds they recorded', () => {
    const log = new Log()
    log.step(0, 1, 1)
    const global = { downgradeThreshold: 0.8, downgradeMargin: 0.1, source: 'global' as const }
    const point = { downgradeThreshold: 0.7, downgradeMargin: 0.05, source: 'operating-point' as const, calibratedBy: 'prereg-3' }
    log.decide(1, consult({ thresholds: global }))
    log.decide(2, consult({ thresholds: point }))
    log.decide(3, consult({ thresholds: global }))
    log.decide(4, consult({ thresholds: { ...global, source: 'operating-point' } }))
    log.decide(5, consult({ thresholds: { ...global, downgradeMargin: 0.2 } }))
    log.decide(6, consult({ thresholds: { ...point, calibratedBy: 'prereg-4' } }))
    log.decide(7, consult({ thresholds: { ...point, downgradeThreshold: 0.75 } }))
    log.decide(8, consult({}))
    log.decide(9, { reason: 'engine-unavailable', engineFailure: { code: 'UNAVAILABLE' }, thresholds: global })
    expect(fold(log).thresholds).toEqual([
      { downgradeThreshold: 0.8, downgradeMargin: 0.1, source: 'global', calibratedBy: null, consults: 2 },
      { downgradeThreshold: 0.7, downgradeMargin: 0.05, source: 'operating-point', calibratedBy: 'prereg-3', consults: 1 },
      { downgradeThreshold: 0.8, downgradeMargin: 0.1, source: 'operating-point', calibratedBy: null, consults: 1 },
      { downgradeThreshold: 0.8, downgradeMargin: 0.2, source: 'global', calibratedBy: null, consults: 1 },
      { downgradeThreshold: 0.7, downgradeMargin: 0.05, source: 'operating-point', calibratedBy: 'prereg-4', consults: 1 },
      { downgradeThreshold: 0.75, downgradeMargin: 0.05, source: 'operating-point', calibratedBy: 'prereg-3', consults: 1 },
    ])
  })

  it('counts a warm-up apart: no failure, no egress, no latency', () => {
    const log = new Log()
    log.step(0, 1, 1)
    log.decide(1, {
      reason: 'engine-unavailable',
      engineFailure: { code: 'UNAVAILABLE', engineState: 'starting' },
      engineId: 'laya',
      latencyMs: 1,
    })
    const stats = fold(log)
    expect(stats.counts).toMatchObject({ judgeFailed: 0, warmUps: 1, deadlineHits: 0 })
    expect(stats.egress).toEqual([])
    expect(stats.latency.counts.every(count => count === 0)).toBe(true)
    expect(stats.recent[0]?.engine).toBe('laya')
  })

  it('groups an engine refused as uncalibrated with the preconditions', () => {
    const log = new Log()
    log.step(0, 1, 1)
    log.decide(1, { reason: 'engine-uncalibrated', engineId: 'laya' })
    const stats = fold(log)
    expect(stats.reasons).toEqual([{ reason: 'engine-uncalibrated', group: 'fail-closed', count: 1 }])
    expect(stats.egress).toEqual([])
    // An answering engine refused after its call: the state was sent and the call took time.
    log.decide(2, { reason: 'engine-uncalibrated', engineId: 'laya', inputChars: 2_500, latencyMs: 40, engine: 'Laya' })
    const answered = fold(log)
    expect(answered.egress).toEqual([{ engine: 'laya', asks: 1, chars: 2_500, bound: 'exact' }])
    expect(answered.latency.counts.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(answered.engines).toEqual([])
    expect(modelRoutingStatsSchema.safeParse(stats).success).toBe(true)
  })
})
