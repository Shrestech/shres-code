/**
 * Pure vocabulary of the Jev-backed compaction provider: the two companion
 * log-only events this backend adds, their facts, and the degradation classes
 * every judgment-backed decision can fall back from.
 *
 * The shared `compaction/*` vocabulary is deliberately not extended: these two
 * events are backend-specific evidence for the bench and the UI, while
 * `compaction/start`, `compaction/summary`, and `compaction/end` stay the
 * backend-neutral transaction every provider shares. Both events are log-only
 * and append-only: they never appear on the model-visible surface, and a log
 * that knows no such type refuses it unless the envelope marks it ignorable.
 *
 * @module @shres-code/shres-code-compaction-jev/types
 */

import type { Branded } from '@shres-code/shres-code-brand'

/** Why a judgment-backed step fell back to the inherited compaction-basic behavior. */
export type CompactionDegradationReason =
  /** No judgment engine is composed. */
  | 'engine-absent'
  /** An engine is composed and the deployment turned judgment off. */
  | 'engine-disabled'
  /** The engine could not be reached, refused the ask, or did not answer in time. */
  | 'engine-unavailable'
  /** The engine answered with a body this provider could not use. */
  | 'invalid-answer'
  /** The engine answered below the configured confidence floor. */
  | 'below-confidence'

/** The trigger a selection ran under, mirroring the shared compaction vocabulary. */
export type CompactionSelectionTrigger = 'pressure' | 'context-overflow'

/** What became of one segment the selection considered. */
export type CompactionSegmentDisposition =
  /** Scored at or above the rescue floor with enough confidence: its span is compacted. */
  | 'rescued'
  /** Scored below the floor, or the rescue budget was spent: the segment survives verbatim. */
  | 'dropped'
  /**
   * Never scored: the segment was not asked about (chunking or budget), or the
   * engine returned no score answer for it while other segments in the same ask
   * were scored.
   */
  | 'unscored'

/** One segment fact of a selection decision. */
export interface CompactionSegmentFact {
  /** Inclusive first surface-node seq of the segment. */
  startSeq: number
  /** Inclusive last surface-node seq of the segment. */
  endSeq: number
  /** Load-bearingness score the engine returned, when the segment was scored. */
  score?: number
  /** Confidence of that score, when the segment was scored. */
  confidence?: number
  /** What the selection did with the segment. */
  disposition: CompactionSegmentDisposition
}

/** One boundary adjustment the selection made. */
export interface CompactionBoundaryAdjustment {
  /** Which sub-span edge moved. */
  edge: 'start' | 'end'
  /** Surface seq the edge held before the move. */
  fromSeq: number
  /** Surface seq the edge holds after the move. */
  toSeq: number
  /** The binary probability that made the original edge unsafe. */
  probability: number
}

/** One logged selection decision. */
export interface CompactionSelectionEvent {
  /** The trigger this selection ran under. */
  trigger: CompactionSelectionTrigger
  /** Whether the selection fell back to the inherited body. */
  degraded: boolean
  /** Which degradation class applied, when the selection degraded. */
  reason?: CompactionDegradationReason
  /** Segment facts, in surface order; empty when no scoring happened. */
  segments: CompactionSegmentFact[]
  /** Boundary moves, in the order they were made. */
  boundaryAdjustments: CompactionBoundaryAdjustment[]
  /** Engine that answered the selection asks, when one did. */
  engine?: string
  /** Exact model that answered, when one did. */
  model?: string
  /** Total duration of this selection's judgment calls, in milliseconds. */
  latencyMs?: number
}

/** One verify-battery answer fact. */
export interface CompactionVerificationQuestionFact {
  /** Battery entry name (`overall` for the score question). */
  name: string
  /** Binary probability, for a check entry. */
  probability?: number
  /** Score, for the `overall` entry. */
  score?: number
  /** Confidence the engine reported, when it reported one. */
  confidence?: number
}

/** What one verification attempt concluded. */
export type CompactionVerificationVerdict =
  /** Every check and the overall score passed: the draft is accepted. */
  | 'accepted'
  /** The draft failed and one escalation attempt remains. */
  | 'escalated'
  /** No escalation is spent on a band-only failure, or the budget is spent: the better draft is kept. */
  | 'accepted-below-threshold'

/** One logged verification attempt. */
export interface CompactionVerificationEvent {
  /** Compaction lifecycle this attempt belongs to. */
  compactionId: Branded<'CompactionId'>
  /**
   * 1-based index of the verification attempt within its compaction. Attempt 1
   * verifies the first draft; attempt 2 verifies the escalation draft.
   */
  attempt: number
  /** Provider route the verified draft was produced on. */
  provider: string
  /** Exact model the verified draft was produced on. */
  model: string
  /** Battery answers, `overall` last; empty when verification degraded. */
  questions: CompactionVerificationQuestionFact[]
  /** What the battery concluded. */
  verdict: CompactionVerificationVerdict
  /** Whether verification was skipped and the inherited summarizer used as-is. */
  degraded: boolean
  /** Which degradation class applied, when verification degraded. */
  reason?: CompactionDegradationReason
  /** Engine that answered the battery, when one did. */
  engine?: string
  /** Duration of this attempt's judgment call, in milliseconds. */
  latencyMs?: number
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * One semantic selection decision: log-only, append-only, and written once
     * per automatic compaction attempt before any summarization call. It records
     * what the selection considered, what it rescued, and how it moved the
     * sub-span edges, which is the evidence the bench reads.
     */
    'compaction/selection': CompactionSelectionEvent
    /**
     * One verify-cascade attempt: log-only, append-only, and written for every
     * verification of a draft, including the degraded case where the inherited
     * summarizer's output was accepted without a battery.
     */
    'compaction/verification': CompactionVerificationEvent
  }
}
