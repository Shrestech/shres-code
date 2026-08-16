/**
 * Package-owned invariant companion for `@roos-code/roos-code-api-gateway`.
 * @module @roos-code/roos-code-api-gateway/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@roos-code/cordis'
import type { InvariantInstaller } from '@roos-code/roos-code-invariants'

const PACKAGE_NAME = '@roos-code/roos-code-api-gateway'

/** Cordis companion plugin name. */
export const name = 'api-gateway-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Host calls re-read authoritative Cordis and Typert
 * state, while Client methods, descriptors, and `$on` subscriptions mutate in
 * one owned effect.
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
