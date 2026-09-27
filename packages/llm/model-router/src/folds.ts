/**
 * Pure folds over the session log for model routing: the mode in force and the
 * sticky downgrade state. Nothing here keeps live memory — resume, fork, and
 * compaction restore both from the log alone, which is what lets a restart
 * continue a held streak and lets the bench replay a run.
 *
 * @module @shres-code/shres-code-model-router/folds
 */

import type { SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import type {
  ModelRoutingBreakReason,
  ModelRoutingColdPoint,
  ModelRoutingDecision,
  ModelRoutingEntryBaseView,
  ModelRoutingMode,
  ModelRoutingModeRecord,
  ModelRoutingReason,
  ModelRoutingSelection,
  ModelRoutingStickyView,
} from './types.ts'

/** The sticky downgrade state as of a fold point. */
export interface ModelRoutingStickyState {
  /** Whether a downgraded streak is in force. */
  readonly active: boolean
  /** Model steps logged since the streak was entered; 0 while strong. */
  readonly stepsElapsed: number
  /** Turn the streak was entered; absent while strong. */
  readonly enteredTurn?: number
  /** Step the streak was entered on; absent while strong or when the entering record omitted it. */
  readonly enteredStep?: number
  /** Allowlisted route the streak holds; absent while strong. */
  readonly candidate?: ModelRoutingSelection
  /**
   * Manual route in force when the streak was entered, or the manual route
   * being checked during a pending route-error recovery. Omitted otherwise.
   */
  readonly entryBase?: ModelRoutingEntryBaseView
  /** Why the streak ended, when the fold passed its end. */
  readonly brokenBy?: ModelRoutingBreakReason
  /** The recorded route-error threshold while a streak is active. */
  readonly routeErrorLimit?: number
  /** Whether the next matching strong turn must complete before routing resumes. */
  readonly needsStrongTurn?: true
  /** Turn whose matching manual request is the recovery proof. */
  readonly recoveryTurn?: number
  /** Turn of the last streak a quality exit ended; the re-entry cooldown counts from it. */
  readonly cooldownTurn?: number
  /**
   * Consecutive failed judgment calls since the last answered one, and the turn
   * of the latest; absent when none is counted.
   */
  readonly judgmentFailures?: ModelRoutingJudgmentFailures
}

/** Consecutive failed judgment calls as the fold counts them. */
export interface ModelRoutingJudgmentFailures {
  /** Failed judgment calls since the last answered one. */
  readonly count: number
  /** Turn of the latest failed judgment call. */
  readonly turn: number
  /**
   * Registry id of the engine the counted calls were routed to; absent when a
   * single-engine service answered or the log predates the field. A failure
   * routed to another engine starts a new count.
   */
  readonly engineId?: string
}

/** Decision reasons that record a judgment call that failed. */
const FAILED_JUDGMENT_REASONS: ReadonlySet<ModelRoutingReason> = new Set([
  'engine-unavailable', 'invalid-answer', 'judgment-error', 'judgment-failure-held',
])

/**
 * Streak ends that start the re-entry cooldown: the exits that say the
 * candidate could not carry the work, as opposed to a mode, manual, capability,
 * or horizon change.
 */
const COOLDOWN_BREAKS: ReadonlySet<ModelRoutingBreakReason> = new Set(['escalated', 'current-preferred', 'route-failed'])

/**
 * Serializable accumulator for the sticky-state fold.
 *
 * The projection stores this accumulator so its incremental drive and the
 * consult's full-log replay execute the same transition function. The header,
 * turn, and failure fields are fold inputs rather than UI output; they remain
 * here because a later decision can depend on them.
 */
export interface ModelRoutingStickyFoldState {
  /** Whether a downgraded streak is in force. */
  readonly active: boolean
  /** Turn the streak was entered; absent while strong. */
  readonly enteredTurn?: number
  /** Step the streak was entered on; absent while strong or when the entering record omitted it. */
  readonly enteredStep?: number
  /** `step/start` events logged since the streak was entered; 0 while strong. */
  readonly stepsElapsed: number
  /** Allowlisted route the streak holds; absent while strong. */
  readonly candidate?: ModelRoutingSelection
  /** Manual route in force when the streak was entered. */
  readonly entryBase?: ModelRoutingEntryBaseView
  /** Why the streak ended, when the fold passed its end. */
  readonly brokenBy?: ModelRoutingBreakReason
  /** Last request header used to derive a missing entry base. */
  readonly lastHeader?: ModelRoutingEntryBaseView
  /** Current turn number used when a decision omits its entered turn. */
  readonly currentTurn: number
  /** Consecutive durable route failures on the held route. */
  readonly routeFailures: number
  /** Recorded route-error threshold for the active streak. */
  readonly routeErrorLimit?: number
  /** Whether a route-error recovery turn is still pending. */
  readonly needsStrongTurn?: true
  /** Turn whose matching manual request is the recovery proof. */
  readonly recoveryTurn?: number
  /** Manual route recorded for the pending recovery. */
  readonly recoveryBase?: ModelRoutingEntryBaseView
  /** Whether the recovery turn's latest matching request header was seen. */
  readonly recoveryHeaderMatches?: boolean
  /**
   * Consecutive `route-failed` decisions for one candidate. It survives the
   * streak each failure ends, so repeated in-turn fallbacks reach the recorded
   * error limit; a completed turn on that candidate or a route-error break
   * clears it.
   */
  readonly candidateFailures?: { readonly candidate: ModelRoutingSelection; readonly count: number }
  /** Turn of the last streak a quality exit ended; the re-entry cooldown counts from it. */
  readonly cooldownTurn?: number
  /**
   * Consecutive failed judgment calls since the last answered one, and the turn
   * of the latest; absent when none is counted.
   */
  readonly judgmentFailures?: ModelRoutingJudgmentFailures
}

/** The manual route one cold-point evaluation reads: provider and model only. */
export interface ModelRoutingColdPointBase {
  /** Registered provider route of the manual model. */
  readonly provider: string
  /** Provider-owned model id of the manual model. */
  readonly model: string
}

/** A prompt-cache lifetime and where it came from. */
export interface ModelRoutingCacheTtl {
  /** Cache lifetime in milliseconds; `0` means the route keeps no cache. */
  readonly ttlMs: number
  /** `adapter` when the model's metadata declared it, `fallback` for `coldPoints.unknownTtlMs`. */
  readonly ttlSource: 'adapter' | 'fallback'
}

/**
 * Whether the event is a successful `compaction/end`. The compaction package
 * owns that event type and this package does not depend on it, so the type
 * name and the `error` field are read from the envelope.
 * @param event - one committed event.
 * @returns whether a compaction completed.
 */
export function isCompactionEnd(event: SessionEvent): boolean {
  const record = event as unknown as { type: string; data: { error?: unknown } }
  return record.type === 'compaction/end' && record.data.error === undefined
}

/**
 * The start time of the step a consult serves: the `time` of the log's latest
 * `step/start`, which the loop appends before it assembles the step's request.
 * @param events - the session log before the consult.
 * @returns epoch milliseconds, or `undefined` when no step has started.
 */
export function latestStepStart(events: readonly SessionEvent[]): number | undefined {
  return events.findLast(event => event.type === 'step/start')?.time
}

/**
 * Whether the durable manual base records the header at `end` as routed: the
 * latest `agent/route-base` at or before it whose `routed` route the header
 * runs, searched back past request headers that run the same route and no
 * further than the first header that runs another one. The event belongs to
 * the durable manual base, which this package does not depend on, so the
 * envelope is read without its type.
 * @param events - the session log.
 * @param end - index of the header the record would describe.
 * @param config - the header's call configuration.
 * @returns whether a record beneath the header exists.
 */
function routedBeneathRecorded(
  events: readonly SessionEvent[],
  end: number,
  config: { provider: string; model: string; reasoningEffort?: unknown },
): boolean {
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) return false
    const record = event as unknown as { type: string; data: unknown }
    if (record.type === 'agent/route-base') {
      const routed = (record.data as { routed?: { provider: string; model: string; reasoningEffort?: string } } | undefined)?.routed
      if (routed !== undefined && routed.provider === config.provider && routed.model === config.model
        && (routed.reasoningEffort === undefined || routed.reasoningEffort === config.reasoningEffort)) {
        return true
      }
    } else if (event.type === 'request/header') {
      const prior = event.data.header.config
      if (prior.provider !== config.provider || prior.model !== config.model
        || (config.reasoningEffort !== undefined && prior.reasoningEffort !== config.reasoningEffort)) {
        return false
      }
    }
  }
  return false
}

