/**
 * Classify routed-child accounting turns and fold the per-candidate breaker.
 * Reads only parent-log events plus childTurnOutcomes results — never the
 * child's filesystem.
 *
 * @module @shres-code/shres-code-model-router/child-outcomes
 */

import type { SessionEvent } from '@shres-code/shres-code-session'
import type { ChildTurnOutcome, ChildTurnOutcomesResult } from '@shres-code/shres-code-subagent'
import type {
  ModelRoutingChildCountedAs,
  ModelRoutingChildDecision,
  ModelRoutingChildOutcome,
  ModelRoutingModeRecord,
} from './types.ts'

/** Selection recorded on a routed child-decision. */
export interface ChildRouteSelection {
  readonly candidateId: string
  readonly provider: string
  readonly model: string
}

/**
 * Classify one accounting turn against the decision's selection.
 * Failure requires an LlmError code other than UNKNOWN on the selected route.
 * Neutral never counts and never resets.
 * @param turn - one childTurnOutcomes accounting turn.
 * @param selection - the routed decision's pool selection.
 * @returns countedAs plus optional failureCode.
 */
export function classifyChildTurn(
  turn: ChildTurnOutcome,
  selection: ChildRouteSelection,
): { readonly countedAs: ModelRoutingChildCountedAs; readonly failureCode?: string } {
  const onSelection = turn.route !== undefined
    && turn.route.provider === selection.provider
    && turn.route.model === selection.model
  if (turn.reason.kind === 'completed' && onSelection) return { countedAs: 'success' }
  if (turn.reason.kind === 'error') {
    const code = turn.reason.error.code
    if (code !== 'UNKNOWN' && onSelection) return { countedAs: 'failure', failureCode: code }
  }
  return { countedAs: 'neutral' }
}

/** Dedup key for one accounting turn of one dispatch. */
export function outcomeKey(routeRequestId: string, childTurn: number): string {
  return `${routeRequestId}:${String(childTurn)}`
}

/**
 * Outcomes already recorded for one parent log, keyed by routeRequestId/childTurn.
 * @param events - the parent session events.
 */
export function recordedChildOutcomes(
  events: readonly SessionEvent[],
): Map<string, ModelRoutingChildOutcome> {
  const recorded = new Map<string, ModelRoutingChildOutcome>()
  for (const event of events) {
    if (event.type !== 'model-routing/child-outcome') continue
    recorded.set(outcomeKey(event.data.routeRequestId, event.data.childTurn), event.data)
  }
  return recorded
}

/**
 * Routed child-decisions in the parent log, in seq order.
 * @param events - the parent session events.
 */
export function routedChildDecisions(
  events: readonly SessionEvent[],
): { readonly seq: number; readonly decision: ModelRoutingChildDecision }[] {
  const rows: { readonly seq: number; readonly decision: ModelRoutingChildDecision }[] = []
  for (const event of events) {
    if (event.type !== 'model-routing/child-decision') continue
    if (event.data.outcome !== 'routed' || event.data.selection === undefined) continue
    rows.push({ seq: event.seq, decision: event.data })
  }
  return rows
}

/**
 * Build missing outcomes from a childTurnOutcomes read. Skips turns already
 * recorded and skips unreadable or mismatched descriptors.
 * @param decision - the routed parent decision.
 * @param childSessionId - the durable child id.
 * @param result - live-first runtime read.
 * @param recorded - existing outcomes by key.
 * @param runId - live Activation run id, when known.
 * @param reconciled - mark post-restart appends.
 */
export function outcomesFromChildTurns(
  decision: ModelRoutingChildDecision,
  childSessionId: string,
  result: ChildTurnOutcomesResult,
  recorded: ReadonlyMap<string, ModelRoutingChildOutcome>,
  runId?: string,
  reconciled?: true,
): ModelRoutingChildOutcome[] {
  if ('unavailable' in result) return []
  if (decision.selection === undefined) return []
  if (result.routeRequestId !== decision.routeRequestId) return []
  const appended: ModelRoutingChildOutcome[] = []
  for (const turn of result.turns) {
    const key = outcomeKey(decision.routeRequestId, turn.turn)
    if (recorded.has(key)) continue
    if (turn.route === undefined) continue
    const classified = classifyChildTurn(turn, decision.selection)
    appended.push({
      routeRequestId: decision.routeRequestId,
      candidateId: decision.selection.candidateId,
      childSessionId,
      childTurn: turn.turn,
      route: turn.route,
      turnEnd: turn.reason.kind,
      ...classified.failureCode === undefined ? {} : { failureCode: classified.failureCode },
      countedAs: classified.countedAs,
      ...runId === undefined ? {} : { runId },
      ...reconciled === undefined ? {} : { reconciled: true },
    })
  }
  return appended
}

/**
 * Consecutive failure counts per candidateId. Neutral is skipped. Success,
 * off-to-on, and a newly seen pool candidate reset that candidate.
 * @param events - the parent session events.
 * @param childRouteErrors - consecutive failures that suspend a candidate.
 * @returns candidate ids at or above the limit.
 */
export function suspendedChildCandidates(
  events: readonly SessionEvent[],
  childRouteErrors: number,
): Set<string> {
  const counts = new Map<string, number>()
  const seenPool = new Set<string>()
  for (const event of events) {
    if (event.type === 'model-routing/configuration' || event.type === 'model-routing/mode') {
      const record = event.data as ModelRoutingModeRecord
      if (record.active === true) counts.clear()
      continue
    }
    if (event.type === 'model-routing/child-decision' && event.data.selection !== undefined) {
      const id = event.data.selection.candidateId
      if (!seenPool.has(id)) {
        seenPool.add(id)
        counts.delete(id)
      }
      continue
    }
    if (event.type !== 'model-routing/child-outcome') continue
    const outcome = event.data
    if (outcome.countedAs === 'neutral') continue
    if (outcome.countedAs === 'success') {
      counts.set(outcome.candidateId, 0)
      continue
    }
    counts.set(outcome.candidateId, (counts.get(outcome.candidateId) ?? 0) + 1)
  }
  const suspended = new Set<string>()
  for (const [id, count] of counts) {
    if (count >= childRouteErrors) suspended.add(id)
  }
  return suspended
}
