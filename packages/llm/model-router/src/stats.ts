/**
 * The `modelRoutingStats` fold: one session's routing counts, reason and exit
 * histograms, streak lengths, judge confidence and latency, per-model token
 * classes, cold prefills, moved tokens, judge egress, step timeline, and most
 * recent decisions, computed from the session log alone.
 *
 * Definitions:
 * - a decision is a `model-routing/decision` event, positioned at the turn and
 *   step of the latest `step/start` before it (0 and 0 before any);
 * - a call is an `assistant/message` event carrying `usage`, served by its
 *   message source's provider and model; its request start is the time of its
 *   step's `step/start`;
 * - a step is a distinct `(turn, step)` with at least one call, attributed to
 *   the model of its last call;
 * - a call is candidate-served when the latest decision at or before it in the
 *   same turn is `downgraded` and selected the call's provider and model;
 * - a streak is entered by a `downgraded` decision whose predecessor decision
 *   left no streak active, and exits at the next decision that leaves none
 *   active. Its length is the number of steps from the entering decision up to
 *   the exiting one, exclusive; an open streak runs to the end of the log.
 *
 * Input tokens follow the usage presence contract of `TokenUsage`: a call that
 * reported cache counts contributes its `inputTokens` as uncached input plus
 * its cache reads and writes; a call that reported none contributes its whole
 * prompt as unreported input. The log does not record a model's prompt-cache
 * lifetime, so idle expiry uses {@link COLD_TTL_FALLBACK_MS} and the snapshot
 * reports that fallback.
 *
 * The unit state is plain JSON. Retained lists are capped as the snapshot
 * documents; the unbounded parts are one entry per turn (the aggregated
 * timeline's points), per served model, per engine name, and per distinct
 * streak length.
 *
 * @module
 */

import { cacheCount, promptTokens } from '@shres-code/shres-code-llm'
import type { TokenUsage } from '@shres-code/shres-code-llm'
import type { SessionEvent } from '@shres-code/shres-code-session'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { KEEP_CURRENT_OPTION_ID } from './config.ts'
import type {
  ModelRoutingColdCause,
  ModelRoutingLoggedDecision,
  ModelRoutingObjective,
  ModelRoutingOutcome,
  ModelRoutingReason,
  ModelRoutingReasonGroup,
  ModelRoutingRouteAnswer,
  ModelRoutingStatsModel,
  ModelRoutingStatsSnapshot,
  ModelRoutingTimelineMark,
} from './types.ts'

/** Latency histogram upper bounds in milliseconds: the 1-2-5 series from 1 ms to 20 s, then 30 s. */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
]

/** Most recent per-consult confidence values and margins retained. */
export const RETAINED_CONSULTS = 500

/** Most recent decisions retained for the decisions table. */
export const RETAINED_RECENT_DECISIONS = 200

/** Steps the timeline shows one by one; a longer log shows one point per turn. */
export const TIMELINE_STEP_LIMIT = 400

/** Most recent timeline marks, and most recent timeline decisions, retained. */
export const RETAINED_TIMELINE_EVENTS = 400

/** Smallest input a cold call processes, in tokens. */
export const COLD_MIN_INPUT_TOKENS = 4_096

/** Cache-read share of the processed input below which a reported call is cold. */
export const COLD_READ_RATIO = 0.1

/** Prompt-cache lifetime assumed for idle expiry, 300 s. */
export const COLD_TTL_FALLBACK_MS = 300_000

/** Cold causes in snapshot order, which is also the first-match order. */
const COLD_CAUSES: readonly ModelRoutingColdCause[] = [
  'routed-switch',
  'routed-return',
  'manual-switch',
  'idle-expiry',
  'session-start',
  'post-compaction',
  'other',
]

/**
 * Reason groups: the route switched or held; the judge kept the strong route;
 * a precondition kept it without a usable judgment; or the engine or the
 * routed request failed. `engine-uncalibrated`, a selected engine refused
 * because its calibration is only verbalized, is a precondition: the engine
 * was not asked.
 */
const REASON_GROUPS: Readonly<Record<ModelRoutingReason | 'engine-uncalibrated', ModelRoutingReasonGroup>> = {
  'gate-passed': 'switched',
  'sticky-hold': 'switched',
  'judgment-failure-held': 'switched',
  'current-preferred': 'judge-no',
  'low-confidence': 'judge-no',
  'thin-margin': 'judge-no',
  'difficulty-too-high': 'judge-no',
  'escalated': 'judge-no',
  'gate-failed': 'judge-no',
  'engine-absent': 'fail-closed',
  'engine-disabled': 'fail-closed',
  'engine-uncalibrated': 'fail-closed',
  'no-candidates': 'fail-closed',
  'base-unlisted': 'fail-closed',
  'model-unavailable': 'fail-closed',
  'candidate-ineligible': 'fail-closed',
  'state-too-large': 'fail-closed',
  'candidate-equals-base': 'fail-closed',
  'thinking-mode-incompatible': 'fail-closed',
  'hold-cap': 'fail-closed',
  'reentry-cooldown': 'fail-closed',
  'manual-deviation': 'fail-closed',
  'mode-off': 'fail-closed',
  'engine-unavailable': 'engine',
  'invalid-answer': 'engine',
  'judgment-input-too-large': 'engine',
  'breaker-open': 'engine',
  'unknown-candidate': 'engine',
  'judgment-error': 'engine',
  'route-errors': 'engine',
  'route-failed': 'engine',
}

