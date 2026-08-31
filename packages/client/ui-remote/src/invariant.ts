/**
 * Package-owned invariant companion for `@shres-code/shres-code-client-ui-remote`.
 * @module @shres-code/shres-code-client-ui-remote/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-remote'

/** Cordis companion plugin name. */
export const name = 'client-ui-remote-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a pure-consumer plugin registering one presentational
 * component into a host-declared sidebar slot plus its locale dictionaries —
 * its inject face is stateless RPC wrappers over the remoteControl and
 * remoteAdmin namespaces feeding a plugin-closure view store; it emits no
 * cordis events and owns no cross-plugin mutable state.
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
