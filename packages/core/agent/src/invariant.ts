/** Package-owned agent lifecycle invariants. @module @shres-code/shres-code-agent/invariant */

import type { Context } from '@shres-code/cordis'
import type { InvariantFailure, InvariantInstaller } from '@shres-code/shres-code-invariants'
import type { Agent, AgentStatus } from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-agent/types'
import type { Session, SessionEvent, SessionEventMap } from '@shres-code/shres-code-session'

const PACKAGE_NAME = '@shres-code/shres-code-agent'

/** Cordis companion plugin name. */
export const name = 'agent-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * Install the agent contribution into its child registration fiber: an agent's
 * status never repeats, and every `agent/route-base` names two routes that
 * differ in provider, model, or effort, each with a nonempty provider and
 * model. The route-base check runs on `internal/dispatch` before publication,
 * so a record that breaks it fails the `session.append` that writes it.
 */
const install: InvariantInstaller = (ctx, fail) => {
  const lastStatus = new WeakMap<Agent, AgentStatus>()
  ctx.on('agent/status', ({ agent, status }) => {
    const previous = lastStatus.get(agent)
    if (previous === status) {
      fail(`agent/status repeated ${status} (no-op transition)`)
    }
    lastStatus.set(agent, status)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type === 'agent/route-base') checkRouteBase(event.data, fail)
  }, { global: true })
}

/**
 * Require one `agent/route-base` to name two different complete routes.
 * @param record - the record being appended.
 * @param fail - the reporter that rejects the append.
 */
function checkRouteBase(record: SessionEventMap['agent/route-base'], fail: InvariantFailure): void {
  const { manual, routed } = record
  for (const [field, route] of [['manual', manual], ['routed', routed]] as const) {
    if (route.provider.trim().length === 0 || route.model.trim().length === 0) {
      fail(`agent/route-base ${field} needs a nonempty provider and model`)
    }
  }
  if (manual.provider === routed.provider && manual.model === routed.model && manual.reasoningEffort === routed.reasoningEffort) {
    fail('agent/route-base names the same route as manual and routed')
  }
}

/**
 * Register the agent invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
