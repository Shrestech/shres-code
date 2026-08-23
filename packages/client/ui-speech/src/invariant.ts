/**
 * Package-owned invariant companion for `@shres-code/shres-code-client-ui-speech`.
 * @module @shres-code/shres-code-client-ui-speech/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-client-ui-speech'

/** Cordis companion plugin name. */
export const name = 'client-ui-speech-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: host speech conversion is audited by shres-speech,
 * while the mic, speaker, and Talk composer are slot effects exercised here.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
