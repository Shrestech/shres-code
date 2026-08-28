/**
 * Package-owned invariant companion for the research protocol: every
 * design-defense denial must cite tools the epoch walk independently
 * confirms have no completed non-error call.
 * @module @shres-code/shres-code-research-protocol/invariant
 */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Session } from '@shres-code/shres-code-session'
import { completedDebateCalls, DESIGN_DEFENSE_DENY_PREFIX } from './epoch.ts'

const PACKAGE_NAME = '@shres-code/shres-code-research-protocol'

/** Cordis companion plugin name. */
export const name = 'research-protocol-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Extract the cited tool names from a design-defense refusal.
 * @param reason - the refusal text.
 * @returns the cited tool names.
 */
function citedTools(reason: string): string[] {
  const list = reason.slice(reason.indexOf(': completed calls missing for: ')
    + ': completed calls missing for: '.length)
  return list.split(',').map(name => name.trim()).filter(name => name.length > 0)
}

/** Epoch anchor shared with the gate: card anchor when jspace is active, else session start. */
function anchorFor(ctx: Context, session: Session): number {
  const jspace = ctx.get('jspace')
  if (jspace === undefined || !jspace.status.active) return 0
  return jspace.card(session)?.goalOpenedSeq ?? 0
}

/**
 * Install a global observer that re-walks the log behind every
 * design-defense denial the gate emits.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'deny') return decision
    if (!decision.reason.startsWith(DESIGN_DEFENSE_DENY_PREFIX)) return decision
    const session = exec.agent?.session
    if (session === undefined) {
      fail('design-defense deny ran without a session, so its epoch evidence cannot exist')
      return decision
    }
    const anchor = anchorFor(ctx, session)
    for (const tool of citedTools(decision.reason)) {
      if (completedDebateCalls(session.events, [tool], anchor).size > 0) {
        fail(`design-defense deny cites ${tool}, which holds a completed non-error call at or after the epoch anchor`)
      }
    }
    return decision
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