/** Whether two routes name the same provider and model; effort is not compared. */
function sameModel(a: ModelRoutingColdPointBase, b: ModelRoutingColdPointBase): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * Find the cold point of the manual route's prompt-cache prefix at one consult,
 * from log facts only. The first matching rule wins:
 * - `session-start`: the manual model never answered, and the session is not a
 *   fork seeded with its parent's prefix;
 * - `post-compaction`: a successful compaction followed its last answer;
 * - `manual-switch`: after that answer, an `agent/model-selection` or a
 *   request header that runs another provider/model without the durable
 *   manual base recording it beneath `agent/route-base` — and, for logs
 *   written before that record existed, without a live downgraded decision
 *   of its own turn rewriting it;
 * - `no-cache`: the lifetime is zero, so no prefix is kept;
 * - `idle`: `now` is more than the lifetime after the start of the step whose
 *   answer was that last one, which is where the cache lifetime counts from.
 * A seeded session whose manual model never answered is cold only when the
 * lifetime is zero.
 * @param events - the session log before the consult.
 * @param base - the manual route.
 * @param ttl - the manual model's cache lifetime and its source.
 * @param now - start time of the consulted step, in epoch milliseconds.
 * @param seeded - whether the session header records a fork seed.
 * @returns the cold point, or `undefined` when the prefix is warm.
 */
