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
 * Several steps can be judged on the entering turn, all at elapsed turn 0.
 * The preceding loaded decision distinguishes continuation from entry. A
 * decision whose sticky state carries `brokenBy` ended a streak.
 * @param decision - the logged decision.
 * @param previous - the preceding routing decision in the loaded window, when present.
 * @returns the transition, or undefined when the decision neither entered nor ended a streak.
 */
export function trajectoryRoutingStreak(
  decision: ModelRoutingDecision,
  previous?: ModelRoutingDecision,
): TrajectoryRoutingStreak | undefined {
  const { sticky } = decision
  if (sticky.active) {
    if (previous?.sticky.active === true
      && previous.sticky.enteredTurn === sticky.enteredTurn
      && previous.selection?.candidateId === decision.selection?.candidateId
      && previous.selection?.provider === decision.selection?.provider
      && previous.selection?.model === decision.selection?.model) return undefined
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
 * @param previous - the preceding routing decision in the loaded window, when present.
 * @returns the row facts.
 */
export function trajectoryRoutingRow(decision: ModelRoutingDecision, previous?: ModelRoutingDecision): TrajectoryRoutingRow {
  const streak = trajectoryRoutingStreak(decision, previous)
  const quiet = decision.outcome === 'kept-strong' && streak?.kind !== 'exited'
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
 * The latest decision governing one request in the loaded window.
 * @param turn - the turn the consult judged.
 * @param step - the step that issued the request.
 * @param requestSeq - durable sequence that opened the request.
 * @param decisions - routing decisions in ascending seq order.
 * @returns the latest preceding or same-step decision, or undefined when the window holds none.
 */
function governingDecision(
  turn: number,
  step: number,
  requestSeq: number,
  decisions: readonly TrajectoryRoutingDecision[],
): TrajectoryRoutingDecision | undefined {
  let governing: TrajectoryRoutingDecision | undefined
  for (const decision of decisions) {
    if (
      decision.turn === turn
      && (decision.seq < requestSeq || decision.step === step)
      && (governing === undefined || decision.seq > governing.seq)
    ) {
      governing = decision
    }
  }
  return governing
}

/**
 * The effective route one request row reports.
 *
 * Each request uses the latest same-turn decision that either precedes its
 * durable request event or belongs to the request's step. The step match keeps
 * a decision after `step/start` associated with the request whose assembly
 * produced it, while a later step cannot retroactively badge an earlier
 * request. Routing never writes the session selection, so the streak's entry
 * base is the selection in force, and a request whose effective route differs
 * from it ran on the routed candidate.
 * @param turn - the turn that issued the request.
 * @param step - the step that issued the request.
 * @param requestSeq - durable sequence that opened the request.
 * @param provider - effective provider route the request ran on, when recorded.
 * @param model - effective model id the request ran on, when recorded.
 * @param decisions - routing decisions folded from the loaded window.
 * @returns the route facts, or undefined when the request named no route or its turn was never judged.
 */
export function trajectoryRequestRoute(
  turn: number,
  step: number,
  requestSeq: number,
  provider: string | undefined,
  model: string | undefined,
  decisions: readonly TrajectoryRoutingDecision[],
): TrajectoryRequestRoute | undefined {
  if (provider === undefined || model === undefined) return undefined
  const governing = governingDecision(turn, step, requestSeq, decisions)
  if (governing === undefined) return undefined
  const entryBase = governing.sticky.entryBase
  return {
    provider,
    model,
    routed: entryBase !== undefined && (entryBase.provider !== provider || entryBase.model !== model),
  }
}
