/**
 * Package-owned invariant companion for `@shres-code/shres-code-research-stubs`.
 * @module @shres-code/shres-code-research-stubs/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-research-stubs'

/** Cordis companion plugin name. */
export const name = 'research-stubs-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: these test-only seats echo fixed digests; the
 * design-defense relation they satisfy is asserted by the research protocol
 * package's own invariant companion.
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