export function coldPointAt(
  events: readonly SessionEvent[],
  base: ModelRoutingColdPointBase,
  ttl: ModelRoutingCacheTtl,
  now: number,
  seeded: boolean,
): ModelRoutingColdPoint | undefined {
  const cache = { ttlMs: ttl.ttlMs, ttlSource: ttl.ttlSource }
  const last = events.findLastIndex(event => event.type === 'assistant/message' && sameModel(event.data.message.source, base))
  const answer = events[last]
  if (answer?.type !== 'assistant/message') {
    if (!seeded) return { kind: 'session-start', ...cache }
    return ttl.ttlMs === 0 ? { kind: 'no-cache', ...cache } : undefined
  }
  // The answer's own time bounds its step start when the log lacks that step.
  const started = events.findLast((event, index) => index < last && event.type === 'step/start'
    && event.data.turn === answer.data.turn && event.data.step === answer.data.step)?.time ?? answer.time
  const facts = { ...cache, idleMs: now - started, lastBaseSeq: answer.seq }
  let compactionSeq: number | undefined
  let switched = false
  let turnDecision: ModelRoutingDecision | undefined
  for (let index = last + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (isCompactionEnd(event)) compactionSeq = event.seq
    else if (event.type === 'turn/start') turnDecision = undefined
    else if (event.type === 'model-routing/decision') turnDecision = event.data
    else if (event.type === 'agent/model-selection') switched ||= !sameModel(event.data, base)
    else if (event.type === 'request/header') {
      // A header recorded in `agent/route-base` is routed, never a manual
      // switch, whatever the turn's decisions say. A header without a record
      // predates the record or was never routed: there, the turn's own live
      // downgraded decision - never a shadow one, which rewrites nothing -
      // tells a routed header from a manual choice.
      const routed = routedBeneathRecorded(events, index, event.data.header.config)
        || (turnDecision?.outcome === 'downgraded' && turnDecision.shadow !== true
          && turnDecision.selection !== undefined && sameModel(turnDecision.selection, event.data.header.config))
      switched ||= !routed && !sameModel(event.data.header.config, base)
    }
  }
  if (compactionSeq !== undefined) return { kind: 'post-compaction', ...facts, compactionSeq }
  if (switched) return { kind: 'manual-switch', ...facts }
  if (ttl.ttlMs === 0) return { kind: 'no-cache', ...facts }
  return facts.idleMs > ttl.ttlMs ? { kind: 'idle', ...facts } : undefined
}

/**
 * The mode one logged mode value names. An inactive record is off whatever else
 * it carries, so a record that marks shadow without `active` cannot switch
 * routing on; the invariant rejects such a record before it is published.
 * @param record - a `model-routing/mode` or `model-routing/configuration` value.
 * @returns `off` when inactive, `shadow` when marked shadow, and `on` otherwise.
 */
