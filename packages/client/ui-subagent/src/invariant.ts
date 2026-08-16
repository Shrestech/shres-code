/**
 * Package-owned invariant companion for `@roos-code/roos-code-client-ui-subagent`.
 * @module @roos-code/roos-code-client-ui-subagent/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@roos-code/cordis'
import type { InvariantInstaller } from '@roos-code/roos-code-invariants'

const PACKAGE_NAME = '@roos-code/roos-code-client-ui-subagent'

/** Cordis companion plugin name. */
export const name = 'client-ui-subagent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a single slash-source registration whose disposal is
 * proven by the HMR-safety spec — it emits no cordis events and owns no
 * cross-plugin mutable state.
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
