/** Shared trajectory record data and formatting contracts. */

import type { HTMLAttributes } from 'react'
import type { ConversationPromptSnapshot } from '@shres-code/shres-code-client-runtime/client'
import type {
  ModelRoutingBreakReason, ModelRoutingOutcome, ModelRoutingReason, ModelRoutingSelectionView,
} from '@shres-code/shres-code-model-router/client'

/** Closed set of trajectory record kinds. */
export type TrajectoryCellKind =
  | 'system'
  | 'user'
  | 'context'
  | 'compacted'
  | 'message'
  | 'tool'
  | 'subtool'
  | 'routing'

/** Recorded inputs needed to derive assistant TTFT and decode throughput. */
export interface AssistantMetricDetail {
  timingRecorded: boolean
  stepStartTime: number | null
  firstTokenTime: number | null
  completedTime: number | null
  usageProvided: boolean
  outputTokens: number | null
}

/** One source content block preserved in model order for the details panel. */
export interface TrajectorySourceBlock {
  type: string
  content: string
  /** Reasoning segments coalesced from adjacent reasoning blocks; present only on thinking entries. */
  segments?: readonly string[]
  imageSrc?: string
  imageAlt?: string
  callId?: string
  toolName?: string
}

/** Compact J-Space mutation painted on an existing Trajectory row. */
export interface TrajectoryJSpaceBadge {
  /** Card lifecycle shown as Open / Checkpoint / Closed. */
  kind: 'open' | 'checkpoint' | 'closed'
  /** Session-event seq that produced this badge. */
  seq: number
  /** Enclosing turn when the event carried one. */
  turn?: number
  /** Enclosing step when the event carried one. */
  step?: number
}

/** One downgraded streak's transition, as the decision that caused it records it. */
export type TrajectoryRoutingStreak =
  | {
    /** The decision entered a downgraded streak. */
    readonly kind: 'entered'
    /** Turn the streak was entered on. */
    readonly turn: number
  }
  | {
    /** The decision ended a downgraded streak. */
    readonly kind: 'exited'
    /** Why the streak ended. */
    readonly reason: ModelRoutingBreakReason
  }

/**
 * Routing facts one `model-routing/decision` renders on its own ledger row.
 *
 * A kept-strong decision that ended no streak changed nothing, so it carries no
 * route, confidence, or streak fact and renders as the quiet marker.
 */
export interface TrajectoryRoutingRow {
  /** What the consult resolved. */
  readonly outcome: ModelRoutingOutcome
  /** Why it resolved that way. */
  readonly reason: ModelRoutingReason
  /** Confidence of the route answer, when a judgment call produced one. */
  readonly confidence?: number
  /** Allowlisted route the decision selected; present on a downgrade only. */
  readonly selection?: ModelRoutingSelectionView
  /** Streak transition this decision caused, when it caused one. */
  readonly streak?: TrajectoryRoutingStreak
  /** Whether the decision changed nothing and renders as the quiet marker. */
  readonly quiet: boolean
  /**
   * Verdict a shadow consult simulated, when this row is one: whether live
   * would have switched, and to which model.
   */
  readonly shadow?: { readonly switched: boolean; readonly model?: string }
}

/** Effective route one request row reports, and whether routing moved it off the selection. */
export interface TrajectoryRequestRoute {
  /** Registered provider route the request ran on. */
  readonly provider: string
  /** Provider-owned model id the request ran on. */
  readonly model: string
  /** Whether the effective route differs from the sticky session selection in force. */
  readonly routed: boolean
}

/** Compact Shield verdict painted on a user, context, tool, or subtool row. */
export interface TrajectoryShieldBadge {
  /** Outcome shown as Blocked / Asked / Observed. */
  verdict: 'observe' | 'ask' | 'deny'
  /** Rule id that fired. */
  rule: string
  /** Screened channel. */
  channel: string
  /** First 16 hex chars of the content digest. */
  sha16: string
  /** Registrable host when the finding names one. */
  host?: string
}

