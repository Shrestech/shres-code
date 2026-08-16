/**
 * Package-owned invariant companion for `@roos-code/roos-code-llm-replay`.
 * @module @roos-code/roos-code-llm-replay/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@roos-code/cordis'
import type { InvariantInstaller } from '@roos-code/roos-code-invariants'

const PACKAGE_NAME = '@roos-code/roos-code-llm-replay'

/** Cordis companion plugin name. */
export const name = 'llm-replay-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this test-only adapter consumes a fixed replay script; its stream grammar
 * is checked by the LLM companion and fixture derivation tests.
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