/** One provider route and model. */
interface Route {
  provider: string
  model: string
}

/** Token classes and step and call counts of one model that served calls. */
interface ModelTally extends Route {
  steps: number
  calls: number
  uncached: number
  unreported: number
  cacheRead: number
  cacheWrite: number
  output: number
  reportedCalls: number
  /** Request start of this model's latest call, for idle expiry. */
  lastStart: number
}

/** One timeline step; `model` indexes the state's model tallies. */
interface StepPoint {
  turn: number
  step: number
  model: number
  seq: number
  t: number
}

/** One turn's steps: the timeline's point when the log is aggregated. */
interface TurnPoint {
  turn: number
  /** The turn's first step. */
  step: number
  /** Global index of the turn's first step. */
  first: number
  /** Seq of the turn's latest call. */
  seq: number
  /** Time of the turn's latest call. */
  t: number
  /** Steps per model tally, keyed by the tally's index. */
  models: Record<string, number>
}

/** One decision on the timeline; `engine` indexes the answering engines. */
interface TimelineDecision {
  seq: number
  i: number
  outcome: ModelRoutingOutcome
  reason: string
  best: number | null
  engine: number | null
}

/** One row of the recent-decisions table. */
type RecentDecision = ModelRoutingStatsSnapshot['recent'][number]

/** Count and re-written tokens of one cold cause. */
interface ColdTally {
  count: number
  tokens: number
}

/**
 * The fold's unit state. Plain JSON: an absent value is `null`, never
 * `undefined`, so a persisted checkpoint restores the same state.
 */
export interface ModelRoutingStatsState {
  /** Turn, step, and start time of the latest `step/start`. */
  position: { turn: number; step: number; start: number } | null
  counts: ModelRoutingStatsSnapshot['counts']
  /** Turn of the latest decision. */
  lastDecisionTurn: number | null
  reasons: Record<string, number>
  keptReasons: Record<string, number>
  exits: Record<string, number>
  /** Whether the latest decision left a streak active. */
  stickyActive: boolean
  /** Closed streak lengths, keyed by length in steps. */
  streakLengths: Record<string, number>
  /** Steps the open streak has counted, and the last step it counted. */
  openStreak: { steps: number; lastStep: string | null } | null
  confidence: { values: number[]; margins: number[]; max: number | null }
  latency: number[]
  /** Whether a failed ask's latency is in {@link latency}. */
  latencyIncludesFailed: boolean
  /** Asks in {@link latency} whose latency includes the eligibility assessment. */
  latencyWithEligibility: number
  judge: ModelRoutingStatsSnapshot['judge']
  thresholds: ModelRoutingStatsSnapshot['thresholds']
  /** Served models in first-appearance order. */
  models: ModelTally[]
  /** Configured candidates of the latest decision that recorded them, in configuration order. */
  pool: Route[]
  /** Routes decisions selected, in first-appearance order. */
  selected: Route[]
  /** The latest manual route: a call no decision routed, a streak's entry base, or a manual selection. */
  manual: Route | null
  lastCall: Route | null
  /** The latest decision's turn and, when it downgraded, its selection. */
  turnDecision: { turn: number; downgraded: Route | null } | null
  /** Cold-cause evidence gathered since the previous call. */
  since: { switchTurn: number | null; exited: boolean; manual: boolean; compacted: boolean }
  /** A streak exited and no call has been served since. */
  returnArmed: boolean
  cold: Record<ModelRoutingColdCause, ColdTally>
  moved: { tokensOffStrong: number; returnReprefill: number }
  objective: { latest: ModelRoutingObjective; mixed: boolean } | null
  egress: { engine: string; asks: number; chars: number; exact: boolean }[]
  engines: { name: string; decisions: number }[]
  /** The latest step with a call. */
  current: { key: string; index: number; model: number; downgraded: boolean } | null
  /** Steps one by one while the log has at most {@link TIMELINE_STEP_LIMIT}; empty beyond it. */
  steps: StepPoint[]
  turns: TurnPoint[]
  marks: { i: number; kind: ModelRoutingTimelineMark }[]
  decisions: TimelineDecision[]
  /** Oldest first. */
  recent: RecentDecision[]
}

/**
 * The state for the empty log.
 * @returns a state with every count at zero.
 */
export function createStatsState(): ModelRoutingStatsState {
  return {
    position: null,
    counts: {
      decisions: 0,
      consults: 0,
      downgradedSteps: 0,
      steps: 0,
      streaks: 0,
      keptStrong: 0,
      routeFailed: 0,
      judgeFailed: 0,
      deadlineHits: 0,
      warmUps: 0,
      turnsWithDecisions: 0,
    },
    lastDecisionTurn: null,
    reasons: {},
    keptReasons: {},
    exits: {},
    stickyActive: false,
    streakLengths: {},
    openStreak: null,
    confidence: { values: [], margins: [], max: null },
    latency: LATENCY_BUCKETS_MS.map(() => 0),
    latencyIncludesFailed: false,
    latencyWithEligibility: 0,
    judge: { calls: 0, promptTokens: 0, outputTokens: 0 },
    thresholds: [],
    models: [],
    pool: [],
    selected: [],
    manual: null,
    lastCall: null,
    turnDecision: null,
    since: { switchTurn: null, exited: false, manual: false, compacted: false },
    returnArmed: false,
    cold: Object.fromEntries(COLD_CAUSES.map(cause => [cause, { count: 0, tokens: 0 }])) as Record<ModelRoutingColdCause, ColdTally>,
    moved: { tokensOffStrong: 0, returnReprefill: 0 },
    objective: null,
    egress: [],
    engines: [],
    current: null,
    steps: [],
    turns: [],
    marks: [],
    decisions: [],
    recent: [],
  }
}

