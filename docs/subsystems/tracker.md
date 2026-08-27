# Experiment Tracking

Types shared by `ctx.tracker`, the shrestech-tracker provider, and the model-facing experiment tools. The [package README](../../packages/tracker/README.md) owns composition; this page records the request/spec vocabulary, branded run id, provider-post failure taxonomy, and query summaries from [`packages/tracker/tracker/src/types.ts`](../../packages/tracker/tracker/src/types.ts).

`TrackerRunId` is a [branded id](core.md#branded-ids). The seam assigns every run an id before the provider posts it, including runs held in the local spool, so a `tracker/run` event and its spool entry always agree.

```ts type-equiv
/**
 * An opaque experiment-run id. Branded so a run id cannot be passed where
 * another string-bearing id is expected. Constructed by {@link newTrackerRunId};
 * the seam assigns every run an id, including runs that are spooled rather
 * than posted, so a `tracker/run` event and its spool entry always agree.
 */
type TrackerRunId = Branded<'TrackerRunId'>
```

```ts type-equiv
/**
 * Why a run post did not land. Provider results and spool entries carry the
 * reason so the model sees the distribution verbatim instead of a generic
 * failure.
 */
type TrackerFailureReason = 'auth' | 'unreachable' | 'quarantined-row' | 'spooled'
```

```ts type-equiv
/** One measured point attached to a run. */
interface MetricPoint {
  /** Metric name (for example `loss` or `val_bpb`). */
  readonly name: string
  /** Measured value. */
  readonly value: number
  /** Optional step or epoch the point was measured at. */
  readonly step?: number
}
```

`logRun` accepts a `LogRunRequest` and resolves it through `resolveLogRun(request): LogRunSpec`. That step rejects every required field (`experiment`, `decisionRule`, `dataVersion`, `gitSha`) that is absent or blank, and defaults `metrics`/`artifacts` to empty lists. Providers never re-default.

```ts type-equiv
/**
 * A caller's run REQUEST. `experiment`, `decisionRule`, `dataVersion`, and
 * `gitSha` are required and enforced by {@link
 * resolveLogRun}; `hypothesis` is a required string by type (the tool schema
 * and static interface enforce it) but not part of the four-field validation
 * contract. Optional `metrics`/`artifacts` are defaulted to empty by {@link
 * resolveLogRun}.
 */
interface LogRunRequest {
  /** Experiment or study this run belongs to. */
  readonly experiment: string
  /** The hypothesis under test. */
  readonly hypothesis: string
  /** The decision rule encoded in the API itself — a threshold change is a new experiment. */
  readonly decisionRule: string
  /** Data version the run used. */
  readonly dataVersion: string
  /** Git commit the run reproduced. */
  readonly gitSha: string
  /** Metrics recorded with the run. */
  readonly metrics?: readonly MetricPoint[]
  /** Artifact `modelstore://` URIs the run produced. */
  readonly artifacts?: readonly string[]
}
```

```ts type-equiv
/**
 * A fully resolved run spec: the {@link LogRunRequest} with `metrics` and
 * `artifacts` defaulted to empty lists. Handed to providers by {@link
 * resolveLogRun}; `run()` paths never re-default.
 */
interface LogRunSpec {
  readonly experiment: string
  readonly hypothesis: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  readonly metrics: readonly MetricPoint[]
  readonly artifacts: readonly string[]
}
```

```ts type-equiv
/**
 * A provider post outcome. Every run is assigned an id (offline posture is a
 * mode, not an error path); `spooled` runs carry the {@link TrackerFailureReason}
 * so the tool can surface why the post did not land.
 */
type TrackerRunResult =
  | { readonly kind: 'landed'; readonly runId: TrackerRunId }
  | { readonly kind: 'spooled'; readonly runId: TrackerRunId; readonly reason: TrackerFailureReason }
```

```ts type-equiv
/** Filters for {@link queryRuns}. Every field is optional; absent fields are not applied. */
interface RunFilter {
  /** Match runs for one experiment. */
  readonly experiment?: string
  /** Match runs against one git commit. */
  readonly gitSha?: string
  /** ISO-8601 timestamp; return runs on or after it. */
  readonly since?: string
}
```

```ts type-equiv
/** One run returned by {@link queryRuns}. `reason` is present only for spooled runs. */
interface TrackerRunSummary {
  readonly runId: TrackerRunId
  readonly experiment: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  /** Why the run has not landed, when it has not. */
  readonly reason?: TrackerFailureReason
}
```

`logRun`/`logMetrics` write the log-only, `ignorable` events `tracker/run` and `tracker/metrics`. A spooled run still carries its id in the event.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtracker--trackerservice-abstract-seam"></a>

### `ctx.tracker` — `TrackerService` (abstract seam)

The abstract experiment tracking service. Registered as `ctx.tracker` (one provider per context; loading a second throws cordis' standard duplicate-service behavior). A provider subclasses this, implements the three abstract persistence hooks, and loads the subclass as a plugin.

Implementations must honor these semantics:

- postRun persists the run or holds it in the durable local spool, returning a TrackerRunResult that carries the failure taxonomy when the post did not land. It never returns a bare id for a failed post.
- postMetrics persists a batched metric append for a run.
- queryRuns reads the provider's authoritative run store.

```ts cordis-catalog
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
 * @param callId - the tool-call id of the `experiment_log_run` call that produced the run.
 * @returns the post outcome with the allocated run id.
 */
async logRun(session: Session, request: LogRunRequest, callId: CallId): Promise<TrackerRunResult>

/**
 * Append metrics to a run's durable record and write the log-only
 * `tracker/metrics` event.
 * @param session - the owning session; the append is logged to it.
 * @param runId - the run the metrics belong to.
 * @param metrics - the metric points to append.
 */
async logMetrics(session: Session, runId: TrackerRunId, metrics: readonly MetricPoint[]): Promise<void>
```

Types: [CallId](llm-streaming.md) · [Session](session.md)

Source: [`packages/tracker/tracker/src/index.ts:64`](../../packages/tracker/tracker/src/index.ts)
<!-- END GENERATED cordis-surface -->
