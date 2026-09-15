/**
 * Package-owned invariant companion for `@shres-code/shres-code-client-ui-agent-team`.
 * @module @shres-code/shres-code-client-ui-agent-team/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-agent-team'

/** Cordis companion plugin name. */
export const name = 'client-ui-agent-team-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: one header-slot registration whose disposal is
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
