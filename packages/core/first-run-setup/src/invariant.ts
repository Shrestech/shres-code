/**
 * Package-owned invariant companion for the first-run model picker.
 *
 * The service owns no independent event relationship: settings and credential
 * writes go through those seams' own validation, and the picker is a
 * one-shot host prompt. The empty installer keeps that absence explicit.
 *
 * @module @shres-code/shres-code-first-run-setup/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantInstaller } from '@shres-code/shres-code-invariants'

const PACKAGE_NAME = '@shres-code/shres-code-first-run-setup'

/** Cordis companion plugin name. */
export const name = 'first-run-setup-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: other seams own every mutable value this package writes. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
