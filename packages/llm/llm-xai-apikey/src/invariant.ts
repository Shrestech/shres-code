/**
 * Package-owned invariant companion for `@shres-code/shres-code-llm-xai-apikey`.
 * @module @shres-code/shres-code-llm-xai-apikey/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-llm-xai-apikey'

/** Cordis companion plugin name. */
export const name = 'llm-xai-apikey-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: route ownership belongs to the llm service, and the
 * credential's freshness relation is owned (and unit-tested) by the adapter's
 * per-request resolve, not by a cross-plugin data stream.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
