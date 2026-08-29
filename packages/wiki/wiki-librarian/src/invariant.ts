/**
 * Package-owned invariant companion for `@shres-code/shres-code-wiki-librarian`.
 * @module @shres-code/shres-code-wiki-librarian/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-wiki-librarian'

/** Cordis companion plugin name. */
export const name = 'wiki-librarian-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: page writes this seat produces are validated by the
 * Service Definition companion; the pre-dispatch request event is log-only
 * and has no later store relation of its own.
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