export function modeOfRecord(record: ModelRoutingModeRecord): ModelRoutingMode {
  if (!record.active) return 'off'
  return record.shadow === true ? 'shadow' : 'on'
}

/**
 * The value that records one mode in a `model-routing/mode` or
 * `model-routing/configuration` event.
 * @param mode - the mode to record.
 * @returns the logged value; `on` omits `shadow`, as logs from before shadow do.
 */
export function modeRecord(mode: ModelRoutingMode): ModelRoutingModeRecord {
  switch (mode) {
    case 'off':
      return { active: false }
    case 'on':
      return { active: true }
    case 'shadow':
      return { active: true, shadow: true }
  }
}

/**
 * The model routing mode after the first `end` events. The last user mode or
 * committed configuration event wins; a prefix with neither uses
 * `initialMode`.
 * @param events - the session log or any prefix of it.
 * @param end - fold `events[0, end)`; defaults to the whole log.
 * @param initialMode - mode in force before the first event; defaults to off.
 * @returns the mode in force.
 */
export function foldModelRouting(
  events: readonly SessionEvent[],
  end: number = events.length,
  initialMode: ModelRoutingMode = 'off',
): ModelRoutingMode {
  let mode = initialMode
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'model-routing/mode' || event.type === 'model-routing/configuration') mode = modeOfRecord(event.data)
  }
  return mode
}

/**
 * Whether one turn's end reason is a durable route failure.
 *
 * The loop records a failed turn as `turn/end { reason: { kind: 'error', error
 * } }` carrying the `LlmError` facts verbatim. A turn the caller cancelled or
 * aborted is not a route failure, and the flattened `UNKNOWN` class is not
 * attributable to the route.
 * @param reason - the turn's end reason.
 * @returns true when the turn failed on its route.
 */
function isRouteFailure(reason: TurnEndReason): boolean {
  if (reason.kind !== 'error') return false
  // Read through an unknown-typed view: a replayed log is a durable boundary,
  // so a stored failure may carry no code even though the live type requires
  // one, and such a failure is not attributable to a route.
  const code: unknown = (reason.error as { code?: unknown }).code
  return typeof code === 'string' && code !== 'ABORTED' && code !== 'UNKNOWN'
}

/**
 * Create the serializable empty sticky-fold accumulator.
 * @returns the accumulator for an empty log.
 */
export function createStickyFoldState(): ModelRoutingStickyFoldState {
  return { active: false, currentTurn: 0, stepsElapsed: 0, routeFailures: 0 }
}

/** Whether a stored route-error limit can govern a future failure. */
function isRouteErrorLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Assert the durable positive integer used to count route failures.
 * @param value - the value recorded by a routing decision.
 * @returns nothing when the value is valid.
 */
function assertRouteErrorLimit(value: unknown): asserts value is number {
  if (!isRouteErrorLimit(value)) {
    throw new Error('model-routing active sticky requires a positive safe-integer routeErrorLimit')
  }
}

/**
 * Assert the provider/model identity stored for a manual route.
 * @param value - the possible entry route.
 * @param label - the field path used in the diagnostic.
 * @returns nothing when the value is valid.
 */
function assertEntryBase(value: unknown, label: string): asserts value is ModelRoutingEntryBaseView {
  if (value === null || typeof value !== 'object') throw new Error(`${label} must be an object`)
  const record = value as Record<string, unknown>
  if (typeof record.provider !== 'string' || record.provider.length === 0
    || typeof record.model !== 'string' || record.model.length === 0
    || (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== 'string')) {
    throw new Error(`${label} must contain provider and model strings`)
  }
}

/** Validate all durable fields whose absence would make replay ambiguous. */
function validateStickyView(sticky: ModelRoutingStickyView): void {
  if (sticky.active) {
    assertRouteErrorLimit(sticky.routeErrorLimit)
    if (sticky.entryBase !== undefined) assertEntryBase(sticky.entryBase, 'active sticky entryBase')
    return
  }
  if (sticky.entryBase !== undefined) assertEntryBase(sticky.entryBase, 'inactive sticky entryBase')
  if (sticky.brokenBy === 'route-errors' && sticky.entryBase === undefined) {
    throw new Error('inactive route-errors sticky requires entryBase')
  }
}

