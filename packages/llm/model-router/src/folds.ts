/**
 * Pure folds over the session log for model routing: the mode in force and the
 * sticky downgrade state. Nothing here keeps live memory — resume, fork, and
 * compaction restore both from the log alone, which is what lets a restart
 * continue a held streak and lets the bench replay a run.
 *
 * @module @shres-code/shres-code-model-router/folds
 */

import type { SessionEvent, TurnEndReason } from '@shres-code/shres-code-session'
import type { ResolvedModelRouterConfig } from './config.ts'
import type { ModelRoutingBreakReason, ModelRoutingEntryBaseView, ModelRoutingSelection } from './types.ts'

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
   * Manual provider/model in force when the streak was entered, read from the
   * last `request/header` before the entering decision. Absent while strong.
   * This is the route a manual switch is compared against, and only its
   * provider/model fields count — an unrelated header change (a plan-mode
   * toggle rewriting `header.system`) must not end a streak.
   */
  readonly entryBase?: ModelRoutingEntryBaseView
  /** Why the streak ended, when the fold passed its end. */
  readonly brokenBy?: ModelRoutingBreakReason
}

/**
 * Whether model routing is active after the first `end` events. The last
 * `model-routing/mode` wins; a prefix with none is `initialMode`.
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
    if (event.type === 'model-routing/mode') active = event.data.active
  }
  return active
}

/**
 * Whether one turn's end reason is a durable route failure.
 *
 * The loop records a failed turn as `turn/end { reason: { kind: 'error', error } }`
 * carrying the `LlmError` facts verbatim, so a provider-side class is
 * recoverable from the log. A turn the caller cancelled or aborted is not a
 * route failure, and the flattened `UNKNOWN` class is not attributable to the
 * route. This is the only carrier the trigger counts, and the three others are
 * excluded deliberately: a `llm/retry` event records an attempt the recovery
 * layer scheduled to retry (a retry that succeeds is not a failed turn), the
 * terminal error `assistant/chunk` finish chunk is prunable history, and an
 * `aborted` turn records no failure at all. The classes that therefore degrade
 * the trigger — a failure a listener absorbs without scheduling a retry, an
 * `UNKNOWN`-flattened throw, a crash-orphaned `interrupted` turn, and
 * auxiliary calls that never log a failure — are listed in the package README.
 * @param reason - the turn's end reason.
 * @returns true when the turn failed on its route.
 */
function isRouteFailure(reason: TurnEndReason): boolean {
  if (reason.kind !== 'error') return false
  // Read through an unknown-typed view: a replayed log is a durable boundary,
  // so a stored failure may carry no code at all even though the live type
  // requires one, and such a failure is not attributable to a route.
  const code: unknown = (reason.error as { code?: unknown }).code
  return typeof code === 'string' && code !== 'ABORTED' && code !== 'UNKNOWN'
}

/**
 * Fold the sticky downgrade state as of `end`.
 *
 * The state is a pure function of the log: `model-routing/decision` records
 * every transition, `model-routing/mode` records the off-switch, `turn/start`
 * numbers the turns the horizon is measured in, and `request/header` supplies
 * the manual route a streak was entered on. Decisions are replayed rather than
 * re-derived, so a streak a restart or a fork inherits continues exactly as the
 * live consult left it.
 * @param events - the session log or any prefix of it.
 * @param config - resolved router configuration (horizon and error streak).
 * @param end - fold `events[0, end)`; defaults to the whole log.
 * @returns the sticky state at that point.
 */
export function stickyState(
  events: readonly SessionEvent[],
  config: ResolvedModelRouterConfig,
  end: number = events.length,
): ModelRoutingStickyState {
  let active = false
  let enteredTurn: number | undefined
  let candidate: ModelRoutingSelection | undefined
  let entryBase: ModelRoutingEntryBaseView | undefined
  let brokenBy: ModelRoutingBreakReason | undefined
  let lastHeader: ModelRoutingEntryBaseView | undefined
  let currentTurn = 0
  let routeFailures = 0
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    switch (event.type) {
      case 'turn/start':
        currentTurn = event.data.turn
        break
      case 'request/header':
        lastHeader = { provider: event.data.header.config.provider, model: event.data.header.config.model }
        break
      case 'turn/end':
        routeFailures = isRouteFailure(event.data.reason)
          ? routeFailures + 1
          : 0
        if (active && routeFailures >= config.maxRouteErrors) {
          active = false
          candidate = undefined
          entryBase = undefined
          enteredTurn = undefined
          brokenBy = 'route-errors'
        }
        break
      case 'model-routing/mode':
        if (!event.data.active && active) {
          active = false
          candidate = undefined
          entryBase = undefined
          enteredTurn = undefined
          brokenBy = 'mode-off'
        }
        break
      case 'model-routing/decision': {
        const sticky = event.data.sticky
        if (sticky.active) {
          if (!active) {
            // The record is authoritative where it exists: it is the only base a
            // streak entered on the first turn (no preceding header) can carry.
            entryBase = sticky.entryBase ?? lastHeader
            enteredTurn = sticky.enteredTurn ?? currentTurn
          }
          active = true
          candidate = event.data.selection ?? candidate
          brokenBy = undefined
        } else {
          if (active && sticky.brokenBy !== undefined) brokenBy = sticky.brokenBy
          active = false
          candidate = undefined
          entryBase = undefined
          enteredTurn = undefined
        }
        break
      }
      default:
        break
    }
  }
  // Entering a streak always records a turn number, so an active state always
  // has one to difference against; a state with none is not active.
  const turnsElapsed = active && enteredTurn !== undefined ? Math.max(0, currentTurn - enteredTurn) : 0
  return {
    active,
    turnsElapsed,
    ...active && enteredTurn !== undefined ? { enteredTurn } : {},
    ...active && candidate !== undefined ? { candidate } : {},
    ...active && entryBase !== undefined ? { entryBase } : {},
    ...brokenBy === undefined ? {} : { brokenBy },
  }
}
