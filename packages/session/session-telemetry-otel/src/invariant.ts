/**
 * Package-owned invariant companion for `@shres-code/shres-code-session-telemetry-otel`.
 * @module @shres-code/shres-code-session-telemetry-otel/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-session-telemetry-otel'

/** Cordis companion plugin name. */
export const name = 'session-telemetry-otel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: mode selection changes capture handoff, SDK setup, and
 * local diagnostics without mutating session or service state an independent
 * companion can compare. Export remains inside the SDK past the backend boundary.
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
