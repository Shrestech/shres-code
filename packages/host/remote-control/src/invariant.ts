/**
 * Package-owned invariant companion for the remote-control package.
 * @module @shres-code/shres-code-host-remote-control/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-host-remote-control'

/** Cordis companion plugin name. */
export const name = 'host-remote-control-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: PR1 ships pure functions and the CLI.
 * Durable invariants (tunnel/registry relations) arrive with the mounted plugin face. */
const install: InvariantInstaller = () => {}

/**
 * Register the remote-control invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