/**
 * Advance the state by one committed event. Only `step/start`, decisions,
 * calls, `agent/model-selection`, and a successful `compaction/end` change it;
 * every other event returns the same state reference.
 * @param state - the state covering all prior events.
 * @param event - the next committed event.
 * @returns the next state.
 */
export function applyStatsEvent(state: ModelRoutingStatsState, event: SessionEvent): ModelRoutingStatsState {
  if (isCompactionEnd(event)) return { ...state, since: { ...state.since, compacted: true } }
  switch (event.type) {
    case 'step/start':
      return { ...state, position: { turn: event.data.turn, step: event.data.step, start: event.time } }
    case 'model-routing/decision':
      return applyDecision(state, event.seq, event.time, event.data)
    case 'assistant/message':
      if (event.data.usage === undefined) return state
      return applyCall(state, event.seq, event.time, event.data.turn, event.data.step, {
        provider: event.data.message.source.provider,
        model: event.data.message.source.model,
      }, event.data.usage)
    case 'agent/model-selection':
      return applySelection(state, { provider: event.data.provider, model: event.data.model })
    default:
      return state
  }
}

/**
 * Whether the event is a successful `compaction/end`. The compaction package
 * owns that event type and this package does not depend on it, so the type
 * name and the `error` field are read from the envelope.
 * @param event - one committed event.
 * @returns whether a compaction completed.
 */
function isCompactionEnd(event: SessionEvent): boolean {
  const record = event as unknown as { type: string; data: { error?: unknown } }
  return record.type === 'compaction/end' && record.data.error === undefined
}

/** Fold one decision. */
function applyDecision(
  state: ModelRoutingStatsState,
  seq: number,
  time: number,
  data: ModelRoutingLoggedDecision,
): ModelRoutingStatsState {
  const turn = state.position?.turn ?? 0
  const step = state.position?.step ?? 0
  const route = data.route
  const best = route === undefined ? null : bestConfidence(route)
  const entry = data.outcome === 'downgraded' && !state.stickyActive
  const exit = state.stickyActive && !data.sticky.active
  const brokenBy = data.sticky.active ? undefined : data.sticky.brokenBy
  const selection = data.outcome === 'downgraded' && data.selection !== undefined
    ? { provider: data.selection.provider, model: data.selection.model }
    : null
  // The registry id names the engine on answers and failures alike; older
  // decisions name only the engine that answered, as its provider reported it.
  const engineName = data.engineId ?? data.engine
  const warmUp = data.engineFailure?.engineState !== undefined
  const failed = judgeFailed(data)
  const asked = route !== undefined || failed
  const answeredBy = route === undefined ? undefined : engineName
  const engines = answeredBy === undefined ? state.engines : countEngine(state.engines, answeredBy)
  const engineIndex = answeredBy === undefined ? null : engines.findIndex(engine => engine.name === answeredBy)
  const latencyMs = data.latencyMs
  const timed = asked && latencyMs !== undefined
  const index = timelineIndex(state, turn, step)
  const mark: ModelRoutingTimelineMark | undefined = entry
    ? 'down'
    : data.reason === 'route-failed' ? 'failed' : exit ? 'return' : undefined
  return {
    ...state,
    counts: {
      ...state.counts,
      decisions: state.counts.decisions + 1,
      consults: state.counts.consults + (route === undefined ? 0 : 1),
      streaks: state.counts.streaks + (entry ? 1 : 0),
      keptStrong: state.counts.keptStrong + (data.outcome === 'kept-strong' ? 1 : 0),
      routeFailed: state.counts.routeFailed + (data.reason === 'route-failed' ? 1 : 0),
      judgeFailed: state.counts.judgeFailed + (failed ? 1 : 0),
      deadlineHits: state.counts.deadlineHits + (data.engineFailure?.code === 'DEADLINE' ? 1 : 0),
      warmUps: state.counts.warmUps + (warmUp ? 1 : 0),
      turnsWithDecisions: state.counts.turnsWithDecisions + (state.lastDecisionTurn === turn ? 0 : 1),
    },
    lastDecisionTurn: turn,
    reasons: increment(state.reasons, data.reason),
    keptReasons: data.outcome === 'kept-strong' ? increment(state.keptReasons, data.reason) : state.keptReasons,
    exits: brokenBy === undefined ? state.exits : increment(state.exits, brokenBy),
    stickyActive: data.sticky.active,
    streakLengths: exit && state.openStreak !== null
      ? increment(state.streakLengths, String(state.openStreak.steps))
      : state.streakLengths,
    openStreak: entry ? { steps: 0, lastStep: null } : exit ? null : state.openStreak,
    confidence: route === undefined ? state.confidence : addConsult(state.confidence, route),
    latency: timed ? addLatency(state.latency, latencyMs + (data.eligibilityMs ?? 0)) : state.latency,
    latencyIncludesFailed: state.latencyIncludesFailed || (timed && route === undefined),
    latencyWithEligibility: state.latencyWithEligibility + (timed && data.eligibilityMs !== undefined ? 1 : 0),
    judge: data.judgeUsage === undefined ? state.judge : {
      calls: state.judge.calls + 1,
      promptTokens: state.judge.promptTokens + promptTokens(data.judgeUsage),
      outputTokens: state.judge.outputTokens + data.judgeUsage.outputTokens,
    },
    thresholds: route === undefined || data.thresholds === undefined
      ? state.thresholds
      : countThresholds(state.thresholds, data.thresholds),
    pool: data.candidateEligibility === undefined
      ? state.pool
      : data.candidateEligibility.candidates.map(candidate => ({ provider: candidate.provider, model: candidate.model })),
    selected: selection === null || state.selected.some(known => sameRoute(known, selection))
      ? state.selected
      : [...state.selected, selection],
    manual: data.sticky.entryBase === undefined
      ? state.manual
      : { provider: data.sticky.entryBase.provider, model: data.sticky.entryBase.model },
    turnDecision: { turn, downgraded: selection },
    since: {
      ...state.since,
      switchTurn: selection !== null && (state.lastCall === null || !sameRoute(state.lastCall, selection))
        ? turn
        : state.since.switchTurn,
      exited: state.since.exited || brokenBy !== undefined,
    },
    returnArmed: exit || state.returnArmed,
    objective: data.objective === undefined ? state.objective : {
      latest: data.objective,
      mixed: state.objective !== null && (state.objective.mixed || state.objective.latest !== data.objective),
    },
    egress: !asked || engineName === undefined ? state.egress : countEgress(state.egress, engineName, data),
    engines,
    marks: mark === undefined ? state.marks : retain([...state.marks, { i: index, kind: mark }], RETAINED_TIMELINE_EVENTS),
    decisions: retain([...state.decisions, {
      seq,
      i: index,
      outcome: data.outcome,
      reason: data.reason,
      best,
      engine: engineIndex,
    }], RETAINED_TIMELINE_EVENTS),
    recent: retain([...state.recent, {
      seq,
      t: time,
      turn,
      step,
      outcome: data.outcome,
      reason: data.reason,
      best,
      difficulty: data.difficulty?.score ?? null,
      engine: engineName ?? null,
      latencyMs: latencyMs ?? null,
    }], RETAINED_RECENT_DECISIONS),
  }
}

