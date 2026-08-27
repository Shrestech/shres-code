/**
 * Request resolution for the tracker capability seam: the pure
 * `resolveLogRun(request): LogRunSpec` step that owns all defaulting and
 * required-field validation, plus the branded run-id factory. Providers and
 * the seam call these; `run()` paths never re-default.
 *
 * @module @shres-code/shres-code-tracker/resolve
 */

import { randomUUID } from 'node:crypto'
import type { LogRunRequest, LogRunSpec, TrackerRunId } from './types.ts'

/**
 * Typed error with a stable, machine-routable `code`. Used for the seam's
 * validation rejections; providers may reuse it for their own post failures.
 */
export class TrackerError extends Error {
  /**
   * @param message - human-readable reason.
   * @param code - stable machine code.
   */
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'TrackerError'
  }
}

/** Required run fields that must be non-blank strings. */
const REQUIRED_FIELDS: ReadonlyArray<keyof LogRunRequest> = [
  'experiment',
  'decisionRule',
  'dataVersion',
  'gitSha',
]

/**
 * Allocate a fresh branded run id. The seam assigns every run an id before
 * asking a provider to post it, so a landed run, a spool entry, and the
 * `tracker/run` event always agree.
 * @returns a new unique `TrackerRunId`.
 */
export function newTrackerRunId(): TrackerRunId {
  return `run-${randomUUID()}` as TrackerRunId
}

/**
 * Resolve a run request into a fully-specified spec: reject every required
 * field that is absent or blank with a named {@link TrackerError} (code
 * `TRACKER_REQUIRED_FIELD`), and default `metrics`/`artifacts` to empty
 * lists. String values are stored exactly as supplied once proven non-blank.
 * @param request - the caller's run request.
 * @returns the fully-specified spec, safe to hand to a provider.
 * @throws {@link TrackerError} naming the first missing required field.
 */
export function resolveLogRun(request: LogRunRequest): LogRunSpec {
  for (const field of REQUIRED_FIELDS) {
    const value = request[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TrackerError(
        `tracker logRun requires a non-empty ${field}`,
        'TRACKER_REQUIRED_FIELD',
      )
    }
  }
  return {
    experiment: request.experiment,
    hypothesis: request.hypothesis,
    decisionRule: request.decisionRule,
    dataVersion: request.dataVersion,
    gitSha: request.gitSha,
    metrics: request.metrics ?? [],
    artifacts: request.artifacts ?? [],
  }
}
