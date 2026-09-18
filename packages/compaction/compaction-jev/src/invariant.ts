/**
 * Package-owned invariant companion for `@shres-code/shres-code-compaction-jev`.
 * @module @shres-code/shres-code-compaction-jev/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'

const PACKAGE_NAME = '@shres-code/shres-code-compaction-jev'

/** Cordis companion plugin name. */
export const name = 'compaction-jev-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the verify-cascade relation this backend owns: an escalated
 * verification is always followed, before its compaction closes successfully,
 * by another verification attempt.
 *
 * The cascade escalates exactly when a draft failed and another attempt is
 * affordable, so a closed compaction whose latest verification still reads
 * `escalated` means the second draft was never verified — the failure the
 * cascade exists to prevent (a draft no battery ever read reaching the
 * surface). A compaction that closes WITH an error is exempt: a throwing
 * escalation draft legitimately abandons the cascade, and the inherited
 * transaction records that failure on the close.
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
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const compactionId = event.data.compactionId
    let latest: SessionEvent<'compaction/verification'> | undefined
    for (const candidate of session.events) {
      if (candidate.type === 'compaction/verification' && candidate.data.compactionId === compactionId) {
        latest = candidate
      }
    }
    if (latest === undefined) return
    if (latest.data.verdict === 'escalated') {
      fail(
        `compaction ${compactionId} closed with its latest verification still reading "escalated":`
        + ' the escalation draft was never verified',
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
/* jscpd:ignore-end */
