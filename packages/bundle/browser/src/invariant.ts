/**
 * Package-owned invariant companion for
 * `@shres-code/shres-code-browser-bundle`.
 * @module @shres-code/shres-code-browser-bundle/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-browser-bundle'

/** Cordis companion plugin name. */
export const name = 'browser-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the package is a static patch-list carrier whose rows
// are owned by BrowserSkill and its client Plugins package.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