/** Data and optional presentation attributes for one trajectory record. */
export interface TrajectoryCellProps extends HTMLAttributes<HTMLDivElement> {
  /** 1-based record index shown as `#N`. */
  index: number
  /** Projection-stable identity when no single source event owns the record lifecycle. */
  recordId?: string
  kind: TrajectoryCellKind
  /** Non-Markdown summary or prefix; CSS ellipsis when it overflows. */
  text: string
  /** Raw Markdown source converted into the single-line summary at its consumer. */
  previewMarkdown?: string
  /** Whether this user record opens a new model turn. */
  opensTurn?: boolean
  /** Source session-event seq for cross-record navigation. */
  sourceSeq?: number
  /** Producer role and name from a user-role message or context injection. */
  messageSource?: unknown
  /** Producer-owned model-hidden metadata carried beside the message source. */
  /** A separator-only anchor for an auxiliary request with no visible record. */
  requestOnly?: boolean
  /** Full request/message content for the details panel. */
  inputDetail?: string
  /** Complete system-prompt/tool-catalog state introduced by a SYSTEM record. */
  promptDetail?: ConversationPromptSnapshot
  /** System-prompt/tool-catalog state replaced by a SYSTEM update. */
  previousPromptDetail?: ConversationPromptSnapshot
  /** Full assistant/tool result content for the details panel. */
  outputDetail?: string
  /** Full assistant reasoning content for the details panel. */
  thinkingDetail?: string
  /** Original message blocks in source order for the details panel. */
  sourceBlocks?: readonly TrajectorySourceBlock[]
  /** Original tool result blocks in source order for the details panel. */
  outputBlocks?: readonly TrajectorySourceBlock[]
  /** Call-time model-visible tool schema for the details panel. */
  schemaDetail?: string
  /** Assistant-only timing and token facts for the details panel. */
  assistantMetrics?: AssistantMetricDetail
  /** Tool-only result summary paired with the call in the same record. */
  result?: string
  /** Raw Markdown source converted into the tool-result summary at its consumer. */
  resultPreviewMarkdown?: string
  /** Tool call id used to link message source blocks to tool records. */
  callId?: string
  /** Tool-only result failure state. */
  isError?: boolean
  /** Own duration in seconds, or `null` when no duration is known. */
  timeSeconds: number | null
  /** Unix epoch milliseconds when this operation actually started, when known. */
  startedAt?: number | null
  /** Compact Shield verdict copied onto this existing row. Never creates a row. */
  shield?: TrajectoryShieldBadge
  /** Compact J-Space badge copied onto this existing row. Never creates a row. */
  jspace?: TrajectoryJSpaceBadge
  /** Routing facts of the decision this ROUTING row renders. */
  routing?: TrajectoryRoutingRow
  /** Message-only prompt token count. */
  input?: number
  /** Message-only input tokens served from a provider cache. */
  cacheRead?: number
  /** Message-only input tokens written into a provider cache. */
  cacheWrite?: number
  /** Message-only completion token count. */
  output?: number
  /** Message-only reasoning token count. */
  think?: number
  /** Whether the legacy standalone cell renders its selection treatment. */
  selected?: boolean
}

/**
 * Resolve the identity that survives prepending older projected records.
 * @param cell - Projected trajectory record.
 * @returns Stable identity from the owning event or tool call, with a fixture fallback.
 */
export function trajectoryRecordId(cell: TrajectoryCellProps): string {
  if (cell.recordId !== undefined) return cell.recordId
  if (cell.callId !== undefined) return `${cell.kind}\u0000call\u0000${cell.callId}`
  if (cell.sourceSeq !== undefined) return `${cell.kind}\u0000seq\u0000${cell.sourceSeq}`
  return `${cell.kind}\u0000index\u0000${cell.index}`
}

/**
 * Format a duration in milliseconds with thousands separators.
 * @param milliseconds - Duration in milliseconds, or `null` when absent.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
export function formatDurationMillis(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—'
  const integer = String(Math.round(milliseconds))
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ms`
}

/**
 * Format an elapsed duration given in seconds as a millisecond label.
 * @param seconds - Duration seconds, or `null` when absent.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
export function formatElapsedSeconds(seconds: number | null): string {
  return formatDurationMillis(seconds === null ? null : seconds * 1000)
}
