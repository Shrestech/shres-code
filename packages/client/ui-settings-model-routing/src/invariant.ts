/** Package-owned invariant companion. @module @shres-code/shres-code-client-ui-settings-model-routing/invariant */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-settings-model-routing'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-model-routing-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package renders a Settings page over Host facts
 * it owns none of; the engine view and the settings sections keep their own
 * invariants at their owners.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
