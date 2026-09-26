/** Package-owned invariant companion. @module @shres-code/shres-code-client-ui-browserskill/invariant */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-browserskill'

/** Cordis companion plugin name. */
export const name = 'client-ui-browserskill-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the section is a presentation shell over the
 * browserSkill namespace — every mutation fact it renders originates in the
 * host gateway, whose focused tests own the authoritative relationships.
 * Registration disposal is covered by the plugin client test.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
