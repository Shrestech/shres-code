import type {
  ConversationLocation, ConversationNodeContext,
} from '@shres-code/shres-code-client-runtime/client'
import type {
  TrajectoryContribution, TrajectoryConversationViewNode,
} from './trajectory-contract.ts'

/**
 * Turn and step one event's resolved Location names.
 * @param location - An event's resolved Location.
 * @returns The enclosing turn, and the enclosing step when the Location resolved inside one.
 */
export function trajectoryTurnStep(
  location: ConversationLocation,
): { turn?: number; step?: number } {
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

/**
 * Wrap one contribution in the Engine-owned target envelope.
 *
 * @param context - Context that owns the contribution identity.
 * @param anchorSeq - Sequence used to order the contribution.
 * @param data - Trajectory-specific contribution payload.
 * @returns The contribution wrapped as a Trajectory view node.
 */
export function trajectoryNode(
  context: ConversationNodeContext,
  anchorSeq: number,
  data: TrajectoryContribution,
): TrajectoryConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'trajectory',
    anchorSeq,
    location: context.start?.location ?? { kind: 'unresolved' },
    data,
  }
}
