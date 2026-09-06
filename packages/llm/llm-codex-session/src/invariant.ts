/**
 * Package-owned invariant companion for `@shres-code/shres-code-llm-codex-session`.
 * @module @shres-code/shres-code-llm-codex-session/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-llm-codex-session'

/** Cordis companion plugin name. */
export const name = 'llm-codex-session-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: adapter registrations are proven disposed by the
 * package's HMR-safety test, and the credential freshness relation belongs
 * to the codex-credential package's own suite.
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
