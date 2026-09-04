/**
 * Package-owned invariant companion for `@shres-code/shres-code-speech-openai-compatible`.
 * @module @shres-code/shres-code-speech-openai-compatible/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-speech-openai-compatible'

/** Cordis companion plugin name. */
export const name = 'speech-openai-compatible-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a request/response HTTP call leaves no owned event
 * stream or mutable registry an independent companion can reconstruct, and
 * the settings section it reads is owned and observed by the speech seam.
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
