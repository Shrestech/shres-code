/**
 * Observe-only accounting of a direct child's consumed turns and the route
 * in force for each. Live session first; otherwise one persistence inspect
 * under the same lifecycle witness list-children uses. No side effects.
 *
 * @module @shres-code/shres-code-subagent/child-outcomes
 */

import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { foldConsumedWork } from '@shres-code/shres-code-agent'
import type { SessionEvent, SessionHeader, SessionId, TurnEndReason } from '@shres-code/shres-code-session'
import { foldSubagentDescriptor } from './descriptor.ts'
import { SubagentRouteRequestId } from './types.ts'
import { sameLifecycle } from './list-children.ts'

/** One accounting turn from a child's log. */
export interface ChildTurnOutcome {
  /** The `turn/end` turn number. */
  readonly turn: number
  /** The recorded ending of that turn. */
  readonly reason: TurnEndReason
  /** Provider/model of the last `request/header` at a lower seq than that end, when any. */
  readonly route?: { readonly provider: string; readonly model: string }
}

/** Successful read of a direct child's accounting turns. */
export interface ChildTurnOutcomes {
  /** The child's descriptor `agentRouteRequestId`, when present. */
  readonly routeRequestId?: SubagentRouteRequestId
  /** Accounting turns in log order. */
  readonly turns: readonly ChildTurnOutcome[]
}

/** Why a child's turns cannot be observed. */
export type ChildTurnOutcomesUnavailable = 'missing' | 'corrupt' | 'no-persistence' | 'not-a-child'

/** Result of {@link childTurnOutcomes}. */
export type ChildTurnOutcomesResult =
  | ChildTurnOutcomes
  | { readonly unavailable: ChildTurnOutcomesUnavailable }

/**
 * Observe one direct child's accounting turns. Live session first; otherwise
 * one `persistence.inspect` under `sameLifecycle`. Direct children only.
 * Cancellation rejects with the signal's reason. Data damage returns
 * `unavailable` and never throws.
 * @param ctx - context carrying the session store and optional persistence.
 * @param parent - the exact live parent whose direct child is read.
 * @param childId - the durable child session id.
 * @param signal - caller cancellation; abort rejects rather than returning unavailable.
 * @returns accounting turns, or why they cannot be observed.
 */
export async function childTurnOutcomes(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  signal?: AbortSignal,
): Promise<ChildTurnOutcomesResult> {
  signal?.throwIfAborted()
  const live = ctx.sessions.get(childId)
  if (live !== undefined) {
    if (!isDirectChild(parent, live.header)) return { unavailable: 'not-a-child' }
    return foldChildTurns(live.events, signal)
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return { unavailable: 'no-persistence' }
  let inspected: { meta: SessionHeader; events: readonly SessionEvent[] }
  try {
    inspected = await persistence.inspect(childId, signal)
  } catch {
    signal?.throwIfAborted()
    return { unavailable: 'missing' }
  }
  signal?.throwIfAborted()
  if (!isDirectChild(parent, inspected.meta)) return { unavailable: 'not-a-child' }
  const liveWitness = ctx.sessions.get(childId)?.header
  if (liveWitness !== undefined && !sameLifecycle(inspected.meta, liveWitness)) {
    return { unavailable: 'corrupt' }
  }
  return foldChildTurns(inspected.events, signal)
}

/** Whether a header names `parent` as its durable direct parent and a subagent origin. */
function isDirectChild(parent: Agent, header: SessionHeader): boolean {
  return header.parentSession === parent.id && header.origin === 'subagent'
}

/**
 * When the child is live elsewhere in the store, use that header as the
 * lifecycle witness; a persistence row that no longer matches it is corrupt.
 */
/**
 * Fold accounting turns and the route in force for each.
 * A malformed descriptor is `corrupt`; cancellation rejects.
 */
/**
 * Fold accounting turns from one child log. Exported for unit coverage of turn kinds.
 * @param events - the child's session events in seq order.
 * @param signal - caller cancellation; abort rejects rather than returning unavailable.
 * @returns accounting turns, or `corrupt` when the descriptor cannot fold.
 */
export function foldChildTurns(events: readonly SessionEvent[], signal?: AbortSignal): ChildTurnOutcomesResult {
  signal?.throwIfAborted()
  let routeRequestId: SubagentRouteRequestId | undefined
  try {
    const descriptor = foldSubagentDescriptor(events)
    if (descriptor?.agentRouteRequestId !== undefined) {
      routeRequestId = SubagentRouteRequestId(descriptor.agentRouteRequestId)
    }
  } catch {
    return { unavailable: 'corrupt' }
  }
  const turns: ChildTurnOutcome[] = []
  for (const [index, event] of events.entries()) {
    if (event.type !== 'turn/end') continue
    const prefix = events.slice(0, index + 1)
    const accounted = foldConsumedWork(prefix)
    if (accounted.end?.seq !== event.seq) continue
    const route = routeInForce(events, event.seq)
    turns.push({
      turn: event.data.turn,
      reason: event.data.reason,
      ...route === undefined ? {} : { route },
    })
  }
  return {
    ...routeRequestId === undefined ? {} : { routeRequestId },
    turns,
  }
}

/** Last request/header at a strictly lower seq than `endSeq`. */
function routeInForce(
  events: readonly SessionEvent[],
  endSeq: number,
): { provider: string; model: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || event.seq >= endSeq) continue
    if (event.type !== 'request/header') continue
    const config = event.data.header.config
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
    return { provider: config.provider, model: config.model }
  }
  return undefined
}
