/**
 * Package-owned invariant companion for the local Laya judgment provider.
 * @module @shres-code/shres-code-judgment-laya/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-laya'

/** Cordis companion plugin name. */
export const name = 'judgment-laya-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session event and owns no
 * durable companion state. Gateway identity, manifest, and token-limit
 * agreement is checked at the process boundary when the readiness line and
 * health check are read, and every answer is validated by the Shield wire
 * client before it reaches a consumer.
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
