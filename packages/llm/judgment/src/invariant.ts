/**
 * Package-owned invariant companion for `@shres-code/shres-code-judgment`.
 * @module @shres-code/shres-code-judgment/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment'

/** Cordis companion plugin name. */
export const name = 'judgment-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is pure vocabulary — a branded id, a
 * question and answer union, and an error class — so it owns no event stream,
 * no mutable data, and no live service state. What holds between an answer and
 * the question it names is the provider's wire validation
 * (packages/llm/judgment-typesafe) and each consumer's own reading of the
 * probabilities; neither relation is observable from here.
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
