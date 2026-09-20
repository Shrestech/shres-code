/**
 * Model-routing facts the Trajectory ledger renders: the row one logged
 * `model-routing/decision` becomes, the streak transition it caused, and the
 * effective route each request row of a judged turn reports.
 *
 * Every fact is derived from the decision the router logged, so nothing here
 * holds routing state and a replayed session renders the same rows.
 */

import type { ModelRoutingDecision } from '@shres-code/shres-code-model-router/client'
import type { TrajectoryRoutingDecision } from './trajectory-contract.ts'
import type { TrajectoryRequestRoute, TrajectoryRoutingRow, TrajectoryRoutingStreak } from './trajectory-record.ts'

/**
 * The streak transition one decision caused.
 *
 * A decision logged on the streak's entering turn reads elapsed turn 0, and
 * the consult logs at most one decision per turn, so only an entering decision
 * reads zero. A decision whose sticky state carries `brokenBy` ended a streak.
 * @param decision - the logged decision.
 * @returns the transition, or undefined when the decision neither entered nor ended a streak.
 */
export function trajectoryRoutingStreak(
  decision: ModelRoutingDecision,
): TrajectoryRoutingStreak | undefined {
  const { sticky } = decision
  if (sticky.active) {
    return sticky.turnsElapsed === 0 && sticky.enteredTurn !== undefined
      ? { kind: 'entered', turn: sticky.enteredTurn }
      : undefined
  }
  return sticky.brokenBy === undefined ? undefined : { kind: 'exited', reason: sticky.brokenBy }
}

/**
 * Project one logged decision into the row the ledger paints.
 *
 * A kept-strong decision that ended no streak changed nothing: it carries the
 * quiet marker, and the row drops the route, confidence, and streak facts its
 * judgment answered with.
 * @param decision - the logged decision.
 * @returns the row facts.
 */
export function trajectoryRoutingRow(decision: ModelRoutingDecision): TrajectoryRoutingRow {
  const streak = trajectoryRoutingStreak(decision)
  const quiet = decision.outcome === 'kept-strong' && decision.sticky.brokenBy === undefined
  return {
    outcome: decision.outcome,
    reason: decision.reason,
    ...(quiet || decision.route === undefined ? {} : { confidence: decision.route.confidence }),
    ...(quiet || decision.selection === undefined
      ? {}
      : {
        selection: {
          candidateId: decision.selection.candidateId,
          provider: decision.selection.provider,
          model: decision.selection.model,
          ...(decision.selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: decision.selection.reasoningEffort }),
        },
      }),
    ...(quiet || streak === undefined ? {} : { streak }),
    quiet,
  }
}

/**
 * The last decision the loaded window logged for one turn.
 * @param turn - the turn the consult judged.
 * @param decisions - routing decisions in ascending seq order.
 * @returns the turn's latest decision, or undefined when the window holds none.
 */
function governingDecision(
  turn: number,
  decisions: readonly TrajectoryRoutingDecision[],
): TrajectoryRoutingDecision | undefined {
  let governing: TrajectoryRoutingDecision | undefined
  for (const decision of decisions) {
    if (decision.turn === turn) governing = decision
  }
  return governing
}

/**
 * The effective route one request row reports.
 *
 * The consult logs at most one decision per turn and the turn's later steps
 * reuse it, so the last decision logged for the turn governs every request the
 * turn issued. Routing never writes the session selection, so the streak's
 * entry base is the selection in force, and a request whose effective route
 * differs from it ran on the routed candidate.
 * @param turn - the turn that issued the request.
 * @param provider - effective provider route the request ran on, when recorded.
 * @param model - effective model id the request ran on, when recorded.
 * @param decisions - routing decisions folded from the loaded window.
 * @returns the route facts, or undefined when the request named no route or its turn was never judged.
 */
export function trajectoryRequestRoute(
  turn: number,
  provider: string | undefined,
  model: string | undefined,
  decisions: readonly TrajectoryRoutingDecision[],
): TrajectoryRequestRoute | undefined {
  if (provider === undefined || model === undefined) return undefined
  const governing = governingDecision(turn, decisions)
  if (governing === undefined) return undefined
  const entryBase = governing.sticky.entryBase
  return {
    provider,
    model,
    routed: entryBase !== undefined && (entryBase.provider !== provider || entryBase.model !== model),
  }
}
