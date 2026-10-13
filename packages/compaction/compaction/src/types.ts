/**
 * Compaction vocabulary: the result type and the `compaction/*` session events.
 * Those declaration-merged events record the lock and summary inputs without entering the surface, so they are not
 * surface events; a separate replacement `user/message` carries the summary.
 * Backend packages own configuration and retention policy; see
 * `
 * @module @shres-code/shres-code-compaction/types
 */

import type { ContentBlock, TokenUsage } from '@shres-code/shres-code-llm'
import type { CommandId } from '@shres-code/shres-code-commands/brand'
import type { CompactionId } from './brand.ts'

export type { CompactionId }

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * Marks the start of a compaction — log-only, holds the lock until
     * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
     * `null` identifies a standalone manual transaction between turns.
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
    /**
     * Completed summary, its inputs, and its model call facts — log-only, no surfaceOp.
     * The summary content is in `data.summary`; the actual surface replacement
     * is performed by the immediately following `user/message` event that
     * shadows the compacted range. That adjacency is contractual — the
     * shadowed pricing fields are the replacement's shadow price, so a
     * consumer may pair a replacement with the metering event directly
     * before it (`compaction/prune` documents the shared protocol). When the
     * basic backend appends seq-pointer lines, they are extra text blocks in
     * `summary` and therefore on that replacement message.
     */
    'compaction/summary': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      summary: ContentBlock[]
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
      /** The provider route that wrote the summary. */
      provider: string
      /**
       * The model that wrote the summary — the summarize call's envelope,
       * reported by the backend that made the call, logged so the one-shot
       * request is reconstructable from log + code and "which model wrote
       * this summary" has a durable answer.
       */
      model: string
      /** The generation cap the summarize call sent, when one applied. */
      maxTokens?: number
      /** Provider-reported token usage for the summarization request, when emitted. */
      usage?: TokenUsage
    } & (
      | {
        /** Complete provider output before the backend's safe summary projection. */
        rawOutput: ContentBlock[]
        /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
        llmStreamCall: true
      }
      | {
        /** Optional complete output from an unmarked template, remote, or other summarizer. */
        rawOutput?: ContentBlock[]
        /** An unmarked summary does not identify a call through this context's LLM seam. */
        llmStreamCall?: never
      }
    )
    /**
     * Marks the end of a compaction — log-only, releases the lock. Its owner
     * matches `compaction/start`; `error` records an unsuccessful attempt.
     */
    'compaction/end': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      turn: number | null
      error?: string
      /**
       * Structured facts about the summarization call that failed the attempt,
       * present only when one did. `error` stays the human-facing chain; these
       * are the fields a reader needs to tell an adapter failure from a
       * provider-side overflow, or a truncation from a transport drop, without
       * inferring them from prose.
       */
      failure?: CompactionFailureFacts
    }
    /**
     * Shadow price of one model-free prune replacement — log-only, no
     * surfaceOp. The shared shadow-price protocol: a surface `replace` event
     * is priced by the metering event immediately before it (`compaction/summary`
     * for a summarizing compaction, this event for a prune), which states the
     * heuristic token price of the exact replaced range so a pure consumer
     * can subtract it without retaining per-node prices. The replacement MUST
     * be appended synchronously right after this event.
     */
    'compaction/prune': {
      /** The replaced range's first and last surface-node seqs (a surface-position span, like {@link CompactionResult.shadowedRange}). */
      shadowedRange: { start: number; end: number }
      /** The seqs of all shadowed surface nodes, in surface order. */
      shadowedSeqs: number[]
      /** Heuristic price of the shadowed content under the token-meter's fixed estimator. */
      shadowedTokenCount: number
    }
  }
}

/** Terminal harness finish kinds a summarization call can fail with. */
export type SummarizationFailureReason = 'error' | 'aborted' | 'max-tokens'

/**
 * Facts about the summarization call that failed one compaction attempt.
 *
 * Recorded on `compaction/end` so a failed attempt is diagnosable from the log
 * alone: which route was asked, what it reported consuming, how the stream
 * ended, and which attempt died. Absent when the failure happened before a
 * summarization call was made or came from the commit stage.
 */
export interface CompactionFailureFacts {
  /** Provider route the summarization call was dispatched to. */
  provider: string
  /** Model the summarization call was dispatched to. */
  model: string
  /** Provider-reported usage for the failed call, when the stream emitted any. */
  usage?: TokenUsage
  /** Terminal finish kind that failed the attempt. */
  reason: SummarizationFailureReason
  /** Failure code carried by that finish, absent when it carried none. */
  code?: string
  /** 1-based index of this attempt within the compaction. */
  attempt: number
}

/** Result of a successful compaction operation. */
export interface CompactionResult {
  /** Stable identity shared by this compaction's complete durable lifecycle. */
  compactionId: CompactionId
  /** Human command that initiated this compaction, when it was manual. */
  sourceCommandId?: CommandId
  /** The seq of the appended `compaction/start` event. */
  startSeq: number
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: number
  /** The seq of the appended `compaction/end` event. */
  endSeq: number
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: number; end: number }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
