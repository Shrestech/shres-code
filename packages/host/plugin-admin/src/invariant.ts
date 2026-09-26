/** Package-owned invariant companion. @module @shres-code/shres-code-host-plugin-admin/invariant */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-host-plugin-admin'

/** Cordis companion plugin name. */
export const name = 'host-plugin-admin-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the at-most-one parked transaction is the gateway's
 * single owned slot, its disposal quiescence is covered by the focused
 * server tests, and there is no cross-party event or data relation to
 * observe.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
