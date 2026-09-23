/**
 * Package-owned invariant companion for `@shres-code/shres-code-model-router`.
 * @module @shres-code/shres-code-model-router/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import type { ModelRoutingDecision } from './types.ts'

const PACKAGE_NAME = '@shres-code/shres-code-model-router'

/** Cordis companion plugin name. */
export const name = 'model-router-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the routing contract the log must always satisfy: inside the turn that
 * took it, a downgrade or error-recovery decision is followed by a
 * `request/header` whose config carries the selected route.
 *
 * That relation is the whole point of the feature — the decision is only
 * meaningful if the loop actually ran the downgraded route — and it is owned
 * here because this package writes both sides of it (the decision event and the
 * consult that rewrites the request). It is deliberately scoped to the
 * decision's own turn: a later turn whose mode is off, or whose manual route was
 * chosen afresh, legitimately logs a header that does not match an earlier
 * decision, and checking that would reject a session turning routing off.
 *
 * Configuration events may replace one another until the session records an
 * explicit `model-routing/mode`; after that point, even a same-valued
 * configuration append is an invalid producer transition because the user
 * choice owns the mode. The check rejects that transition before publication,
 * so the pure fold never has to reinterpret malformed history.
 *
 * The check runs on `internal/dispatch` **before publication**, which is what
 * makes a violation fail loudly: a `session/event` listener's throw is
 * contained per listener and logged, so an invariant registered there could
 * never reject the append that broke the relation. The check reads the
 * authoritative event stream and the session's own log, never service or method
 * presence.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'model-routing/configuration') {
      if (session.events.some(candidate => candidate.type === 'model-routing/mode')) {
        fail('a model-routing/configuration event cannot follow an explicit model-routing/mode selection')
      }
      return
    }
    if (event.type !== 'request/header') return
    let turnStartSeq = -1
    let decided: ModelRoutingDecision | undefined
    let decisionSeq = -1
    for (const candidate of session.events) {
      if (candidate.type === 'turn/start') turnStartSeq = candidate.seq
      if (candidate.type === 'model-routing/decision') {
        decided = candidate.data
        decisionSeq = candidate.seq
      }
    }
    // Only the decision this turn took is in force for this header.
    if (decided === undefined || decisionSeq < turnStartSeq) return
    const recovery = decided.outcome === 'kept-strong' && decided.reason === 'route-errors'
    if (decided.outcome !== 'downgraded' && !recovery) return
    const selection = recovery ? decided.sticky.entryBase : decided.selection
    if (selection === undefined) {
      fail(recovery
        ? 'a route-error recovery decision carries no manual route'
        : 'a downgraded routing decision carries no selection')
      return
    }
    const config = event.data.header.config
    if (config.provider !== selection.provider || config.model !== selection.model) {
      fail(
        `the request header after a routing decision (${config.provider}/${config.model})`
        + ` does not match the selected route (${selection.provider}/${selection.model})`,
      )
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