/** Fold one call. */
function applyCall(
  state: ModelRoutingStatsState,
  seq: number,
  time: number,
  turn: number,
  step: number,
  served: Route,
  usage: TokenUsage,
): ModelRoutingStatsState {
  const key = stepKey(turn, step)
  const current = state.current
  const newStep = current === null || current.key !== key
  const start = state.position !== null && state.position.turn === turn && state.position.step === step
    ? state.position.start
    : time
  const candidate = state.turnDecision !== null
    && state.turnDecision.turn === turn
    && state.turnDecision.downgraded !== null
    && sameRoute(state.turnDecision.downgraded, served)
  const read = cacheCount(usage, 'read')
  const write = cacheCount(usage, 'write') ?? 0
  const processed = promptTokens(usage)

  const found = state.models.findIndex(model => sameRoute(model, served))
  const modelIndex = found === -1 ? state.models.length : found
  const prior = state.models[found]
  const idle = prior !== undefined && start - prior.lastStart > COLD_TTL_FALLBACK_MS
  const tally: ModelTally = prior === undefined
    ? {
      ...served,
      steps: 0,
      calls: 0,
      uncached: 0,
      unreported: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reportedCalls: 0,
      lastStart: start,
    }
    : { ...prior, lastStart: start }
  tally.calls += 1
  tally.output += usage.outputTokens
  if (read === undefined) {
    tally.unreported += processed
  } else {
    tally.uncached += usage.inputTokens
    tally.cacheRead += read
    tally.cacheWrite += write
    tally.reportedCalls += 1
  }
  const models = found === -1 ? [...state.models, tally] : state.models.map((model, at) => at === found ? tally : model)
  // A step is attributed to the model of its last call: a later call in the
  // same step on another model moves the step to that model.
  const previousModel = newStep ? undefined : current.model
  if (previousModel !== modelIndex) {
    tally.steps += 1
    if (previousModel !== undefined) {
      const moved = models[previousModel] as ModelTally
      models[previousModel] = { ...moved, steps: moved.steps - 1 }
    }
  }

  const index = newStep ? state.counts.steps : current.index
  const stepsSeen = state.counts.steps + (newStep ? 1 : 0)
  const alreadyDowngraded = !newStep && current.downgraded
  const point: StepPoint = { turn, step, model: modelIndex, seq, t: time }
  const cold = coldCall(usage, read, write, processed)
  const cause = cold === undefined ? undefined : coldCause(state, turn, candidate, idle)

  return {
    ...state,
    counts: {
      ...state.counts,
      steps: stepsSeen,
      downgradedSteps: state.counts.downgradedSteps + (candidate && !alreadyDowngraded ? 1 : 0),
    },
    models,
    manual: candidate ? state.manual : served,
    lastCall: served,
    since: { switchTurn: null, exited: false, manual: false, compacted: false },
    openStreak: state.openStreak === null || state.openStreak.lastStep === key
      ? state.openStreak
      : { steps: state.openStreak.steps + 1, lastStep: key },
    returnArmed: false,
    moved: {
      tokensOffStrong: state.moved.tokensOffStrong + (candidate ? processed + usage.outputTokens : 0),
      returnReprefill: state.moved.returnReprefill
        + (state.returnArmed && !candidate ? (read === undefined ? processed : write + usage.inputTokens) : 0),
    },
    cold: cause === undefined || cold === undefined ? state.cold : {
      ...state.cold,
      [cause]: { count: state.cold[cause].count + 1, tokens: state.cold[cause].tokens + cold },
    },
    current: { key, index, model: modelIndex, downgraded: candidate || alreadyDowngraded },
    steps: stepsSeen > TIMELINE_STEP_LIMIT
      ? []
      : newStep ? [...state.steps, point] : [...state.steps.slice(0, -1), point],
    turns: advanceTurns(state.turns, turn, step, index, previousModel, modelIndex, seq, time),
    marks: idle ? retain([...state.marks, { i: index, kind: 'idle' }], RETAINED_TIMELINE_EVENTS) : state.marks,
  }
}

