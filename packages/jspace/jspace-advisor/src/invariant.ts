/**
 * Package-owned invariant companion for `@shres-code/shres-code-jspace-advisor`.
 * Every `jspace/advisor` event must be preceded in the same session by an event
 * satisfying its trigger predicate, so a logged advice is never orphaned.
 * @module @shres-code/shres-code-jspace-advisor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { classifyTrigger } from './review.ts'

const PACKAGE_NAME = '@shres-code/shres-code-jspace-advisor'

/** Cordis companion plugin name. */
export const name = 'jspace-advisor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Whether the session log contains an event before `seq` that classifies as
 * the given trigger.
 * @param log - session log.
 * @param seq - the `jspace/advisor` event's seq.
 * @param trigger - the trigger the advice claims.
 * @param errorBurst - consecutive errored tool results that count as a burst.
 * @returns true when a preceding event satisfies the trigger.
 */
function hasPrecedingTrigger(
  log: readonly SessionEvent[],
  seq: number,
  trigger: string,
  errorBurst: number,
): boolean {
  for (const event of log) {
    if (event.seq >= seq) continue
    if (classifyTrigger(event, log, errorBurst) === trigger) return true
  }
  return false
}

/**
 * Install a trigger-precedence check over advisor events.
 * @param ctx - Cordis context carrying the invariant service.
 * @param fail - invariant failure reporter.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'jspace/advisor') return
    if (!hasPrecedingTrigger(session.events, event.seq, event.data.trigger, 2)) {
      fail(`jspace/advisor trigger ${JSON.stringify(event.data.trigger)} has no preceding satisfying event`)
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
/* jscpd:ignore-end */
