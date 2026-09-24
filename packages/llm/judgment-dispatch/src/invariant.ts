/**
 * Package-owned invariant companion for the judgment dispatcher.
 * @module @shres-code/shres-code-judgment-dispatch/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-dispatch'

/** Cordis companion plugin name. */
export const name = 'judgment-dispatch-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the dispatcher owns no event stream and appends no
 * session event. Its routing relation — each answer comes from the engine the
 * settings select and carries that engine's id — is decided and stamped in the
 * one `ask` call that makes it, so there is no later observation to check.
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
