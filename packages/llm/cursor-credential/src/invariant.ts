/**
 * Package-owned invariant companion for `@shres-code/shres-code-cursor-credential`.
 * @module @shres-code/shres-code-cursor-credential/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-cursor-credential'

/** Cordis companion plugin name. */
export const name = 'cursor-credential-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the credential's freshness relation is owned (and
 * unit-tested) by the session manager's per-call resolve, not by a
 * cross-plugin data stream.
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
