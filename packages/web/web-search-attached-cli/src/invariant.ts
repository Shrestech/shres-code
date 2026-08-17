/**
 * Package-owned invariant companion for `@shres-code/shres-code-web-search-attached-cli`.
 * @module @shres-code/shres-code-web-search-attached-cli/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-web-search-attached-cli'

/** Cordis companion plugin name. */
export const name = 'web-search-attached-cli-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is a stateless HTTP multiplexer over
 * vendor search APIs; selection is a pure function of the last credential
 * snapshot and the default-model provider id.
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
