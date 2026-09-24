/**
 * Package-owned invariant companion for `@shres-code/shres-code-settings`.
 * @module @shres-code/shres-code-settings/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import { deepEqualJson } from './index.ts'

const PACKAGE_NAME = '@shres-code/shres-code-settings'

/** Cordis companion plugin name. */
export const name = 'settings-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the commit-event contract: `settings/updated` fires only for a
 * currently registered namespace, only when the resolved value changed, and
 * only with the service's authoritative resolved value — all judged with the
 * seam's own equality predicate. `settings/registered` fires only with the
 * registered namespace's authoritative value, and `settings/unregistered`
 * only once the namespace no longer reads.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('settings/registered', (ns, value) => {
    const current = ctx.get('settings')?.get(ns)
    if (current === undefined) fail(`settings/registered for "${ns}" emitted while the namespace is unregistered`)
    if (!deepEqualJson(current, value)) {
      fail(`settings/registered for "${ns}" does not match the authoritative resolved value`)
    }
  })
  ctx.on('settings/unregistered', (ns) => {
    if (ctx.get('settings')?.get(ns) !== undefined) {
      fail(`settings/unregistered for "${ns}" emitted while the namespace is still registered`)
    }
  })
  ctx.on('settings/updated', (ns, next, prev) => {
    const settings = ctx.get('settings')
    if (settings === undefined) {
      fail(`settings/updated for "${ns}" emitted without a live settings service`)
    }
    const current = settings.get(ns)
    if (current === undefined) {
      fail(`settings/updated for "${ns}" emitted while the namespace is unregistered`)
    }
    if (!deepEqualJson(current, next)) {
      fail(`settings/updated for "${ns}" does not match the authoritative resolved value`)
    }
    if (deepEqualJson(next, prev)) {
      fail(`settings/updated for "${ns}" emitted without a resolved-value change`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