/**
 * Fold one manual model selection. A change from the current manual route is a
 * manual switch, marked at the next step with a call.
 */
function applySelection(state: ModelRoutingStatsState, selected: Route): ModelRoutingStatsState {
  const changed = state.manual !== null && !sameRoute(state.manual, selected)
  return {
    ...state,
    manual: selected,
    since: { ...state.since, manual: state.since.manual || changed },
    marks: changed
      ? retain([...state.marks, { i: state.counts.steps, kind: 'manual' }], RETAINED_TIMELINE_EVENTS)
      : state.marks,
  }
}

/**
 * The tokens a cold call re-wrote: cache writes plus uncached input, for a
 * call that reported cache counts, processed at least
 * {@link COLD_MIN_INPUT_TOKENS}, and read less than {@link COLD_READ_RATIO} of
 * them from cache.
 * @returns the tokens, or `undefined` for a call that is not cold.
 */
function coldCall(usage: TokenUsage, read: number | undefined, write: number, processed: number): number | undefined {
  if (read === undefined || processed < COLD_MIN_INPUT_TOKENS || read / processed >= COLD_READ_RATIO) return undefined
  return write + usage.inputTokens
}

/**
 * The first matching cold cause, in {@link COLD_CAUSES} order: a candidate
 * call after a decision in its turn switched onto that candidate; a call after
 * a decision that ended a streak; a call after a manual switch; a call more
 * than the cache lifetime after its model's previous request started; the
 * session's first call; a call after a completed compaction; otherwise other.
 */
function coldCause(
  state: ModelRoutingStatsState,
  turn: number,
  candidate: boolean,
  idle: boolean,
): ModelRoutingColdCause {
  if (candidate && state.since.switchTurn === turn) return 'routed-switch'
  if (state.since.exited) return 'routed-return'
  if (state.since.manual) return 'manual-switch'
  if (idle) return 'idle-expiry'
  if (state.lastCall === null) return 'session-start'
  if (state.since.compacted) return 'post-compaction'
  return 'other'
}

/** Record one step in its turn's point, starting a point on the turn's first step. */
function advanceTurns(
  turns: readonly TurnPoint[],
  turn: number,
  step: number,
  index: number,
  previousModel: number | undefined,
  model: number,
  seq: number,
  time: number,
): TurnPoint[] {
  const last = turns.at(-1)
  if (last === undefined || last.turn !== turn) {
    return [...turns, { turn, step, first: index, seq, t: time, models: { [String(model)]: 1 } }]
  }
  const models = { ...last.models }
  if (previousModel !== model) {
    if (previousModel !== undefined) models[String(previousModel)] = (models[String(previousModel)] as number) - 1
    models[String(model)] = (models[String(model)] ?? 0) + 1
  }
  return [...turns.slice(0, -1), { ...last, seq, t: time, models }]
}

/**
 * The timeline index a decision or mark at this position points at: its
 * step's index when that step already has a call, else the index the next
 * step with a call will take.
 */
function timelineIndex(state: ModelRoutingStatsState, turn: number, step: number): number {
  return state.current !== null && state.current.key === stepKey(turn, step) ? state.current.index : state.counts.steps
}

/**
 * The confidence the strongest challenger reached in one route answer: the
 * answer's confidence when it chose a candidate, else the largest probability
 * over the candidate options, or 0 when it lists none.
 * @param route - the logged route answer.
 * @returns the best-candidate confidence.
 */
export function bestConfidence(route: ModelRoutingRouteAnswer): number {
  if (route.choice !== KEEP_CURRENT_OPTION_ID) return route.confidence
  let best = 0
  for (const [option, probability] of Object.entries(route.probabilities)) {
    if (option !== KEEP_CURRENT_OPTION_ID && probability > best) best = probability
  }
  return best
}

/**
 * The top-two probability margin of one choice answer.
 * @param probabilities - the answer's distribution.
 * @returns the margin between the two highest probabilities.
 */
export function routeMargin(probabilities: Readonly<Record<string, number>>): number {
  let top1 = 0
  let top2 = 0
  for (const value of Object.values(probabilities)) {
    if (value > top1) {
      top2 = top1
      top1 = value
    } else if (value > top2) {
      top2 = value
    }
  }
  return top1 - top2
}

/** Add one answered consult's best-candidate confidence and margin. */
function addConsult(
  confidence: ModelRoutingStatsState['confidence'],
  route: ModelRoutingRouteAnswer,
): ModelRoutingStatsState['confidence'] {
  const best = bestConfidence(route)
  return {
    values: retain([...confidence.values, best], RETAINED_CONSULTS),
    margins: retain([...confidence.margins, routeMargin(route.probabilities)], RETAINED_CONSULTS),
    max: confidence.max === null ? best : Math.max(confidence.max, best),
  }
}

