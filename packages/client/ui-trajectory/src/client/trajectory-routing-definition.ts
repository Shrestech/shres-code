import type { Context } from '@shres-code/cordis'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeDefinition,
} from '@shres-code/shres-code-client-runtime/client'
// Type-only: the SessionEventMap merge for model-routing/decision, from the
// router's client namespace (client code imports only that namespace).
import type {} from '@shres-code/shres-code-model-router/client'
import type { TrajectoryRoutingDecision } from './trajectory-contract.ts'
import { trajectoryNode, trajectoryTurnStep } from './trajectory-definition-common.ts'

function routingDecision(
  match: ConversationMatch,
  location: ConversationLocation,
): TrajectoryRoutingDecision {
  if (match.event.type !== 'model-routing/decision') {
    throw new Error('trajectory-routing-decision start requires model-routing/decision')
  }
  return {
    ...match.event.data,
    seq: match.event.seq,
    time: match.event.time,
    ...trajectoryTurnStep(location),
  }
}

/**
 * Trajectory folding for `model-routing/decision`: one row per logged decision,
 * anchored at the seq it was logged so the transcript reads in log order.
 */
const trajectoryRoutingDefinition: ConversationNodeDefinition<TrajectoryRoutingDecision> = {
  kind: 'trajectory-routing',
  target: 'trajectory',
  match: event => event.type === 'model-routing/decision'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => routingDecision(match, match.location),
  update: context => context.state,
  buildViewNode: context => context.start === undefined || context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'routing',
      decision: context.state,
    }),
}

/**
 * Register Trajectory folding for `model-routing/decision` session events.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
const trajectoryChildRoutingDefinition: ConversationNodeDefinition<{
  seq: number
  time: number
  outcome: 'routed' | 'kept'
  reason: string
  model?: string
  shadow?: true
}> = {
  kind: 'trajectory-routing-child',
  target: 'trajectory',
  match: event => event.type === 'model-routing/child-decision'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'model-routing/child-decision') {
      throw new Error('trajectory-routing-child start requires model-routing/child-decision')
    }
    const data = match.event.data
    return {
      seq: match.event.seq,
      time: match.event.time,
      outcome: data.outcome,
      reason: data.reason,
      ...data.selection === undefined ? {} : { model: `${data.selection.provider}/${data.selection.model}` },
      ...data.shadow === true ? { shadow: true as const } : {},
    }
  },
  update: context => context.state,
  buildViewNode: context => context.start === undefined || context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'routing-child',
      ...context.state,
    }),
}

export function registerTrajectoryRoutingDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryRoutingDefinition)
  ctx.conversationEvents.register(trajectoryChildRoutingDefinition)
}
