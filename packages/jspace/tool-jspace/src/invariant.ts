/**
 * Package-owned invariant companion for `@shres-code/shres-code-tool-jspace`.
 * Every `jspace/charter-run` `parentCallId` must match a `tool/call` for
 * `jspace_checkpoint`, `jspace_ship`, `jspace_open`, or `jspace_charter_amend`.
 * @module @shres-code/shres-code-tool-jspace/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'

const PACKAGE_NAME = '@shres-code/shres-code-tool-jspace'

const PARENT_TOOLS = new Set([
  'jspace_checkpoint',
  'jspace_ship',
  'jspace_open',
  'jspace_charter_amend',
])

/** Cordis companion plugin name. */
export const name = 'tool-jspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install a parent-call check over charter-run events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'jspace/charter-run') return
    const parent = event.data.parentCallId
    const call = session.events.find(item =>
      item.type === 'tool/call' && item.data.callId === parent && PARENT_TOOLS.has(item.data.name))
    if (call === undefined) {
      fail(`jspace/charter-run parentCallId ${JSON.stringify(parent)} is not a jspace checkpoint, ship, open, or charter_amend tool/call`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