/** Count one ask's latency in its bucket; above the last bound counts in the last bucket. */
function addLatency(latency: readonly number[], latencyMs: number): number[] {
  const found = LATENCY_BUCKETS_MS.findIndex(bound => latencyMs <= bound)
  const bucket = found === -1 ? LATENCY_BUCKETS_MS.length - 1 : found
  return latency.map((count, at) => at === bucket ? count + 1 : count)
}

/**
 * Whether a decision records a failed judgment call. A warm-up, an engine
 * still becoming ready, was not called and is not a failure.
 */
function judgeFailed(data: ModelRoutingLoggedDecision): boolean {
  if (data.engineFailure?.engineState !== undefined) return false
  return data.engineFailure !== undefined || data.reason === 'engine-unavailable' || data.reason === 'invalid-answer'
}

/** Count one consult under the thresholds it recorded, keeping first-appearance order. */
function countThresholds(
  thresholds: ModelRoutingStatsSnapshot['thresholds'],
  applied: NonNullable<ModelRoutingLoggedDecision['thresholds']>,
): ModelRoutingStatsSnapshot['thresholds'] {
  const calibratedBy = applied.calibratedBy ?? null
  const same = (entry: ModelRoutingStatsSnapshot['thresholds'][number]) => entry.downgradeThreshold === applied.downgradeThreshold
    && entry.downgradeMargin === applied.downgradeMargin && entry.source === applied.source && entry.calibratedBy === calibratedBy
  if (!thresholds.some(same)) {
    return [...thresholds, {
      downgradeThreshold: applied.downgradeThreshold,
      downgradeMargin: applied.downgradeMargin,
      source: applied.source,
      calibratedBy,
      consults: 1,
    }]
  }
  return thresholds.map(entry => same(entry) ? { ...entry, consults: entry.consults + 1 } : entry)
}

/** Count one answered decision for an engine name. */
function countEngine(engines: ModelRoutingStatsState['engines'], name: string): ModelRoutingStatsState['engines'] {
  return engines.some(engine => engine.name === name)
    ? engines.map(engine => engine.name === name ? { ...engine, decisions: engine.decisions + 1 } : engine)
    : [...engines, { name, decisions: 1 }]
}

/**
 * Count one judge ask and its state characters: the recorded input size, else
 * the recorded judgment input's length, else the projection's character budget
 * as an upper bound.
 */
function countEgress(
  egress: ModelRoutingStatsState['egress'],
  engine: string,
  data: ModelRoutingLoggedDecision,
): ModelRoutingStatsState['egress'] {
  const exact = data.inputChars !== undefined || data.judgmentInput !== undefined
  const chars = data.inputChars ?? data.judgmentInput?.state.length ?? data.stateProjection?.maxChars ?? 0
  const known = egress.find(entry => entry.engine === engine)
  if (known === undefined) return [...egress, { engine, asks: 1, chars, exact }]
  return egress.map(entry => entry === known
    ? { engine, asks: entry.asks + 1, chars: entry.chars + chars, exact: entry.exact && exact }
    : entry)
}

/** A histogram with one more count under `key`. */
function increment(histogram: Readonly<Record<string, number>>, key: string): Record<string, number> {
  return { ...histogram, [key]: (histogram[key] ?? 0) + 1 }
}

/** The last `limit` entries. */
function retain<T>(values: T[], limit: number): T[] {
  return values.length > limit ? values.slice(values.length - limit) : values
}

/** Whether two routes name the same provider and model. */
function sameRoute(left: Route, right: Route): boolean {
  return left.provider === right.provider && left.model === right.model
}

/** A step's identity within the session. */
function stepKey(turn: number, step: number): string {
  return String(turn) + ':' + String(step)
}

/**
 * The snapshot for the state.
 * @param state - the folded state.
 * @returns the `modelRoutingStats` projection value.
 */
export function viewStats(state: ModelRoutingStatsState): ModelRoutingStatsSnapshot {
  const { models, indexOf } = orderedModels(state)
  const lengths = streakLengthValues(state)
  const calls = state.models.reduce((sum, model) => sum + model.calls, 0)
  const reportedCalls = state.models.reduce((sum, model) => sum + model.reportedCalls, 0)
  const timed = state.latency.reduce((sum, count) => sum + count, 0)
  return {
    counts: { ...state.counts },
    reasons: ranked(state.reasons).map(({ key, count }) => ({
      reason: key,
      // Every key is a logged `ModelRoutingReason`.
      group: REASON_GROUPS[key as ModelRoutingReason | 'engine-uncalibrated'],
      count,
    })),
    keptReasons: ranked(state.keptReasons).map(({ key, count }) => ({ reason: key, count })),
    exits: ranked(state.exits).map(({ key, count }) => ({ brokenBy: key, count })),
    streakLengths: {
      median: median(lengths),
      max: lengths.at(-1) ?? null,
    },
    confidence: {
      values: [...state.confidence.values],
      margins: [...state.confidence.margins],
      max: state.confidence.max,
      total: state.counts.consults,
    },
    latency: {
      bucketsMs: [...LATENCY_BUCKETS_MS],
      counts: [...state.latency],
      failed: state.counts.judgeFailed,
      p50: timed === 0 ? null : percentile(state.latency, timed, 0.5),
      p95: timed === 0 ? null : percentile(state.latency, timed, 0.95),
      includesFailed: state.latencyIncludesFailed,
      withEligibility: state.latencyWithEligibility,
    },
    judge: { ...state.judge },
    thresholds: state.thresholds.map(entry => ({ ...entry })),
    models,
    cold: COLD_CAUSES.map(cause => ({ cause, count: state.cold[cause].count, tokens: state.cold[cause].tokens })),
    coldTtl: { ms: COLD_TTL_FALLBACK_MS, fallback: true },
    unreportedCallShare: calls === 0 ? null : (calls - reportedCalls) / calls,
    moved: {
      ...state.moved,
      objective: state.objective === null ? null : state.objective.mixed ? 'mixed' : state.objective.latest,
    },
    egress: state.egress.map(entry => ({
      engine: entry.engine,
      asks: entry.asks,
      chars: entry.chars,
      bound: entry.exact ? 'exact' : 'at-most',
    })),
    engines: state.engines.map(engine => ({ ...engine })),
    timeline: timeline(state, indexOf),
    recent: [...state.recent].reverse(),
  }
}

