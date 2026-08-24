/**
 * Package-owned invariant companion for `@shres-code/shres-code-tracker`.
 * @module @shres-code/shres-code-tracker/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-tracker'

/** Cordis companion plugin name. */
export const name = 'tracker-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `tracker/run` and `tracker/metrics` are log-only,
 * `ignorable` events whose payloads are validated at write time by the owning
 * service's `resolveLogRun`; the seam publishes no independent registry or
 * mutable data sequence to reconcile.
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
