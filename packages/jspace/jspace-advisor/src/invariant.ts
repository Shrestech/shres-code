/**
 * Package-owned invariant companion for `@shres-code/shres-code-jspace-advisor`.
 * Every jspace/advisor event carries `triggerSeq`, a pointer to the event that
 * woke the review; the companion checks the pointed-at event against the
 * per-trigger-family predicate, so advice is never orphaned. The cadence
 * itself is policy and stays out of the invariant — this check is config-free.
 * @module @shres-code/shres-code-jspace-advisor/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { assertNever } from '@shres-code/shres-code-jspace'
import type { AdvisorTrigger } from './types.ts'
import { isErroredToolResult, isSuccessfulJspaceShipResult } from './review.ts'

const PACKAGE_NAME = '@shres-code/shres-code-jspace-advisor'

/** Cordis companion plugin name. */
export const name = 'jspace-advisor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The event at exactly `seq`, or `undefined`. */
function eventAt(log: readonly SessionEvent[], seq: number): SessionEvent | undefined {
  for (const event of log) {
    if (event.seq === seq) return event
  }
  return undefined
}

/** Goal of the last jspace/card event before `seq`, or `undefined`. */
function previousCardGoal(log: readonly SessionEvent[], seq: number): string | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined || event.type !== 'jspace/card' || event.seq >= seq) continue
    return event.data.goal
  }
  return undefined
}

/**
 * Whether the event at `triggerSeq` satisfies the trigger family's predicate.
 * @param log - session log.
 * @param triggerSeq - the seq the advice claims woke its review.
 * @param trigger - the trigger family.
 * @returns true when the pointed-at event proves the trigger.
 */
export function triggerSatisfiedAt(
  log: readonly SessionEvent[],
  triggerSeq: number,
  trigger: AdvisorTrigger,
): boolean {
  const event = eventAt(log, triggerSeq)
  if (event === undefined) return false
  switch (trigger) {
    case 'charter-fail':
      return event.type === 'jspace/charter-run'
        && event.data.phase !== 'ship' && event.data.phase !== 'probe' && event.data.passed === false
    case 'ship-attempt':
      return (event.type === 'jspace/charter-run' && event.data.phase === 'ship')
        || event.type === 'jspace/shipped'
        || isSuccessfulJspaceShipResult(event, log)
    case 'goal-epoch': {
      if (event.type !== 'jspace/card') return false
      const previous = previousCardGoal(log, triggerSeq)
      return previous !== undefined && previous !== event.data.goal
    }
    case 'error-burst':
      return isErroredToolResult(event)
    case 'drift-check':
      return event.type === 'step/end'
    case 'user-intent':
      return event.type === 'user/message' && event.data.source.kind === 'user'
    default:
      return assertNever(trigger)
  }
}

/**
 * Whether successive drift-check advices keep strictly increasing triggerSeqs.
 * @param log - session log.
 * @param seq - the new advice event's own seq.
 * @param triggerSeq - the new advice's triggerSeq.
 * @returns false when an earlier drift-check advice pointed at the same or a
 *   later step.
 */
function driftMonotonic(log: readonly SessionEvent[], seq: number, triggerSeq: number): boolean {
  for (const event of log) {
    if (event.seq >= seq) continue
    if (event.type !== 'jspace/advisor' || event.data.trigger !== 'drift-check') continue
    if (event.data.triggerSeq >= triggerSeq) return false
  }
  return true
}

/**
 * Install the trigger-precedence check over advisor events.
 * @param ctx - Cordis context carrying the invariant service.
 * @param fail - invariant failure reporter.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'jspace/advisor') return
    if (!triggerSatisfiedAt(session.events, event.data.triggerSeq, event.data.trigger)) {
      fail('jspace/advisor trigger ' + JSON.stringify(event.data.trigger)
        + ' has no satisfying event at triggerSeq ' + String(event.data.triggerSeq))
    }
    if (event.data.trigger === 'drift-check'
      && !driftMonotonic(session.events, event.seq, event.data.triggerSeq)) {
      fail('jspace/advisor drift-check triggerSeq ' + String(event.data.triggerSeq) + ' is not increasing')
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
