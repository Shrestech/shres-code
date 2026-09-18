/**
 * Package-owned invariant companion for `@shres-code/shres-code-client-ui-model-routing`.
 * @module @shres-code/shres-code-client-ui-model-routing/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-model-routing'

/** Cordis companion plugin name. */
export const name = 'client-ui-model-routing-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every fact the chip renders is the host-computed
 * `modelRouting` projection owned by shres-model-router, and the chip is a slot
 * effect whose declaration, registration, and teardown are exercised by this
 * package's own browser-plugin suite.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
