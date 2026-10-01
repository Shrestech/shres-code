/**
 * Package-owned invariant companion for the local Shield judgment provider.
 * @module @shres-code/shres-code-judgment-shield/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-shield'

/** Cordis companion plugin name. */
export const name = 'judgment-shield-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns one request/response exchange and no
 * event stream or mutable companion state. Response identity, distribution,
 * argmax, expectation, and byte-limit obligations are checked at the HTTP
 * boundary by `readWireResponse` and `readBoundedBody`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant companion.
 * @param ctx - context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
