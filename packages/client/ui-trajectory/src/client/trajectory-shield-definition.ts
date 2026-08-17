import type { Context } from '@shres-code/cordis'
import type { ConversationNodeDefinition } from '@shres-code/shres-code-client-runtime/client'
import type { ShieldDecision } from '@shres-code/shres-code-shield/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

const trajectoryShieldDefinition: ConversationNodeDefinition<ShieldDecision> = {
  kind: 'trajectory-shield-decision',
  target: 'trajectory',
  match: event => event.type === 'shield/decision'
    ? { id: event.data.callId ?? String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'shield/decision') {
      throw new Error('trajectory-shield-decision start requires shield/decision')
    }
    return match.event.data
  },
  update: context => context.state,
  buildViewNode: context => trajectoryNode(context, context.start.event.seq, {
    kind: 'shield-decision',
    decision: context.state,
    seq: context.start.event.seq,
  }),
}

/**
 * Register Trajectory folding for `shield/decision` session events.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryShieldDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryShieldDefinition)
}