/**
 * Served models in snapshot order — the manual route, then the configured
 * pool and other selected candidates, then the rest by first appearance —
 * with their roles and colour slots. The first five candidates by that order
 * take slots 1 to 5.
 */
function orderedModels(state: ModelRoutingStatsState): {
  models: ModelRoutingStatsModel[]
  indexOf: (tally: number) => number
} {
  const candidates = [
    ...state.pool,
    ...state.selected.filter(selected => !state.pool.some(pooled => sameRoute(pooled, selected))),
  ]
  const rank = (model: ModelTally): number => {
    if (state.manual !== null && sameRoute(state.manual, model)) return -1
    const at = candidates.findIndex(candidate => sameRoute(candidate, model))
    return at === -1 ? candidates.length : at
  }
  const order = state.models
    .map((model, tally) => ({ model, tally, rank: rank(model) }))
    .sort((left, right) => left.rank - right.rank || left.tally - right.tally)
  const positions = new Map(order.map((entry, at) => [entry.tally, at]))
  return {
    models: order.map(({ model, rank: position }): ModelRoutingStatsModel => ({
      provider: model.provider,
      model: model.model,
      role: position === -1 ? 'strong' : position < candidates.length ? 'candidate' : 'other',
      colorSlot: colorSlot(position, candidates.length),
      steps: model.steps,
      calls: model.calls,
      uncached: model.uncached,
      unreported: model.unreported,
      cacheRead: model.cacheRead,
      cacheWrite: model.cacheWrite,
      output: model.output,
      reportedCalls: model.reportedCalls,
    })),
    indexOf: tally => positions.get(tally) as number,
  }
}

/** The colour slot of one ranked model: the strong route, one of five candidate series, or neutral. */
function colorSlot(position: number, candidates: number): ModelRoutingStatsModel['colorSlot'] {
  if (position === -1) return 'strong'
  if (position >= candidates || position >= 5) return 'other'
  return (position + 1) as 1 | 2 | 3 | 4 | 5
}

/** Closed streak lengths plus the open streak's steps so far, ascending. */
function streakLengthValues(state: ModelRoutingStatsState): number[] {
  const lengths: number[] = []
  for (const [length, count] of Object.entries(state.streakLengths)) {
    for (let at = 0; at < count; at += 1) lengths.push(Number(length))
  }
  if (state.openStreak !== null) lengths.push(state.openStreak.steps)
  return lengths.sort((left, right) => left - right)
}

/** The median of ascending values: the middle one, or the mean of the middle two. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle] as number
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/** The upper bound of the bucket holding the nearest-rank percentile. */
function percentile(counts: readonly number[], total: number, share: number): number {
  const rank = Math.ceil(share * total)
  let seen = 0
  let bucket = 0
  while (seen + (counts[bucket] as number) < rank) {
    seen += counts[bucket] as number
    bucket += 1
  }
  return LATENCY_BUCKETS_MS[bucket] as number
}