/**
 * Compare two selections as route identities, including effort. The fold and
 * the consult share this comparison, so a decision that continues a streak and
 * the fold's transition test agree on what counts as a candidate change.
 * @param left - one selection, or `undefined` when no route is held.
 * @param right - the other selection, or `undefined`.
 * @returns true when both are absent or name the same candidate, route, and effort.
 */
export function sameSelection(
  left: ModelRoutingSelection | undefined,
  right: ModelRoutingSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.candidateId === right.candidateId
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/** Compare the provider/model identity used for recovery. */
function sameEntryBase(
  left: ModelRoutingEntryBaseView | undefined,
  right: ModelRoutingEntryBaseView | undefined,
): boolean {
  return left !== undefined && right !== undefined
    && left.provider === right.provider
    && left.model === right.model
}

/** Remove fields that only describe an active held route. */
function clearActiveFields(state: ModelRoutingStickyFoldState): ModelRoutingStickyFoldState {
  const {
    enteredTurn: _enteredTurn,
    enteredStep: _enteredStep,
    candidate: _candidate,
    entryBase: _entryBase,
    routeErrorLimit: _routeErrorLimit,
    ...retained
  } = state
  return { ...retained, active: false, stepsElapsed: 0, routeFailures: 0 }
}

/** Remove the pending manual recovery marker after its proof turn succeeds. */
function clearRecoveryFields(state: ModelRoutingStickyFoldState): ModelRoutingStickyFoldState {
  const {
    needsStrongTurn: _needsStrongTurn,
    recoveryTurn: _recoveryTurn,
    recoveryBase: _recoveryBase,
    recoveryHeaderMatches: _recoveryHeaderMatches,
    ...retained
  } = state
  return retained
}

/** End a held route for an ordinary decision while preserving pending recovery. */
function breakSticky(
  state: ModelRoutingStickyFoldState,
  brokenBy: ModelRoutingBreakReason,
): ModelRoutingStickyFoldState {
  return { ...clearActiveFields(state), brokenBy }
}

/**
 * Record the route-error break and retain the manual route for recovery.
 * @param state - the state whose held route reached its recorded limit.
 * @returns an inactive state requiring a matching strong turn.
 */
function breakForRouteErrors(state: ModelRoutingStickyFoldState): ModelRoutingStickyFoldState {
  const recoveryBase = state.entryBase ?? state.recoveryBase
  const {
    recoveryTurn: _recoveryTurn,
    recoveryHeaderMatches: _recoveryHeaderMatches,
    candidateFailures: _candidateFailures,
    ...withoutRecoveryTurn
  } = clearActiveFields(state)
  return {
    ...withoutRecoveryTurn,
    brokenBy: 'route-errors',
    needsStrongTurn: true,
    routeFailures: 0,
    ...recoveryBase === undefined ? {} : { recoveryBase },
  }
}

/**
 * Count one `route-failed` decision against the held candidate and end its
 * streak. Reaching the recorded error limit is a route-error break, which
 * requires a manual recovery turn exactly as terminal failures do.
 * @param state - the active accumulator whose held route failed.
 * @returns the broken state, or the route-error break at the limit.
 */
function failRoute(state: ModelRoutingStickyFoldState): ModelRoutingStickyFoldState {
  assertRouteErrorLimit(state.routeErrorLimit)
  const candidate = state.candidate
  if (candidate === undefined) return breakSticky(state, 'route-failed')
  const previous = state.candidateFailures
  const count = previous !== undefined && sameSelection(previous.candidate, candidate) ? previous.count + 1 : 1
  if (count >= state.routeErrorLimit) return breakForRouteErrors(state)
  return { ...breakSticky(state, 'route-failed'), candidateFailures: { candidate, count } }
}

/**
 * Start the recovery proof recorded by the forced `route-errors` decision.
 * @param state - the state before the durable forced decision.
 * @param entryBase - the manual route that decision recorded.
 * @returns an inactive state with a recovery turn at the current turn.
 */
function startRecovery(
  state: ModelRoutingStickyFoldState,
  entryBase: ModelRoutingEntryBaseView,
): ModelRoutingStickyFoldState {
  const cleared = clearActiveFields(state)
  return {
    ...cleared,
    brokenBy: 'route-errors',
    needsStrongTurn: true,
    recoveryTurn: state.currentTurn,
    recoveryBase: entryBase,
    recoveryHeaderMatches: sameEntryBase(state.lastHeader, entryBase),
  }
}

/**
 * Whether a successful recovery proof can consume the pending marker.
 * @param state - accumulator before the turn end.
 * @param event - the durable turn end.
 * @returns true for a matching completed or error turn.
 */
function isRecoveryProof(
  state: ModelRoutingStickyFoldState,
  event: Extract<SessionEvent, { type: 'turn/end' }>,
): boolean {
  return state.needsStrongTurn === true
    && state.recoveryTurn !== undefined
    && state.recoveryBase !== undefined
    && state.recoveryHeaderMatches === true
    && event.data.turn === state.recoveryTurn
    && (event.data.reason.kind === 'completed' || event.data.reason.kind === 'error')
}

/** Which decisions a sticky fold applies: the live route's, or the shadow simulation's. */
type FoldScope = 'live' | 'shadow'

/**
 * Advance the sticky accumulator by one durable event.
 *
 * This is intentionally the one transition function used by both the full-log
 * fold and the live session projection. Irrelevant events return the same
 * object reference so projection drives do not emit needless changes.
 * @param state - accumulator covering all prior events.
 * @param event - next committed session event.
 * @returns the accumulator after the event.
 */
export function advanceStickyFoldState(
  state: ModelRoutingStickyFoldState,
  event: SessionEvent,
): ModelRoutingStickyFoldState {
  return advanceFold(state, event, 'live')
}

/**
 * Advance the shadow simulation's sticky accumulator by one durable event: it
 * applies only decisions marked `shadow: true`, and only a mode still in
 * shadow keeps its simulated streak, so a switch to on or off ends it exactly
 * as the live fold's switch ends a live streak.
 * @param state - accumulator covering all prior events.
 * @param event - next committed session event.
 * @returns the accumulator after the event.
 */
export function advanceShadowStickyFoldState(
  state: ModelRoutingStickyFoldState,
  event: SessionEvent,
): ModelRoutingStickyFoldState {
  return advanceFold(state, event, 'shadow')
}

/**
 * The one transition behind both folds, scoped to the decisions it applies.
 * @param state - accumulator covering all prior events.
 * @param event - next committed session event.
 * @param scope - which decisions the fold applies.
 * @returns the accumulator after the event.
 */
function advanceFold(
  state: ModelRoutingStickyFoldState,
  event: SessionEvent,
  scope: FoldScope,
): ModelRoutingStickyFoldState {
  switch (event.type) {
    case 'step/start':
      // Only a held streak counts steps: the entering decision follows its own
      // step's start, so the entering step is step 0 of the streak.
      return state.active ? { ...state, stepsElapsed: state.stepsElapsed + 1 } : state
    case 'turn/start': {
      if (state.currentTurn === event.data.turn) return state
      if (state.needsStrongTurn !== true) return { ...state, currentTurn: event.data.turn }
      const { recoveryHeaderMatches: _recoveryHeaderMatches, ...withoutMatch } = state
      return { ...withoutMatch, currentTurn: event.data.turn }
    }
    case 'request/header': {
      const config = event.data.header.config
      const lastHeader: ModelRoutingEntryBaseView = {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) },
      }
      if (state.needsStrongTurn !== true || state.recoveryTurn === undefined || state.recoveryBase === undefined) {
        return { ...state, lastHeader }
      }
      return {
        ...state,
        lastHeader,
        recoveryHeaderMatches: state.currentTurn === state.recoveryTurn
          && sameEntryBase(lastHeader, state.recoveryBase),
      }
    }
    case 'turn/end': {
      let next = state
      if (state.active) {
        assertRouteErrorLimit(state.routeErrorLimit)
        const routeFailures = isRouteFailure(event.data.reason) ? state.routeFailures + 1 : 0
        if (routeFailures >= state.routeErrorLimit) next = breakForRouteErrors(state)
        else if (state.routeFailures !== routeFailures) next = { ...state, routeFailures }
        // A completed turn on the candidate ends its run of in-turn fallbacks.
        if (event.data.reason.kind === 'completed' && state.candidateFailures !== undefined
          && sameSelection(state.candidateFailures.candidate, state.candidate)) {
          const { candidateFailures: _candidateFailures, ...recovered } = next
          next = recovered
        }
      }
      return isRecoveryProof(next, event) ? clearRecoveryFields(next) : next
    }
    case 'model-routing/mode':
    case 'model-routing/configuration':
      // The live fold keeps a streak only under `on`: off stops routing, and
      // shadow never rewrites a request. The shadow fold keeps one only while
      // judging continues, so any other mode ends the simulation the same way.
      if (modeOfRecord(event.data) === (scope === 'shadow' ? 'shadow' : 'on')) return state
      return state.active ? breakSticky(state, 'mode-off') : state
    case 'model-routing/decision': {
      // Each fold skips the other's decisions, so a shadow streak simulates
      // holds, cooldowns, and exits without ever moving the live route.
      if ((event.data.shadow === true) !== (scope === 'shadow')) return state
      const sticky = event.data.sticky
      validateStickyView(sticky)
      return applyDecision(countJudgment(state, event.data), event.data)
    }
    default:
      return state
  }
}

