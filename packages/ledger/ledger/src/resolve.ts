/**
 * Request resolution for the decision-ledger capability seam: the pure
 * `resolveRecord(request): LedgerSpec` step that owns all defaulting and
 * validation, plus the branded entry-id factory. Providers and the seam call
 * these; `run()` paths never re-default.
 *
 * @module @shres-code/shres-code-ledger/resolve
 */

import { randomUUID } from 'node:crypto'
import type { LedgerEntryId, LedgerFailureReason, LedgerRequest, LedgerSpec } from './types.ts'

/**
 * Typed error with a stable, machine-routable `code`. Used for the seam's
 * validation rejections; the store reuses it for corrupt-line failures.
 */
export class LedgerError extends Error {
  /**
   * @param message - human-readable reason.
   * @param code - stable machine code.
   */
  constructor(
    message: string,
    readonly code: LedgerFailureReason,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

/**
 * Allocate a fresh branded entry id. The seam assigns every record an id
 * before validating or persisting it, so a recorded entry, a failed record,
 * and the `ledger/decision` event always agree.
 * @returns a new unique `LedgerEntryId`.
 */
export function newLedgerEntryId(): LedgerEntryId {
  return `entry-${randomUUID()}` as LedgerEntryId
}

/**
 * Resolve a decision request into a fully-specified spec: reject a blank
 * `hypothesis` or `rationale` with a named {@link LedgerError} (code
 * `required-field`), reject an `accepted`/`rejected` decision that cites no
 * run id (`missing-run`), reject a `deferred` decision that cites any run id
 * (`deferred-cites-runs`), reject an artifact uri that does not start with
 * `modelstore://` (`invalid-artifact-uri`), and default `evidence.artifactUris`
 * to an empty list. String values are stored exactly as supplied once proven
 * non-blank.
 * @param request - the caller's decision request.
 * @returns the fully-specified spec, safe to hand to a provider.
 * @throws {@link LedgerError} naming the first violated rule.
 */
export function resolveRecord(request: LedgerRequest): LedgerSpec {
  if (typeof request.hypothesis !== 'string' || request.hypothesis.trim().length === 0) {
    throw new LedgerError('ledger record requires a non-empty hypothesis', 'required-field')
  }
  if (typeof request.rationale !== 'string' || request.rationale.trim().length === 0) {
    throw new LedgerError('ledger record requires a non-empty rationale', 'required-field')
  }
  const runIds = request.evidence.runIds
  if (request.decision === 'deferred') {
    if (runIds.length > 0) {
      throw new LedgerError('ledger record deferred decision must not cite run ids', 'deferred-cites-runs')
    }
  } else if (runIds.length === 0) {
    throw new LedgerError('ledger record accepted/rejected decision requires at least one run id', 'missing-run')
  }
  const artifactUris = request.evidence.artifactUris ?? []
  for (const uri of artifactUris) {
    if (!uri.startsWith('modelstore://')) {
      throw new LedgerError(`ledger record artifact uri must start with modelstore://, got ${uri}`, 'invalid-artifact-uri')
    }
  }
  return {
    hypothesis: request.hypothesis,
    decision: request.decision,
    evidence: {
      runIds,
      ...request.evidence.gitSha !== undefined ? { gitSha: request.evidence.gitSha } : {},
      artifactUris,
    },
    rationale: request.rationale,
  }
}
