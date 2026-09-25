/**
 * Package-owned invariant companion for `@shres-code/shres-code-model-router`.
 * @module @shres-code/shres-code-model-router/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type {} from '@shres-code/shres-code-agent/types'
import type { Session, SessionEvent, SessionEventMap } from '@shres-code/shres-code-session'
import type { ModelRoutingDecision } from './types.ts'

const PACKAGE_NAME = '@shres-code/shres-code-model-router'

/** Cordis companion plugin name. */
export const name = 'model-router-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the routing contract the log must always satisfy: inside the turn that
 * took it, a downgrade or error-recovery decision is followed by a
 * `request/header` whose config carries the selected route, and a downgraded
 * request's system prompt does not name the manual model. A `route-failed`
 * decision directly follows the same step's downgraded decision, with no turn
 * or step boundary between them, and names the provider that decision selected;
 * the request headers after it in its turn do not run the route that failed.
 * An `agent/route-base` the model-selection hook records follows its step's
 * downgraded decision: the record's manual route has that decision's entry
 * base provider and model, and its routed route is that decision's selection.
 *
 * That relation is the whole point of the feature — the decision is only
 * meaningful if the loop actually ran the downgraded route — and it is owned
 * here because this package writes both sides of it (the decision event and the
 * consult that rewrites the request). It is deliberately scoped to the
 * decision's own turn: a later turn whose mode is off, or whose manual route was
 * chosen afresh, legitimately logs a header that does not match an earlier
 * decision, and checking that would reject a session turning routing off.
 *
 * A mode or configuration value that marks `shadow` must also be `active`:
 * shadow judges without rewriting, so it is never a way to switch routing off.
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
    if (event.type === 'model-routing/mode' || event.type === 'model-routing/configuration') {
      // Shadow judges without rewriting, so it is a kind of active routing.
      if (event.data.shadow === true && !event.data.active) fail(`a ${event.type} value marks shadow without active: true`)
    }
    if (event.type === 'model-routing/configuration') {
      if (session.events.some(candidate => candidate.type === 'model-routing/mode')) {
        fail('a model-routing/configuration event cannot follow an explicit model-routing/mode selection')
      }
      return
    }
    if (event.type === 'model-routing/decision') {
      if (event.data.reason === 'route-failed') checkRouteFailed(session.events, event.data, fail)
      return
    }
    if (event.type === 'agent/route-base') {
      checkRouteBase(session.events, event.data, fail)
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
    const failed = decided.reason === 'route-failed' ? decided.failure : undefined
    if (failed !== undefined) {
      const retried = event.data.header.config
      if (retried.provider === failed.provider && retried.model === failed.model) {
        fail(`the retry after a route-failed decision runs the failed route (${failed.provider}/${failed.model})`)
      }
      return
    }
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
    // The prompt is assembled for the manual route before routing rewrites the
    // config, and a downgraded route never names the manual model (eligibility
    // excludes it), so a routed prompt naming that model tells the candidate it
    // is a model it is not. The comparison is a substring match on the model id.
    const manual = decided.sticky.entryBase
    const system = event.data.header.system
    if (!recovery && manual !== undefined && system !== undefined && system.includes(manual.model)) {
      fail(
        `routed request names the manual model: the system prompt of the ${config.provider}/${config.model}`
        + ` request contains "${manual.model}"`,
      )
    }
  }, { global: true })
}

/**
 * Require a `route-failed` decision to retry the step a downgrade selected:
 * the last decision before it, with no `turn/start` or `step/start` between,
 * is downgraded and selected the failed provider.
 * @param events - the session log before the decision is published.
 * @param decision - the `route-failed` decision being appended.
 * @param fail - the reporter that rejects the append.
 */
function checkRouteFailed(events: readonly SessionEvent[], decision: ModelRoutingDecision, fail: InvariantFailure): void {
  let previous: ModelRoutingDecision | undefined
  for (const candidate of events) {
    if (candidate.type === 'model-routing/decision') previous = candidate.data
    else if (candidate.type === 'turn/start' || candidate.type === 'step/start') previous = undefined
  }
  if (previous?.outcome !== 'downgraded' || previous.selection?.provider !== decision.failure?.provider) {
    fail('a route-failed decision must follow the same step\'s downgraded decision for the failed provider')
  }
}

/**
 * Require an `agent/route-base` to agree with the downgrade it records: the
 * latest downgraded decision with no `turn/start` or `step/start` after it has
 * an entry base with the record's manual provider and model, and a selection
 * equal to the record's routed route.
 * @param events - the session log before the record is published.
 * @param record - the `agent/route-base` being appended.
 * @param fail - the reporter that rejects the append.
 */
function checkRouteBase(events: readonly SessionEvent[], record: SessionEventMap['agent/route-base'], fail: InvariantFailure): void {
  let downgraded: ModelRoutingDecision | undefined
  for (const candidate of events) {
    if (candidate.type === 'turn/start' || candidate.type === 'step/start') downgraded = undefined
    else if (candidate.type === 'model-routing/decision' && candidate.data.outcome === 'downgraded') downgraded = candidate.data
  }
  const entryBase = downgraded?.sticky.entryBase
  const selection = downgraded?.selection
  if (entryBase === undefined || selection === undefined) {
    fail('an agent/route-base must follow its step\'s downgraded decision with an entry base and a selection')
    return
  }
  const { manual, routed } = record
  if (entryBase.provider !== manual.provider || entryBase.model !== manual.model) {
    fail(
      `agent/route-base manual route (${manual.provider}/${manual.model})`
      + ` differs from the downgrade's entry base (${entryBase.provider}/${entryBase.model})`,
    )
  }
  if (selection.provider !== routed.provider || selection.model !== routed.model
    || selection.reasoningEffort !== routed.reasoningEffort) {
    fail(
      `agent/route-base routed route (${routed.provider}/${routed.model})`
      + ` differs from the downgrade's selection (${selection.provider}/${selection.model})`,
    )
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
