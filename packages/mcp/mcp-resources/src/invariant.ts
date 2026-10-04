/**
 * Package-owned invariant companion for `@shres-code/shres-code-mcp-resources`.
 * @module @shres-code/shres-code-mcp-resources/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-mcp-resources'

/** Cordis companion plugin name. */
export const name = 'mcp-resources-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: shared resource tools are registered and removed with the scoped
 * provider set, and the tool registry is the only live record of that set.
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
