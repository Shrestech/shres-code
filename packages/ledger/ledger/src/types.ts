/**
 * Pure types of the decision-ledger capability seam (`ctx.ledger`): the
 * decision request/spec vocabulary, the branded entry id, the validation
 * failure taxonomy, the durable entry record, and the log-only
 * `ledger/decision` session event. Free of host-side runtime imports.
 *
 * @module @shres-code/shres-code-ledger/types
 */

import type { Branded } from '@shres-code/shres-code-brand'
import type { CallId } from '@shres-code/shres-code-llm'
import type { TrackerRunId } from '@shres-code/shres-code-tracker'

/**
 * An opaque decision-ledger entry id. Branded so an entry id cannot be passed
 * where another string-bearing id is expected. Constructed by
 * {@link newLedgerEntryId}; the seam assigns every record an id, including
 * records that fail validation, so a `ledger/decision` event and its store
 * entry always agree.
 */
export type LedgerEntryId = Branded<'LedgerEntryId'>

/** The decision reached on a hypothesis. */
export type Decision = 'accepted' | 'rejected' | 'deferred'

/**
 * The evidence cited for a decision. `runIds` are experiment runs that must
 * resolve through the mounted tracker service; `artifactUris` are
 * `modelstore://` URIs.
 */
export interface LedgerEvidence {
  /** Experiment run ids cited as evidence. */
  readonly runIds: readonly TrackerRunId[]
  /** Git commit the evidence reproduced. */
  readonly gitSha?: string
  /** Artifact `modelstore://` URIs cited as evidence. */
  readonly artifactUris: readonly string[]
}

/**
 * A caller's decision REQUEST. `hypothesis`, `decision`, `evidence.runIds`,
 * and `rationale` are required and enforced by {@link resolveRecord};
 * `evidence.gitSha` and `evidence.artifactUris` are optional and defaulted by
 * {@link resolveRecord}.
 */
export interface LedgerRequest {
  /** The hypothesis the decision addresses. */
  readonly hypothesis: string
  /** The decision reached. */
  readonly decision: Decision
  /** The evidence cited for the decision. */
  readonly evidence: {
    readonly runIds: readonly TrackerRunId[]
    readonly gitSha?: string
    readonly artifactUris?: readonly string[]
  }
  /** Why the decision was reached. */
  readonly rationale: string
}

/**
 * A fully resolved decision spec: the {@link LedgerRequest} with
 * `evidence.artifactUris` defaulted to an empty list. Handed to providers by
 * {@link resolveRecord}; `run()` paths never re-default.
 */
export interface LedgerSpec {
  readonly hypothesis: string
  readonly decision: Decision
  readonly evidence: LedgerEvidence
  readonly rationale: string
}

/** Filters for {@link LedgerService.query}. Every field is optional; absent fields are not applied. */
export interface LedgerFilter {
  /** Match entries for one decision. */
  readonly decision?: Decision
  /** Match entries whose hypothesis contains this substring. */
  readonly hypothesisSubstring?: string
  /** Epoch milliseconds; return entries recorded on or after it. */
  readonly since?: number
}

/** One durable decision entry returned by {@link LedgerService.query}. */
export interface LedgerEntry {
  readonly entryId: LedgerEntryId
  readonly hypothesis: string
  readonly decision: Decision
  readonly evidence: LedgerEvidence
  readonly rationale: string
  /** Epoch milliseconds when the entry was recorded. */
  readonly recordedAt: number
}

/**
 * Why a decision record did not land. Validation failures and store failures
 * carry the reason so the model sees the distribution verbatim instead of a
 * generic failure.
 */
export type LedgerFailureReason =
  | 'required-field'
  | 'missing-run'
  | 'deferred-cites-runs'
  | 'unresolved-run'
  | 'unverified-run'
  | 'corrupt-store'

/**
 * A record outcome. Every record is assigned an id (validation failure is a
 * result, not an error path); a failed record carries the
 * {@link LedgerFailureReason} so the tool can surface why it did not land.
 */
export type LedgerRecordResult =
  | { readonly kind: 'recorded'; readonly entryId: LedgerEntryId }
  | { readonly kind: 'failed'; readonly entryId: LedgerEntryId; readonly reason: LedgerFailureReason }

/** Durable payload of the log-only `ledger/decision` event. */
export interface LedgerDecisionEvent {
  readonly entryId: LedgerEntryId
  readonly hypothesis: string
  readonly decision: Decision
  readonly runIds: readonly TrackerRunId[]
  /** The tool-call id of the `ledger_record_decision` call that produced the record. */
  readonly callId: CallId
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * One decision recorded through `ctx.ledger`. Log-only. Writers pass
     * `{ ignorable: true }`.
     * @param entryId - the entry's id; identical to its store entry id.
     * @param hypothesis - the hypothesis the decision addresses.
     * @param decision - the decision reached.
     * @param runIds - the experiment run ids cited as evidence.
     * @param callId - the tool-call id of the `ledger_record_decision` call that produced the record.
     */
    'ledger/decision': LedgerDecisionEvent
  }
}
