/**
 * Package-owned invariant companion for
 * `@shres-code/shres-code-worker-escalation`.
 * @module @shres-code/shres-code-worker-escalation/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import { triggerSatisfiedAt } from '@shres-code/shres-code-progress-signals'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
// Type-only edges: resolve `ctx.settings` and `ctx.jspace`.
import type {} from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-jspace'
import { WORKER_ESCALATION_SETTINGS_NAMESPACE } from './config.ts'

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
 * 2. **The epoch's aging counter is exact.** Any decision that is not the
 *    terminal records one more resolution than the epoch already took and its
 *    own seq as the newest continue; a `report-blocked` decision records the
 *    count it inherited. The counter therefore only ever advances by one per
 *    decision, which is the monotonicity the `maxContinues` terminal is
 *    defined against.
 * 3. **Nothing is written while the ladder is off.** A resolved settings
 *    section that reads `enabled: false` and an `escalation/decision` in the
 *    same log contradict each other. The check is inert when no settings
 *    service carries the section, because a composition's own entry config is
 *    then the only switch and a companion cannot see it.
 * 4. **A recorded confidence comes from an engine.** Only an answered ask
 *    reports a confidence and a margin, so a decision carrying either without
 *    the `'ok'` engine class records figures nothing produced.
 * 5. **A recorded ask is one the human could have answered.** The terminal
 *    asks nothing, so a `report-blocked` decision carrying `ask` records an
 *    ask that never happened; an `ask` carries an option exactly when its
 *    reason is `answered`; and a resolved settings section that reads
 *    `askToEscalate: false` beside a decision carrying `ask` contradicts it,
 *    inert without a settings service the way relation 3 is.
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
    const section = ctx.get('settings')?.get(WORKER_ESCALATION_SETTINGS_NAMESPACE) as
      | { enabled?: boolean; askToEscalate?: boolean }
      | undefined
    if (section !== undefined && section.enabled === false) {
      fail('an escalation/decision was appended while the worker-escalation settings section reads enabled: false')
    }
    const ask = data.ask
    if (ask !== undefined) {
      if (data.choice === 'report-blocked') {
        fail('escalation/decision is the report-blocked terminal and carries an ask, which the terminal never makes')
      }
      if ((ask.option !== undefined) !== (ask.reason === 'answered')) {
        fail('escalation/decision ask carries option ' + JSON.stringify(ask.option)
          + ' with reason ' + JSON.stringify(ask.reason) + ', which is not an answered ask')
      }
      if (section !== undefined && section.askToEscalate === false) {
        fail('an escalation/decision carries an ask while the worker-escalation settings section reads askToEscalate: false')
      }
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
    const terminal = data.choice === 'report-blocked'
    const expectedContinues = terminal ? continues : continues + 1
    if (data.aging.continues !== expectedContinues) {
      fail('escalation/decision records ' + String(data.aging.continues)
        + ' continue resolutions while its goal epoch already took ' + String(continues))
    }
    const expectedLast = terminal ? lastContinueSeq : event.seq
    if (data.aging.lastContinueSeq !== expectedLast) {
      fail('escalation/decision records lastContinueSeq '
        + String(data.aging.lastContinueSeq) + ' while the epoch\'s newest continue is ' + String(expectedLast))
    }
    if (data.confidence !== undefined && data.engine !== 'ok') {
      fail('escalation/decision carries confidence ' + String(data.confidence)
        + ' with engine class ' + String(data.engine) + ', which cannot be an answered ask')
    }
    if (data.margin !== undefined && data.engine !== 'ok') {
      fail('escalation/decision carries margin ' + String(data.margin)
        + ' with engine class ' + String(data.engine) + ', which cannot be an answered ask')
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
