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
  ModelRoutingEntryBaseView,
  ModelRoutingSelection,
  ModelRoutingStickyView,
} from './types.ts'

/** The sticky downgrade state as of a fold point. */
export interface ModelRoutingStickyState {
  /** Whether a downgraded streak is in force. */
  readonly active: boolean
  /** Turns elapsed since the streak was entered; 0 while strong. */
  readonly turnsElapsed: number
  /** Turn the streak was entered; absent while strong. */
  readonly enteredTurn?: number
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
}

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
}

/**
 * Whether model routing is active after the first `end` events. The last
 * user mode or committed configuration event wins; a prefix with neither
 * uses `initialMode`.
 * @param events - the session log or any prefix of it.
 * @param end - fold `events[0, end)`; defaults to the whole log.
 * @param initialMode - mode in force before the first event; defaults to off.
 * @returns whether routing is active.
 */
export function foldModelRouting(
  events: readonly SessionEvent[],
  end: number = events.length,
  initialMode: boolean = false,
): boolean {
  let active = initialMode
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'model-routing/mode' || event.type === 'model-routing/configuration') active = event.data.active
  }
  return active
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
  return { active: false, currentTurn: 0, routeFailures: 0 }
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
    candidate: _candidate,
    entryBase: _entryBase,
    routeErrorLimit: _routeErrorLimit,
    ...retained
  } = state
  return { ...retained, active: false, routeFailures: 0 }
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
  switch (event.type) {
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
      if (event.data.active) return state
      return state.active ? breakSticky(state, 'mode-off') : state
    case 'model-routing/decision': {
      const sticky = event.data.sticky
      validateStickyView(sticky)
      if (!sticky.active && sticky.brokenBy === 'route-failed') return state.active ? failRoute(state) : state
      if (sticky.active) {
        const candidate = event.data.selection ?? state.candidate
        const entering = !state.active
        const transitioned = state.active && !sameSelection(state.candidate, candidate)
        const entryBase = entering ? sticky.entryBase ?? state.lastHeader : state.entryBase
        const { brokenBy: _previousBreak, ...withoutBreak } = state
        return {
          ...withoutBreak,
          active: true,
          enteredTurn: sticky.enteredTurn ?? state.enteredTurn ?? state.currentTurn,
          ...candidate === undefined ? {} : { candidate },
          ...entryBase === undefined ? {} : { entryBase },
          routeErrorLimit: sticky.routeErrorLimit,
          routeFailures: entering || transitioned ? 0 : state.routeFailures,
        }
      }
      const recoveryBase = sticky.brokenBy === 'route-errors'
        ? sticky.entryBase
        : undefined
      if (recoveryBase !== undefined) return startRecovery(state, recoveryBase)
      return state.active && sticky.brokenBy !== undefined
        ? breakSticky(state, sticky.brokenBy)
        : state.active ? clearActiveFields(state) : state
    }
    default:
      return state
  }
}

/**
 * Read the public sticky state from an accumulator.
 * @param state - the accumulator to render.
 * @returns the public sticky state.
 */
export function readStickyFoldState(state: ModelRoutingStickyFoldState): ModelRoutingStickyState {
  const turnsElapsed = state.active && state.enteredTurn !== undefined
    ? Math.max(0, state.currentTurn - state.enteredTurn)
    : 0
  return {
    active: state.active,
    turnsElapsed,
    ...state.active && state.enteredTurn !== undefined ? { enteredTurn: state.enteredTurn } : {},
    ...state.active && state.candidate !== undefined ? { candidate: state.candidate } : {},
    ...state.active && state.entryBase !== undefined ? { entryBase: state.entryBase } : {},
    ...!state.active && state.recoveryBase !== undefined ? { entryBase: state.recoveryBase } : {},
    ...state.active && state.routeErrorLimit !== undefined ? { routeErrorLimit: state.routeErrorLimit } : {},
    ...state.brokenBy === undefined ? {} : { brokenBy: state.brokenBy },
    ...state.needsStrongTurn === true ? { needsStrongTurn: true } : {},
    ...state.recoveryTurn === undefined ? {} : { recoveryTurn: state.recoveryTurn },
  }
}

/**
 * Fold the sticky downgrade state as of `end`.
 *
 * The state is a pure function of the log: `model-routing/decision` records
 * every transition, `model-routing/mode` records the off-switch, `turn/start`
 * numbers the turns the horizon is measured in, and `request/header` supplies
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