/**
 * Count a failed judgment call, or clear the count after an answered one.
 * Decisions that made no judgment call leave the count alone.
 * @param state - the accumulator before the decision.
 * @param decision - the logged decision.
 * @returns the accumulator with the judgment-failure count applied.
 */
function countJudgment(state: ModelRoutingStickyFoldState, decision: ModelRoutingDecision): ModelRoutingStickyFoldState {
  // An engine that is still becoming ready has not failed.
  if (FAILED_JUDGMENT_REASONS.has(decision.reason) && decision.engineFailure?.engineState === undefined) {
    const previous = judgmentFailuresFor(state.judgmentFailures, decision.engineId)
    const engineId = decision.engineId ?? previous?.engineId
    return {
      ...state,
      judgmentFailures: {
        count: (previous?.count ?? 0) + 1,
        turn: state.currentTurn,
        ...engineId === undefined ? {} : { engineId },
      },
    }
  }
  if (decision.route === undefined || state.judgmentFailures === undefined) return state
  const { judgmentFailures: _failures, ...answered } = state
  return answered
}

/**
 * The counted judgment failures that apply to one engine. Failures routed to
 * another engine do not count against it, so a switch starts from none; a
 * count or an engine without an id matches any.
 * @param failures - the fold's counted failures.
 * @param engineId - the engine about to be asked or that just failed.
 * @returns the failures that apply, or undefined.
 */
