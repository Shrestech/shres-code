/**
 * Pure types of the experiment tracking capability seam (`ctx.tracker`): the
 * run request/spec vocabulary, the branded run id, the provider-post failure
 * taxonomy, and the log-only `tracker/run` + `tracker/metrics` session events.
 * Free of host-side runtime imports.
 *
 * @module @shres-code/shres-code-tracker/types
 */

import type { Branded } from '@shres-code/shres-code-brand'
import type { CallId } from '@shres-code/shres-code-llm'

/**
 * An opaque experiment-run id. Branded so a run id cannot be passed where
 * another string-bearing id is expected. Constructed by {@link newTrackerRunId};
 * the seam assigns every run an id, including runs that are spooled rather
 * than posted, so a `tracker/run` event and its spool entry always agree.
 */
export type TrackerRunId = Branded<'TrackerRunId'>

/**
 * Why a run post did not land. Provider results and spool entries carry the
 * reason so the model sees the distribution verbatim instead of a generic
 * failure.
 */
export type TrackerFailureReason = 'auth' | 'unreachable' | 'quarantined-row' | 'spooled'

/** One measured point attached to a run. */
export interface MetricPoint {
  /** Metric name (for example `loss` or `val_bpb`). */
  readonly name: string
  /** Measured value. */
  readonly value: number
  /** Optional step or epoch the point was measured at. */
  readonly step?: number
}

/**
 * A machine-readable decision rule. When present on a run, {@link
 * verifyDecisionRule} re-executes it mechanically against the run's logged
 * metrics — never an LLM's judgment — so a "supported" verdict is reproducible.
 */
export interface MachineRule {
  /** The metric name the rule reads (for example `val_bpb`). */
  readonly metric: string
  /** The comparison operator applied to the metric's latest value. */
  readonly op: '>' | '>=' | '<' | '<=' | '=='
  /** The threshold the metric's latest value is compared against. */
  readonly threshold: number
}

/**
 * A caller's run REQUEST. `experiment`, `decisionRule`, `dataVersion`, and
 * `gitSha` are required and enforced by {@link
 * resolveLogRun}; `hypothesis` is a required string by type (the tool schema
 * and static interface enforce it) but not part of the four-field validation
 * contract. Optional `metrics`/`artifacts` are defaulted to empty by {@link
 * resolveLogRun}.
 */
export interface LogRunRequest {
  /** Experiment or study this run belongs to. */
  readonly experiment: string
  /** The hypothesis under test. */
  readonly hypothesis: string
  /** The decision rule encoded in the API itself — a threshold change is a new experiment. */
  readonly decisionRule: string
  /** Optional machine-readable decision rule; validated by {@link resolveLogRun} when present. */
  readonly machineRule?: MachineRule
  /** Data version the run used. */
  readonly dataVersion: string
  /** Git commit the run reproduced. */
  readonly gitSha: string
  /** Metrics recorded with the run. */
  readonly metrics?: readonly MetricPoint[]
  /** Artifact `modelstore://` URIs the run produced. */
  readonly artifacts?: readonly string[]
}

/**
 * A fully resolved run spec: the {@link LogRunRequest} with `metrics` and
 * `artifacts` defaulted to empty lists. Handed to providers by {@link
 * resolveLogRun}; `run()` paths never re-default.
 */
export interface LogRunSpec {
  readonly experiment: string
  readonly hypothesis: string
  readonly decisionRule: string
  readonly machineRule?: MachineRule
  readonly dataVersion: string
  readonly gitSha: string
  readonly metrics: readonly MetricPoint[]
  readonly artifacts: readonly string[]
}

/** Filters for {@link queryRuns}. Every field is optional; absent fields are not applied. */
export interface RunFilter {
  /** Match runs for one experiment. */
  readonly experiment?: string
  /** Match runs against one git commit. */
  readonly gitSha?: string
  /** ISO-8601 timestamp; return runs on or after it. */
  readonly since?: string
}

/** One run returned by {@link queryRuns}. `reason` is present only for spooled runs. */
export interface TrackerRunSummary {
  readonly runId: TrackerRunId
  readonly experiment: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  /** Why the run has not landed, when it has not. */
  readonly reason?: TrackerFailureReason
}

/**
 * One run resolved by id for {@link verifyDecisionRule}: the run's stored
 * fields plus its optional {@link MachineRule}. `reason` is present only for
 * spooled runs.
 */
export interface TrackerRunRecord {
  readonly runId: TrackerRunId
  readonly experiment: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  /** The run's machine-readable decision rule, when it logged one. */
  readonly machineRule?: MachineRule
  /** Why the run has not landed, when it has not. */
  readonly reason?: TrackerFailureReason
}

/**
 * The outcome of {@link verifyDecisionRule}: a mechanical re-execution of the
 * run's {@link MachineRule} against its logged metrics. `satisfied` and
 * `unsatisfied` carry the rule and the observed metric value; `refused` names
 * why no verdict could be produced (the fail-loud path — never a default or
 * guess).
 */
export type TrackerDecisionRuleVerdict =
  | { readonly status: 'satisfied'; readonly rule: MachineRule; readonly actual: number }
  | { readonly status: 'unsatisfied'; readonly rule: MachineRule; readonly actual: number }
  | {
    readonly status: 'refused'
    readonly reason: 'run-not-found' | 'no-machine-rule' | 'metrics-missing' | 'metric-not-in-run'
    readonly detail: string
  }

/**
 * A provider post outcome. Every run is assigned an id (offline posture is a
 * mode, not an error path); `spooled` runs carry the {@link TrackerFailureReason}
 * so the tool can surface why the post did not land.
 */
export type TrackerRunResult =
  | { readonly kind: 'landed'; readonly runId: TrackerRunId }
  | { readonly kind: 'spooled'; readonly runId: TrackerRunId; readonly reason: TrackerFailureReason }

/** Durable payload of the log-only `tracker/run` event. */
export interface TrackerRunEvent {
  readonly runId: TrackerRunId
  /** The tool-call id of the `experiment_log_run` call that produced the run. */
  readonly callId: CallId
  readonly experiment: string
  readonly decisionRule: string
  readonly gitSha: string
}

/** Durable payload of the log-only `tracker/metrics` event. */
export interface TrackerMetricsEvent {
  readonly runId: TrackerRunId
  readonly metrics: readonly MetricPoint[]
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * One run logged (or spooled) through `ctx.tracker`. Log-only. Writers pass
     * `{ ignorable: true }`.
     * @param runId - the run's id; identical to its spool entry id when spooled.
     * @param callId - the tool-call id of the `experiment_log_run` call that produced the run.
     * @param experiment - the experiment this run belongs to.
     * @param decisionRule - the run's decision rule.
     * @param gitSha - the git commit the run reproduced.
     */
    'tracker/run': TrackerRunEvent
    /**
     * One batched metric append for a run. Log-only. Writers pass
     * `{ ignorable: true }`.
     * @param runId - the run the metrics belong to.
     * @param metrics - the appended metric points.
     */
    'tracker/metrics': TrackerMetricsEvent
  }
}
