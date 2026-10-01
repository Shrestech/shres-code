/**
 * Package-owned invariant companion for `@shres-code/shres-code-progress-signals`.
 * @module @shres-code/shres-code-progress-signals/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-progress-signals'

/** Cordis companion plugin name. */
export const name = 'progress-signals-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this pure fold library owns no event stream or mutable runtime data. It
 * only reads events other packages commit, and a consumer that logs a verdict owns the invariant
 * that checks it, as worker-escalation's companion does through `triggerSatisfiedAt`. The verdict
 * algebra is enforced by unit tests.
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
