import type {
  AssistantMessageNode, ConversationLocation, ConversationNode,
  ConversationPromptSnapshot, ConversationViewNode, PartialAssistant,
  RequestPromptChange, RequestView, RunningToolCall, ToolCallBlock,
} from '@shres-code/shres-code-client-runtime/client'
import type { ShieldDecision } from '@shres-code/shres-code-shield/types'
// Type-only: the model-routing vocabulary and the SessionEventMap merge for
// model-routing/decision, from the router's client namespace.
import type { ModelRoutingDecision } from '@shres-code/shres-code-model-router/client'
import type { TrajectoryJSpaceBadge } from './trajectory-record.ts'

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution =
  | {
    readonly kind: 'node'
    readonly node: ConversationNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: PartialAssistant | null
    readonly request?: Extract<RequestView, { purpose: 'assistant' }>
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: TrajectoryRequestHeaderState
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<RequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
  }
  | {
    readonly kind: 'shield-decision'
    readonly decision: ShieldDecision
    readonly seq: number
  }
  | {
    readonly kind: 'routing'
    readonly decision: TrajectoryRoutingDecision
  }
  | {
    readonly kind: 'jspace'
    readonly badge: TrajectoryJSpaceBadge
  }

/** One folded Shield verdict attached to an existing Trajectory row. */
export interface TrajectoryShieldDecision extends ShieldDecision {
  /** Session-event seq that produced this verdict. */
  readonly seq: number
}

/**
 * One logged `model-routing/decision` as the Trajectory fold reads it: the
 * decision's own fields plus the seq and Location the event landed on.
 */
export type TrajectoryRoutingDecision = ModelRoutingDecision & {
  /** Session-event seq that logged the decision. */
  readonly seq: number
  /** Unix epoch milliseconds from the logging event. */
  readonly time: number
  /** Enclosing turn, when the event resolved to one. */
  readonly turn?: number
  /** Enclosing step, when the decision resolved inside one. */
  readonly step?: number
}

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
  readonly decisions: readonly TrajectoryShieldDecision[]
  /** Folded J-Space badges attached to existing Trajectory rows only. */
  readonly jspace: readonly TrajectoryJSpaceBadge[]
  /** Folded routing decisions, each rendering as its own row at its seq. */
  readonly routing: readonly TrajectoryRoutingDecision[]
}

declare module '@shres-code/shres-code-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}
