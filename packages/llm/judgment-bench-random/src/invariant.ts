/**
 * Package-owned invariant companion for the bench-only seeded judgment engine.
 * @module @shres-code/shres-code-judgment-bench-random/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-bench-random'

/** Cordis companion plugin name. */
export const name = 'judgment-bench-random-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the engine is a stateless pure function of
 * (seed, sessionId, consultKey) with egress `none`, so it owns no event
 * stream, no mutable state, and no wire. Its determinism, draw range, rate,
 * and answer-shape obligations are checked by `hashDraw` and `consult` tests
 * and by the dispatcher's engine registration.
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
