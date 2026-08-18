/**
 * Package-owned invariant companion for `@shres-code/shres-code-client-ui-jspace`.
 * @module @shres-code/shres-code-client-ui-jspace/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-jspace'

/** Cordis companion plugin name. */
export const name = 'client-ui-jspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: card state and settings remount are audited by
 * shres-jspace, while the chip and dock are slot effects whose
 * declaration, registration, and teardown are exercised by this package.
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