export function judgmentFailuresFor(
  failures: ModelRoutingJudgmentFailures | undefined,
  engineId: string | undefined,
): ModelRoutingJudgmentFailures | undefined {
  if (failures === undefined || engineId === undefined || failures.engineId === undefined) return failures
  return failures.engineId === engineId ? failures : undefined
}

/**
 * Apply one decision's sticky transition.
 * @param state - the accumulator before the decision's transition.
 * @param decision - the logged decision.
 * @returns the accumulator after the decision.
 */
function applyDecision(state: ModelRoutingStickyFoldState, decision: ModelRoutingDecision): ModelRoutingStickyFoldState {
  const sticky = decision.sticky
  if (sticky.active) {
    const candidate = decision.selection ?? state.candidate
    const entering = !state.active
    const restarted = entering || !sameSelection(state.candidate, candidate)
    const entryBase = entering ? sticky.entryBase ?? state.lastHeader : state.entryBase
    const enteredStep = sticky.enteredStep ?? (restarted ? undefined : state.enteredStep)
    const { brokenBy: _previousBreak, cooldownTurn: _cooldown, enteredStep: _previousStep, ...withoutBreak } = state
    return {
      ...withoutBreak,
      active: true,
      enteredTurn: sticky.enteredTurn ?? state.enteredTurn ?? state.currentTurn,
      ...enteredStep === undefined ? {} : { enteredStep },
      stepsElapsed: restarted ? 0 : state.stepsElapsed,
      ...candidate === undefined ? {} : { candidate },
      ...entryBase === undefined ? {} : { entryBase },
      routeErrorLimit: sticky.routeErrorLimit,
      routeFailures: restarted ? 0 : state.routeFailures,
    }
  }
  const ended = endStreak(state, sticky)
  return state.active && sticky.brokenBy !== undefined && COOLDOWN_BREAKS.has(sticky.brokenBy)
    ? { ...ended, cooldownTurn: state.currentTurn }
    : ended
}

