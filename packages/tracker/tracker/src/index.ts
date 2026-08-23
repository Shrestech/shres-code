/**
 * Service Definition for the experiment tracking capability seam (`ctx.tracker`):
 * the run/metrics/query service contract, the required-field logRun validation
 * and spec step, the provider-post failure taxonomy, and the log-only
 * `tracker/run` + `tracker/metrics` session events. Providers subclass
 * {@link TrackerService} and implement the three abstract persistence hooks;
 * the seam's concrete `logRun`/`logMetrics` own defaulting (via
 * {@link resolveLogRun}), id allocation, and event logging.
 *
 * @module @shres-code/shres-code-tracker
 */

import { Context, Service } from '@shres-code/cordis'
import type { Session } from '@shres-code/shres-code-session'
import type {
  LogRunRequest,
  LogRunSpec,
  MetricPoint,
  RunFilter,
  TrackerRunId,
  TrackerRunResult,
  TrackerRunSummary,
} from './types.ts'
import { newTrackerRunId, resolveLogRun } from './resolve.ts'

export {
  TrackerError,
  newTrackerRunId,
  resolveLogRun,
} from './resolve.ts'
export type {
  LogRunRequest,
  LogRunSpec,
  MetricPoint,
  RunFilter,
  TrackerFailureReason,
  TrackerMetricsEvent,
  TrackerRunEvent,
  TrackerRunId,
  TrackerRunResult,
  TrackerRunSummary,
} from './types.ts'

declare module '@shres-code/cordis' {
  interface Context {
    tracker: TrackerService
  }
}

/**
 * The abstract experiment tracking service. Registered as `ctx.tracker` (one
 * provider per context; loading a second throws cordis' standard
 * duplicate-service behavior). A provider subclasses this, implements the
 * three abstract persistence hooks, and loads the subclass as a plugin.
 *
 * Implementations must honor these semantics:
 * - {@link postRun} persists the run or holds it in the durable local spool,
 *   returning a {@link TrackerRunResult} that carries the failure taxonomy
 *   when the post did not land. It never returns a bare id for a failed post.
 * - {@link postMetrics} persists a batched metric append for a run.
 * - {@link queryRuns} reads the provider's authoritative run store.
 */
export abstract class TrackerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tracker')
  }

  /**
   * Persist (or spool) a run. Implemented by the provider; returns the post
   * outcome with the run's failure reason when it did not land.
   * @param runId - the id the seam allocated for this run.
   * @param spec - a resolved spec from {@link resolveLogRun}, never a raw request.
   * @returns the post outcome (landed, or spooled with a {@link TrackerFailureReason}).
   */
  abstract postRun(runId: TrackerRunId, spec: LogRunSpec): Promise<TrackerRunResult>

  /**
   * Persist a batched metric append for a run.
   * @param runId - the run the metrics belong to.
   * @param metrics - the metric points to persist.
   */
  abstract postMetrics(runId: TrackerRunId, metrics: readonly MetricPoint[]): Promise<void>

  /**
   * Query runs from the provider's authoritative store.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching run summaries.
   */
  abstract queryRuns(filter: RunFilter): Promise<TrackerRunSummary[]>

  /**
   * Log a run. Resolves and validates the request, allocates the run id,
   * delegates to the provider, and writes the log-only `tracker/run` event to
   * the owning session. The event is written after the provider returns, so
   * the log reflects the post outcome exactly as the caller received it.
   * @param session - owning session; the run event is appended to its log.
   * @param request - the caller's run request (validated and defaulted here).
   * @returns the post outcome with the allocated run id.
   */
  async logRun(session: Session, request: LogRunRequest): Promise<TrackerRunResult> {
    const spec = resolveLogRun(request)
    const runId = newTrackerRunId()
    const result = await this.postRun(runId, spec)
    session.append('tracker/run', {
      runId,
      experiment: spec.experiment,
      decisionRule: spec.decisionRule,
      gitSha: spec.gitSha,
    }, { ignorable: true })
    return result
  }

  /**
   * Append metrics to a run's durable record and write the log-only
   * `tracker/metrics` event.
   * @param session - the owning session; the append is logged to it.
   * @param runId - the run the metrics belong to.
   * @param metrics - the metric points to append.
   */
  async logMetrics(session: Session, runId: TrackerRunId, metrics: readonly MetricPoint[]): Promise<void> {
    await this.postMetrics(runId, metrics)
    session.append('tracker/metrics', { runId, metrics }, { ignorable: true })
  }
}

export default TrackerService
