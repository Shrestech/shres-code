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
import type { CallId } from '@shres-code/shres-code-llm'
import type { Session } from '@shres-code/shres-code-session'
import type {
  LogRunRequest,
  LogRunSpec,
  MachineRule,
  MetricPoint,
  RunFilter,
  TrackerDecisionRuleVerdict,
  TrackerRunId,
  TrackerRunRecord,
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
  MachineRule,
  MetricPoint,
  RunFilter,
  TrackerDecisionRuleVerdict,
  TrackerFailureReason,
  TrackerMetricsEvent,
  TrackerRunEvent,
  TrackerRunId,
  TrackerRunRecord,
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
   * Resolve one run by id from the provider's authoritative store (the landed
   * index and the spool), including its optional {@link MachineRule}.
   * @param runId - the run to resolve.
   * @returns the run record, or `undefined` when no run with that id is stored.
   */
  abstract getRun(runId: TrackerRunId): Promise<TrackerRunRecord | undefined>

  /**
   * Retrieve every logged metric point for one run, in append order.
   * @param runId - the run whose metrics to read.
   * @returns the run's logged metric points; empty when none are logged.
   */
  abstract getMetrics(runId: TrackerRunId): Promise<MetricPoint[]>

  /**
   * Log a run. Resolves and validates the request, allocates the run id,
   * delegates to the provider, and writes the log-only `tracker/run` event to
   * the owning session. The event is written after the provider returns, so
   * the log reflects the post outcome exactly as the caller received it.
   * @param session - owning session; the run event is appended to its log.
   * @param request - the caller's run request (validated and defaulted here).
   * @param callId - the tool-call id of the `experiment_log_run` call that produced the run.
   * @returns the post outcome with the allocated run id.
   */
  async logRun(session: Session, request: LogRunRequest, callId: CallId): Promise<TrackerRunResult> {
    const spec = resolveLogRun(request)
    const runId = newTrackerRunId()
    const result = await this.postRun(runId, spec)
    session.append('tracker/run', {
      runId,
      callId,
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

  /**
   * Mechanically re-execute a run's {@link MachineRule} against its logged
   * metrics. No LLM and no heuristics: the run is resolved by id, its rule is
   * compared against the latest append of the named metric, and the verdict is
   * a pure function of those stored values. A run with no machine rule, no
   * metrics, or without the named metric is refused with its reason — never
   * defaulted or guessed.
   * @param runId - the run whose decision rule to verify.
   * @returns the mechanical verdict: satisfied/unsatisfied with the rule and
   * observed value, or refused with the reason no verdict could be produced.
   */
  async verifyDecisionRule(runId: TrackerRunId): Promise<TrackerDecisionRuleVerdict> {
    const run = await this.getRun(runId)
    if (run === undefined) {
      return { status: 'refused', reason: 'run-not-found', detail: `no run with id ${runId}` }
    }
    const rule = run.machineRule
    if (rule === undefined) {
      return { status: 'refused', reason: 'no-machine-rule', detail: `run ${runId} logged no machine rule` }
    }
    const metrics = await this.getMetrics(runId)
    if (metrics.length === 0) {
      return { status: 'refused', reason: 'metrics-missing', detail: `run ${runId} has no logged metrics` }
    }
    const latest = latestForMetric(metrics, rule.metric)
    if (latest === undefined) {
      return { status: 'refused', reason: 'metric-not-in-run', detail: `metric ${rule.metric} not logged for run ${runId}` }
    }
    const satisfied = compareToThreshold(latest.value, rule.op, rule.threshold)
    return satisfied
      ? { status: 'satisfied', rule, actual: latest.value }
      : { status: 'unsatisfied', rule, actual: latest.value }
  }
}

/**
 * Find the latest append of a named metric in an append-ordered list.
 * @param metrics - the run's logged metric points in append order.
 * @param name - the metric name to find.
 * @returns the last point with that name, or `undefined` when none is logged.
 */
function latestForMetric(metrics: readonly MetricPoint[], name: string): MetricPoint | undefined {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const point = metrics[index]
    if (point?.name === name) return point
  }
  return undefined
}

/**
 * Apply a machine-rule operator to an observed value and threshold.
 * @param actual - the observed metric value.
 * @param op - the comparison operator.
 * @param threshold - the rule's threshold.
 * @returns whether the observed value satisfies the rule.
 */
function compareToThreshold(actual: number, op: MachineRule['op'], threshold: number): boolean {
  switch (op) {
    case '>': return actual > threshold
    case '>=': return actual >= threshold
    case '<': return actual < threshold
    case '<=': return actual <= threshold
    case '==': return actual === threshold
  }
}

export default TrackerService