/**
 * Apply one inactive decision: a recorded route failure, a route-error
 * recovery, an ordinary break, or a strong decision that leaves any held
 * route.
 * @param state - the accumulator before the decision.
 * @param sticky - the decision's inactive sticky facts.
 * @returns the accumulator after the decision.
 */
function endStreak(
  state: ModelRoutingStickyFoldState,
  sticky: Extract<ModelRoutingStickyView, { active: false }>,
): ModelRoutingStickyFoldState {
  if (sticky.brokenBy === 'route-failed') return state.active ? failRoute(state) : state
  const recoveryBase = sticky.brokenBy === 'route-errors'
    ? sticky.entryBase
    : undefined
  if (recoveryBase !== undefined) return startRecovery(state, recoveryBase)
  return state.active && sticky.brokenBy !== undefined
    ? breakSticky(state, sticky.brokenBy)
    : state.active ? clearActiveFields(state) : state
}

/**
 * Read the public sticky state from an accumulator.
 * @param state - the accumulator to render.
 * @returns the public sticky state.
 */
export function readStickyFoldState(state: ModelRoutingStickyFoldState): ModelRoutingStickyState {
  return {
    active: state.active,
    stepsElapsed: state.active ? state.stepsElapsed : 0,
    ...state.active && state.enteredTurn !== undefined ? { enteredTurn: state.enteredTurn } : {},
    ...state.active && state.enteredStep !== undefined ? { enteredStep: state.enteredStep } : {},
    ...state.active && state.candidate !== undefined ? { candidate: state.candidate } : {},
    ...state.active && state.entryBase !== undefined ? { entryBase: state.entryBase } : {},
    ...!state.active && state.recoveryBase !== undefined ? { entryBase: state.recoveryBase } : {},
    ...state.active && state.routeErrorLimit !== undefined ? { routeErrorLimit: state.routeErrorLimit } : {},
    ...state.brokenBy === undefined ? {} : { brokenBy: state.brokenBy },
    ...state.needsStrongTurn === true ? { needsStrongTurn: true } : {},
    ...state.recoveryTurn === undefined ? {} : { recoveryTurn: state.recoveryTurn },
    ...state.cooldownTurn === undefined ? {} : { cooldownTurn: state.cooldownTurn },
    ...state.judgmentFailures === undefined ? {} : { judgmentFailures: state.judgmentFailures },
  }
}

/**
 * Fold the sticky downgrade state as of `end`.
 *
 * The state is a pure function of the log: `model-routing/decision` records
 * every transition, `model-routing/mode` records the off-switch, `turn/start`
 * numbers the turns, `step/start` counts the steps the horizon is measured in, and `request/header` supplies
 * the manual route a streak was entered on. Decisions are replayed rather than
 * re-derived, so a streak a restart or a fork inherits continues exactly as
 * the live consult left it.
 * @param events - the session log or any prefix of it.
 * @param end - fold `events[0, end)`; defaults to the whole log.
 * @returns the sticky state at that point.
 */
export function stickyState(
  events: readonly SessionEvent[],
  end: number = events.length,
): ModelRoutingStickyState {
  let state = createStickyFoldState()
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    state = advanceStickyFoldState(state, event)
  }
  return readStickyFoldState(state)
}

/**
 * Fold the sticky state a shadow consult continues from: the same fold as
 * {@link stickyState} over the decisions marked `shadow: true` only. Holds,
 * cooldowns, and exits in the simulation never move the live route, and a mode
 * that leaves shadow ends the simulated streak.
 * @param events - the session log or any prefix of it.
 * @param end - fold `events[0, end)`; defaults to the whole log.
 * @returns the simulated sticky state at that point.
 */
export function shadowStickyState(
  events: readonly SessionEvent[],
  end: number = events.length,
): ModelRoutingStickyState {
  let state = createStickyFoldState()
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    state = advanceShadowStickyFoldState(state, event)
  }
  return readStickyFoldState(state)
}
