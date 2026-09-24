/**
 * Package-owned invariant companion for `@shres-code/shres-code-tool-grok-x-search`.
 * @module @shres-code/shres-code-tool-grok-x-search/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { SessionEvent } from '@shres-code/shres-code-session'
import type {} from './types.ts'

const PACKAGE_NAME = '@shres-code/shres-code-tool-grok-x-search'

const TOOL_NAMES: ReadonlySet<string> = new Set(['x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch'])

/** Cordis companion plugin name. */
export const name = 'tool-grok-x-search-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check every committed `grok-x-search/request` against what this package
 * writes: one of the four tool names, the grok-session route, and exactly the
 * hosted `x_search` tool. A request has no required successor: an in-flight,
 * cancelled, or crashed call legitimately has no tool result.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  // Pre-dispatch hook: a failure here rejects the append before the event commits.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [unknown, SessionEvent])[1]
    if (event.type !== 'grok-x-search/request') return
    const data = event.data
    if (!TOOL_NAMES.has(data.tool)) fail(`grok-x-search/request names unknown tool "${data.tool}"`)
    if (data.route.provider !== 'grok-session') {
      fail(`grok-x-search/request routes to "${data.route.provider}" instead of grok-session`)
    }
    if (data.hostedTools.length !== 1 || data.hostedTools[0] !== 'x_search') {
      fail('grok-x-search/request must offer exactly the hosted x_search tool')
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
