/**
 * Provider-local types for the shrestech-tracker Service Provider that are
 * not part of the seam vocabulary.
 *
 * @module @shres-code/shres-code-tracker-shrestech/types
 */

import type { TrackerRunId } from '@shres-code/shres-code-tracker'

/** Outcome of one {@link sync} drain. */
export interface SyncResult {
  /** Run ids the tracker accepted and that are now in the landed-run index. */
  readonly landedRunIds: readonly TrackerRunId[]
  /** Run ids that remain spooled (rejected by the server or unreachable). */
  readonly failedRunIds: readonly TrackerRunId[]
}
