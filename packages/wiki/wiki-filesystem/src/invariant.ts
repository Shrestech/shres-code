/**
 * Package-owned invariant companion for `@shres-code/shres-code-wiki-filesystem`.
 * @module @shres-code/shres-code-wiki-filesystem/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-wiki-filesystem'

/** Cordis companion plugin name. */
export const name = 'wiki-filesystem-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: page presence for `wiki/page` is owned by the Service
 * Definition companion; this provider only implements the persistence hooks.
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
