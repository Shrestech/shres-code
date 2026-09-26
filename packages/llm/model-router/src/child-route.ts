/**
 * Parent-side child-route listener: policy match, spawn-time decision, and
 * shadow/off handling. Outcomes and the per-candidate breaker live beside this
 * module's classification helpers.
 *
 * @module @shres-code/shres-code-model-router/child-route
 */

import { selectionInForce } from '@shres-code/shres-code-agent'
import type { Agent } from '@shres-code/shres-code-agent'
import type { Session } from '@shres-code/shres-code-session'
import type { SubagentChildRoute, SubagentChildRouteRequest } from '@shres-code/shres-code-subagent'
import type { ResolvedModelRouterConfig } from './config.ts'
import type { ModelRoutingCandidate, ModelRoutingChildDecision, ModelRoutingChildPolicy, ModelRoutingMode } from './types.ts'

/** Inputs one child-route consult needs from the controller. */
export interface ChildRouteConsult {
  /** Resolved router configuration. */
  readonly config: ResolvedModelRouterConfig
  /** Parent routing mode in force. */
  readonly mode: ModelRoutingMode
  /** Candidate ids currently suspended by consecutive failures. */
  readonly suspended: ReadonlySet<string>
}

/**
 * First matching child-policy rule, or undefined when none match.
 * @param policies - ordered rules.
 * @param request - the waterfall request.
 * @returns the matching rule and its index.
 */
export function matchChildPolicy(
  policies: readonly ModelRoutingChildPolicy[],
  request: SubagentChildRouteRequest,
): { readonly policy: ModelRoutingChildPolicy; readonly index: number } | undefined {
  for (const [index, policy] of policies.entries()) {
    if (policy.match.kind !== undefined && policy.match.kind !== request.kind) continue
    if (policy.match.agentType !== undefined && policy.match.agentType !== request.agentType) continue
    return { policy, index }
  }
  return undefined
}

/**
 * Resolve one child-route consult after `next()` returned no answer.
 * Off writes nothing. No match writes nothing. Shadow logs and returns
 * undefined. On returns the pool route only for a `routed` decision.
 * @param consult - mode, config, and breaker state.
 * @param request - the waterfall request.
 * @returns the route to return, the decision to log, or neither.
 */
export function resolveChildRouteConsult(
  consult: ChildRouteConsult,
  request: SubagentChildRouteRequest,
): {
  readonly route?: SubagentChildRoute
  readonly decision?: ModelRoutingChildDecision
  readonly pendingJudge?: true
  readonly candidate?: ModelRoutingCandidate
  readonly common?: Omit<ModelRoutingChildDecision, 'outcome' | 'reason' | 'selection'>
  readonly keep?: (reason: ModelRoutingChildDecision['reason']) => { decision: ModelRoutingChildDecision }
} {
  if (consult.mode === 'off') return {}
  const matched = matchChildPolicy(consult.config.childPolicies, request)
  if (matched === undefined) return {}
  const parent = request.parent
  const base = selectionInForce(parent) ?? {
    ...parent.options.provider !== undefined ? { provider: parent.options.provider } : {},
    ...parent.options.model !== undefined ? { model: parent.options.model } : {},
  }
  const listed = consult.config.routeFrom.some(entry => entry.provider === base.provider && entry.model === base.model)
  const objective = consult.config.routeFrom.find(entry => entry.provider === base.provider && entry.model === base.model)?.objective
  const candidate = consult.config.candidates.find(entry => entry.id === matched.policy.candidate)
  /* v8 ignore next -- resolveConfig already refused unknown pool ids. */
  if (candidate === undefined) return {}
  const inherited = {
    ...request.inherited.provider !== undefined ? { provider: request.inherited.provider } : {},
    ...request.inherited.model !== undefined ? { model: request.inherited.model } : {},
  }
  const common = {
    routeRequestId: request.routeRequestId,
    childKind: request.kind,
    ...request.agentType === undefined ? {} : { agentType: request.agentType },
    policyIndex: matched.index,
    inherited,
    effortApplied: false as const,
    promptChars: request.prompt.length,
    ...objective === undefined ? {} : { objective },
    ...consult.mode === 'shadow' ? { shadow: true as const } : {},
  }
  const keep = (reason: ModelRoutingChildDecision['reason']): { decision: ModelRoutingChildDecision } => ({
    decision: { outcome: 'kept', reason, ...common },
  })
  if (!listed) return keep('base-unlisted')
  if (consult.suspended.has(candidate.id)) return keep('child-route-errors')
  if (candidate.provider === base.provider && candidate.model === base.model) return keep('candidate-equals-base')
  if (matched.policy.judge) {
    return { pendingJudge: true, candidate, common, keep }
  }
  const decision: ModelRoutingChildDecision = {
    outcome: 'routed',
    reason: 'child-policy',
    ...common,
    selection: { candidateId: candidate.id, provider: candidate.provider, model: candidate.model },
  }
  if (consult.mode === 'shadow') return { decision }
  return { route: { provider: candidate.provider, model: candidate.model }, decision }
}

/**
 * Append a child-decision to the parent log when one was produced.
 * @param session - the delegating parent session.
 * @param decision - the consult result.
 */
export function logChildDecision(session: Session, decision: ModelRoutingChildDecision): void {
  session.append('model-routing/child-decision', decision)
}

/**
 * Whether an agent is a live parent this controller should consult for.
 * @param agent - the waterfall parent.
 */
export function isChildRouteParent(agent: Agent): boolean {
  return typeof agent.session?.append === 'function'
}
