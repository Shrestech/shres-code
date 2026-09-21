/**
 * Package-owned invariant companion for
 * `@shres-code/shres-code-judgment-guardrails`.
 * @module @shres-code/shres-code-judgment-guardrails/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
// Type-only edge: resolve `ctx.settings`.
import type {} from '@shres-code/shres-code-settings'
import { GUARDRAILS_SETTINGS_NAMESPACE } from './config.ts'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-guardrails'

/** Cordis companion plugin name. */
export const name = 'judgment-guardrails-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the relations this package's own event must always satisfy:
 *
 * 1. **Every decision points at real evidence.** The state a check judged is
 *    assembled from the `tool/result` that triggered it and, when the log holds
 *    it, the `tool/call` it answers, so a decision whose `stateSeqs` name
 *    another event, or a call that answers a different callId, records evidence
 *    that does not exist. A result whose call the log no longer holds is a
 *    legitimate state — the observer names its tool `unknown` — so a lone result
 *    seq is accepted and a lone call seq is not.
 * 2. **The answers come from an engine.** An `observed` decision carries both
 *    answers and a `degraded` one carries neither: a check that read no answer
 *    cannot report one, and a check that read an answer cannot hide it.
 * 3. **Nothing is written while the observer is off.** A resolved settings
 *    section that reads `enabled: false` and a `guard/decision` in the same log
 *    contradict each other. The check is inert when no settings service carries
 *    the section, because a composition's own entry config is then the only
 *    switch and a companion cannot see it.
 *
 * The observer has no threshold and no acting path, so nothing here asserts a
 * verdict: what a decision means is for the labeled set this observation
 * produces.
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
    if (event.type !== 'guard/decision') return
    const data = event.data
    if (!evidenceHolds(session, data.stateSeqs)) {
      fail('guard/decision stateSeqs ' + JSON.stringify(data.stateSeqs)
        + ' do not name one tool call and the result it answers')
    }
    const answered = data.injection !== undefined && data.severity !== undefined
    if (answered !== (data.outcome === 'observed')) {
      fail('guard/decision outcome ' + JSON.stringify(data.outcome)
        + ' does not match the answers it carries: ' + JSON.stringify(Object.keys(data)))
    }
    const section = ctx.get('settings')?.get(GUARDRAILS_SETTINGS_NAMESPACE) as { enabled?: boolean } | undefined
    if (section !== undefined && section.enabled === false) {
      fail('a guard/decision was appended while the judgment-guardrails settings section reads enabled: false')
    }
  }, { global: true })
}

/**
 * Whether one decision's evidence seqs name exactly the call and result pair the
 * observer builds a state from.
 * @param session - the session holding the log the decision was appended to.
 * @param seqs - the seqs the decision records.
 * @returns true when they name a `tool/call` and the `tool/result` answering it.
 */
function evidenceHolds(session: Session, seqs: readonly number[]): boolean {
  if (seqs.length === 0 || seqs.length > 2) return false
  const events = seqs.map(seq => session.events.find(candidate => candidate.seq === seq))
  if (events.some(candidate => candidate === undefined)) return false
  const call = events.find(candidate => candidate?.type === 'tool/call')
  const result = events.find(candidate => candidate?.type === 'tool/result')
  // A check is always triggered by a result, and it names the call only when the
  // log still holds one.
  if (result === undefined) return false
  if (call === undefined) return seqs.length === 1
  if (call.seq >= result.seq) return false
  return resultCallId(result) === call.data.callId
}

/**
 * The callId one result answers, read from its first block.
 * @param result - the `tool/result` event named by a decision.
 * @returns the callId, or undefined when the message holds no block.
 */
function resultCallId(result: SessionEvent<'tool/result'>): string | undefined {
  return result.data.message.content.at(0)?.toolCallId
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
