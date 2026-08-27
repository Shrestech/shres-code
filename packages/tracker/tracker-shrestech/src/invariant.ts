/**
 * Package-owned invariant companion for `@shres-code/shres-code-tracker-shrestech`.
 * @module @shres-code/shres-code-tracker-shrestech/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-tracker-shrestech'

/** Cordis companion plugin name. */
export const name = 'tracker-shrestech-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider publishes no independent event sequence
 * or mutable data relation beyond the spool file it owns, whose append/drain
 * contract is asserted by the spool's own tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
