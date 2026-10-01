/**
 * Package-owned invariant companion for the default Agent model selection.
 *
 * Defaults come from validated settings and session selections are read from
 * the event log. The service owns no independent projection to compare with
 * either source.
 *
 * @module @shres-code/shres-code-agent-default-model/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-agent-default-model'

/** Cordis companion plugin name. */
export const name = 'agent-default-model-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: selections derive directly from validated settings or the session log. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
