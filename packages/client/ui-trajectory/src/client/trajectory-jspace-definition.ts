import type { Context } from '@shres-code/cordis'
import type {
  ConversationLocation, ConversationNodeDefinition, ConversationPreviousContext,
} from '@shres-code/shres-code-client-runtime/client'
// Type-only: SessionEventMap merge for jspace/card and jspace/closed.
import type { JspaceCard } from '@shres-code/shres-code-jspace/client'
import { trajectoryNode } from './trajectory-definition-common.ts'
import type { TrajectoryJSpaceBadge } from './trajectory-record.ts'

/** Folded card facts used to classify the next native event. */
interface JSpaceTrajectoryState {
  readonly kind: TrajectoryJSpaceBadge['kind'] | 'note'
  readonly seq: number
  readonly checkedCount: number
  readonly turn?: number
  readonly step?: number
}

function locationTurnStep(location: ConversationLocation): Pick<JSpaceTrajectoryState, 'turn' | 'step'> {
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

function classifyCard(
  card: JspaceCard,
  previous: ConversationPreviousContext<JSpaceTrajectoryState> | undefined,
): TrajectoryJSpaceBadge['kind'] | 'note' {
  if (previous === undefined || previous.state.kind === 'closed') return 'open'
  if (card.checked.length > previous.state.checkedCount) return 'checkpoint'
  return 'note'
}

const trajectoryJSpaceDefinition: ConversationNodeDefinition<JSpaceTrajectoryState> = {
  kind: 'trajectory-jspace',
  target: 'trajectory',
  match: event => event.type === 'jspace/card' || event.type === 'jspace/closed'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    const loc = locationTurnStep(match.location)
    if (match.event.type === 'jspace/closed') {
      return { kind: 'closed', seq: match.event.seq, checkedCount: 0, ...loc }
    }
    if (match.event.type !== 'jspace/card') {
      throw new Error('trajectory-jspace start requires jspace/card or jspace/closed')
    }
    const previous = reader.previous<JSpaceTrajectoryState>('trajectory-jspace')
    return {
      kind: classifyCard(match.event.data, previous),
      seq: match.event.seq,
      checkedCount: match.event.data.checked.length,
      ...loc,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.start === undefined || context.state === undefined) return null
    if (context.state.kind === 'note') return null
    return trajectoryNode(context, context.start.event.seq, {
      kind: 'jspace',
      badge: {
        kind: context.state.kind,
        seq: context.state.seq,
        ...(context.state.turn === undefined ? {} : { turn: context.state.turn }),
        ...(context.state.step === undefined ? {} : { step: context.state.step }),
      },
    })
  },
}

/**
 * Register Trajectory folding for `jspace/card` and `jspace/closed`.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryJSpaceDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryJSpaceDefinition)
}
