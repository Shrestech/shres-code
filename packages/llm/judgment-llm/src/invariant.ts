/**
 * Package-owned invariant companion for `@shres-code/shres-code-judgment-llm`.
 * @module @shres-code/shres-code-judgment-llm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-judgment-llm'

/** Cordis companion plugin name. */
export const name = 'judgment-llm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package makes one `ctx.llm` request per ask, emits
 * no event, and appends nothing to a session, so it owns no cross-plugin event
 * or data relation to check. What it enforces — one answer per asked question,
 * every offered option covered, probabilities from 0 to 1 — is judged inside
 * `readAnswers` against that single request's answer, and its route status is
 * read by the registry through the engine's own `status()`.
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
