/**
 * Package-owned invariant companion for `@roos-code/roos-code-llm-cli-bridge`.
 * @module @roos-code/roos-code-llm-cli-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@roos-code/cordis'
import type { InvariantInstaller } from '@roos-code/roos-code-invariants'

const PACKAGE_NAME = '@roos-code/roos-code-llm-cli-bridge'

/** Cordis companion plugin name. */
export const name = 'llm-cli-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: route ownership belongs to the llm service and
 * process-tree ownership belongs to the subprocess service.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
