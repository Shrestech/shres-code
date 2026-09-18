/**
 * Package-owned invariant companion for `@shres-code/shres-code-judgment-typesafe`.
 * @module @shres-code/shres-code-judgment-typesafe/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-typesafe'

/** Cordis companion plugin name. */
export const name = 'judgment-typesafe-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns one HTTP request per ask and keeps no
 * event stream and no mutable state, so it exposes no cross-plugin relation to
 * check. What it enforces — one answer per asked question, of that question's
 * own kind, with finite numbers — is judged inside `readWireResponse` against
 * the response of that single request.
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