/** Histogram entries, largest count first, then by key. */
function ranked(histogram: Readonly<Record<string, number>>): { key: string; count: number }[] {
  return Object.entries(histogram)
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

/**
 * The timeline: one point per step, or one per turn when the log has more
 * than {@link TIMELINE_STEP_LIMIT} steps. A turn's point shows the model that
 * served most of its steps; a tie shows the one that first served in the
 * session. A mark or decision positioned after the last step points at the
 * last point; none is kept without a point.
 */
function timeline(
  state: ModelRoutingStatsState,
  indexOf: (tally: number) => number,
): ModelRoutingStatsSnapshot['timeline'] {
  const aggregated = state.counts.steps > TIMELINE_STEP_LIMIT
  const steps = aggregated
    ? state.turns.map(turn => ({
      turn: turn.turn,
      step: turn.step,
      model: indexOf(majority(turn.models)),
      seq: turn.seq,
      t: turn.t,
    }))
    : state.steps.map(point => ({ ...point, model: indexOf(point.model) }))
  if (steps.length === 0) return { steps, marks: [], decisions: [], aggregated }
  const pointOf = (stepIndex: number): number =>
    Math.min(aggregated ? state.turns.findLastIndex(turn => turn.first <= stepIndex) : stepIndex, steps.length - 1)
  return {
    steps,
    marks: state.marks.map(mark => ({ i: pointOf(mark.i), kind: mark.kind })),
    decisions: state.decisions.map(decision => ({ ...decision, i: pointOf(decision.i) })),
    aggregated,
  }
}

/** The model tally with the most steps in one turn; a tie keeps the lowest tally index. */
function majority(models: Readonly<Record<string, number>>): number {
  let best = 0
  let bestSteps = -1
  for (const [tally, steps] of Object.entries(models)) {
    if (steps > bestSteps) {
      best = Number(tally)
      bestSteps = steps
    }
  }
  return best
}

/**
 * The turn and step of the latest `step/start` before one log position: the
 * position a decision is reported at.
 * @param events - the session log.
 * @param index - the array index of the positioned event.
 * @returns the turn and step, or 0 and 0 before any `step/start`.
 */
export function positionBefore(events: readonly SessionEvent[], index: number): { turn: number; step: number } {
  for (let at = index - 1; at >= 0; at -= 1) {
    const event = events[at] as SessionEvent
    if (event.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
  }
  return { turn: 0, step: 0 }
}

/**
 * Fold a whole log: the value the registered projection reaches event by event.
 * @param events - the session log.
 * @returns the snapshot.
 */
export function foldModelRoutingStats(events: readonly SessionEvent[]): ModelRoutingStatsSnapshot {
  return viewStats(events.reduce(applyStatsEvent, createStatsState()))
}

const outcomeSchema = zod.enum(['downgraded', 'kept-strong', 'skipped', 'error'])
const nullableNumber = zod.number().nullable()

/** Wire payload schema of the `modelRoutingStats` projection. */
export const modelRoutingStatsSchema = zod.object({
  counts: zod.object({
    decisions: zod.number(),
    consults: zod.number(),
    downgradedSteps: zod.number(),
    steps: zod.number(),
    streaks: zod.number(),
    keptStrong: zod.number(),
    routeFailed: zod.number(),
    judgeFailed: zod.number(),
    deadlineHits: zod.number(),
    warmUps: zod.number(),
    turnsWithDecisions: zod.number(),
  }),
  reasons: zod.array(zod.object({
    reason: zod.string(),
    group: zod.enum(['switched', 'judge-no', 'fail-closed', 'engine']),
    count: zod.number(),
  })),
  keptReasons: zod.array(zod.object({ reason: zod.string(), count: zod.number() })),
  exits: zod.array(zod.object({ brokenBy: zod.string(), count: zod.number() })),
  streakLengths: zod.object({ median: nullableNumber, max: nullableNumber }),
  confidence: zod.object({
    values: zod.array(zod.number()),
    margins: zod.array(zod.number()),
    max: nullableNumber,
    total: zod.number(),
  }),
  latency: zod.object({
    bucketsMs: zod.array(zod.number()),
    counts: zod.array(zod.number()),
    failed: zod.number(),
    p50: nullableNumber,
    p95: nullableNumber,
    includesFailed: zod.boolean(),
    withEligibility: zod.number(),
  }),
  judge: zod.object({ calls: zod.number(), promptTokens: zod.number(), outputTokens: zod.number() }),
  thresholds: zod.array(zod.object({
    downgradeThreshold: zod.number(),
    downgradeMargin: zod.number(),
    source: zod.enum(['operating-point', 'global']),
    calibratedBy: zod.string().nullable(),
    consults: zod.number(),
  })),
  models: zod.array(zod.object({
    provider: zod.string(),
    model: zod.string(),
    role: zod.enum(['strong', 'candidate', 'other']),
    colorSlot: zod.union([
      zod.literal('strong'), zod.literal(1), zod.literal(2), zod.literal(3), zod.literal(4), zod.literal(5), zod.literal('other'),
    ]),
    steps: zod.number(),
    calls: zod.number(),
    uncached: zod.number(),
    unreported: zod.number(),
    cacheRead: zod.number(),
    cacheWrite: zod.number(),
    output: zod.number(),
    reportedCalls: zod.number(),
  })),
  cold: zod.array(zod.object({
    cause: zod.enum(['routed-switch', 'routed-return', 'manual-switch', 'idle-expiry', 'session-start', 'post-compaction', 'other']),
    count: zod.number(),
    tokens: zod.number(),
  })),
  coldTtl: zod.object({ ms: zod.number(), fallback: zod.boolean() }),
  unreportedCallShare: nullableNumber,
  moved: zod.object({
    tokensOffStrong: zod.number(),
    returnReprefill: zod.number(),
    objective: zod.enum(['quota', 'dollars', 'latency', 'mixed']).nullable(),
  }),
  egress: zod.array(zod.object({
    engine: zod.string(),
    asks: zod.number(),
    chars: zod.number(),
    bound: zod.enum(['exact', 'at-most']),
  })),
  engines: zod.array(zod.object({ name: zod.string(), decisions: zod.number() })),
  timeline: zod.object({
    steps: zod.array(zod.object({
      turn: zod.number(),
      step: zod.number(),
      model: zod.number(),
      seq: zod.number(),
      t: zod.number(),
    })),
    marks: zod.array(zod.object({ i: zod.number(), kind: zod.enum(['down', 'return', 'manual', 'failed', 'idle']) })),
    decisions: zod.array(zod.object({
      seq: zod.number(),
      i: zod.number(),
      outcome: outcomeSchema,
      reason: zod.string(),
      best: nullableNumber,
      engine: nullableNumber,
    })),
    aggregated: zod.boolean(),
  }),
  recent: zod.array(zod.object({
    seq: zod.number(),
    t: zod.number(),
    turn: zod.number(),
    step: zod.number(),
    outcome: outcomeSchema,
    reason: zod.string(),
    best: nullableNumber,
    difficulty: nullableNumber,
    engine: zod.string().nullable(),
    latencyMs: nullableNumber,
  })),
}) as unknown as ZodType<ModelRoutingStatsSnapshot>
