/**
 * Package-owned invariant companion for
 * `@shres-code/shres-code-worker-escalation`.
 * @module @shres-code/shres-code-worker-escalation/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
// Type-only edges: resolve `ctx.settings` and `ctx.jspace`.
import type {} from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-jspace'
import { WORKER_ESCALATION_SETTINGS_NAMESPACE } from './config.ts'
import { triggerSatisfiedAt } from './fold.ts'

const PACKAGE_NAME = '@shres-code/shres-code-worker-escalation'

/** Cordis companion plugin name. */
export const name = 'worker-escalation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the relations this package's own events must always satisfy:
 *
 * 1. **Every decision points at a real trigger event.** A decision names the
 *    event that woke the ladder, so a decision whose `triggerSeq` holds no
 *    event of that trigger's family is a record of nothing.
 * 2. **The epoch's aging counter is exact.** A `continue` decision records one
 *    more resolution than the epoch already took and its own seq as the newest
 *    continue; a `report-blocked` decision records the count it inherited. The
 *    counter therefore only ever advances by one per decision, which is the
 *    monotonicity the `maxContinues` terminal is defined against.
 * 3. **Nothing is written while the ladder is off.** A resolved settings
 *    section that reads `enabled: false` and an `escalation/decision` in the
 *    same log contradict each other. The check is inert when no settings
 *    service carries the section, because a composition's own entry config is
 *    then the only switch and a companion cannot see it.
 *
 * The step cooldown stays out of the companion: it is policy over the same log
 * (completed steps advance monotonically by construction), and the invariant
 * is config-free.
 *
 * The check runs on `internal/dispatch` **before publication**, which is what
 * makes a violation fail loudly: a `session/event` listener's throw is
 * contained per listener and logged, so an invariant registered there could
 * never reject the append that broke the relation.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'escalation/decision') return
    const data = event.data
    if (!triggerSatisfiedAt(session.events, data.triggerSeq, data.trigger)) {
      fail('escalation/decision trigger ' + JSON.stringify(data.trigger)
        + ' has no satisfying event at triggerSeq ' + String(data.triggerSeq))
    }
    const section = ctx.get('settings')?.get(WORKER_ESCALATION_SETTINGS_NAMESPACE) as { enabled?: boolean } | undefined
    if (section !== undefined && section.enabled === false) {
      fail('an escalation/decision was appended while the worker-escalation settings section reads enabled: false')
    }
    const anchorSeq = ctx.get('jspace')?.card(session)?.goalOpenedSeq ?? -1
    let continues = 0
    let lastContinueSeq: number | undefined
    for (const candidate of session.events) {
      if (candidate.type !== 'escalation/decision') continue
      if (candidate.seq <= anchorSeq || candidate.seq >= event.seq) continue
      if (candidate.data.choice === 'report-blocked') continue
      continues += 1
      lastContinueSeq = candidate.seq
    }
    const expectedContinues = data.choice === 'continue' ? continues + 1 : continues
    if (data.aging.continues !== expectedContinues) {
      fail('escalation/decision records ' + String(data.aging.continues)
        + ' continue resolutions while its goal epoch already took ' + String(continues))
    }
    const expectedLast = data.choice === 'continue' ? event.seq : lastContinueSeq
    if (data.aging.lastContinueSeq !== expectedLast) {
      fail('escalation/decision records lastContinueSeq '
        + String(data.aging.lastContinueSeq) + ' while the epoch\'s newest continue is ' + String(expectedLast))
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
