/**
 * Package-owned invariant companion for `@shres-code/shres-code-ledger`.
 * @module @shres-code/shres-code-ledger/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'

const PACKAGE_NAME = '@shres-code/shres-code-ledger'

/** Cordis companion plugin name. */
export const name = 'ledger-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relation: every `ledger/decision` event's entry id must be present in
 * the ledger store. The seam's `record` persists the entry before appending
 * the event, so a published event whose entry is not queryable means the store
 * and the event stream have diverged. Validated in `internal/dispatch` so a
 * violation vetoes the append.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [_session, event] = args as [Session, SessionEvent]
    if (event.type !== 'ledger/decision') return
    if (!ctx.ledger.hasEntry(event.data.entryId)) {
      fail(`ledger/decision event ${event.data.entryId} is not present in the ledger store`)
    }
  }, { global: true })
}, { inject: ['ledger'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
