/**
 * shrestech-tracker Service Provider for the experiment tracking seam
 * (`ctx.tracker`). The provider is offline-first: a run with no credential
 * reference is spool-only (never an error), and a run that cannot reach the
 * live transport is held with its failure-taxonomy reason. Live HTTP posts a
 * run to `POST /api/runs`; `sync` drains the spool through `POST /api/sync`,
 * and a derived landed-run index lets `queryRuns` answer without a network
 * round-trip. The bearer token is resolved through `ctx.credentials` per
 * operation and never appears in configuration, logs, or events.
 *
 * @module @shres-code/shres-code-tracker-shrestech
 */

import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { dirname, join } from 'node:path'
import { credentialRef } from '@shres-code/shres-code-credentials'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import { TrackerService } from '@shres-code/shres-code-tracker'
import type {
  LogRunSpec,
  MetricPoint,
  RunFilter,
  TrackerFailureReason,
  TrackerRunId,
  TrackerRunResult,
  TrackerRunSummary,
  TrackerRunRecord,
} from '@shres-code/shres-code-tracker'
import { TrackerSpool, toMetricSpoolEntry, toSpoolEntry } from './spool.ts'
import type { TrackerMetricSpoolEntry, TrackerSpoolEntry } from './spool.ts'
import { LandedRunsIndex } from './index-store.ts'
import type { LandedRunRecord } from './index-store.ts'
import { buildSyncPayload, postRunRequest, postSyncRequest } from './transport.ts'
import type { SyncResult } from './types.ts'

export { TrackerSpool, toMetricSpoolEntry, toSpoolEntry } from './spool.ts'
export type { TrackerMetricSpoolEntry, TrackerSpoolEntry } from './spool.ts'
export { LandedRunsIndex } from './index-store.ts'
export type { LandedRunRecord } from './index-store.ts'
export { buildRunPayload, buildSyncPayload, postRunRequest, postSyncRequest } from './transport.ts'
export type {
  FetchLike,
  FetchResponseLike,
  MetricWire,
  RunWire,
  SyncOutcome,
  SyncPayload,
  SyncResponse,
} from './transport.ts'
export type { SyncResult } from './types.ts'

/** Provider plugin config. */
export interface Config {
  /** Tracker base URL, for example `https://tracker.example.com`. */
  baseUrl: string
  /** Per-lane scope; lanes carry distinct bearer credentials. */
  lane: string
  /**
   * Reference to a credential in `ctx.credentials`. Absent = spool-only mode:
   * runs are held locally and never posted, and that is not an error.
   */
  credentialRef?: string
  /** Spool file path. Defaults to `$SHRES_HOME/tracker/<lane>.spool.jsonl`. */
  spoolPath?: string
  /** Landed-run index file path. Defaults beside the spool (`.landed.jsonl`). */
  indexPath?: string
}

/**
 * The shrestech-tracker provider. A Cordis Service subclass (mounted as
 * `ctx.tracker`); implements the seam's persistence hooks over the durable
 * local spool and the live HTTP transport.
 */
export class ShrestechTrackerService extends TrackerService {
  static Config: z<Config> = z.object({
    baseUrl: z.string().required(),
    lane: z.string().required(),
    credentialRef: z.string(),
    spoolPath: z.string(),
    indexPath: z.string(),
  })

  private readonly entry: Config
  private readonly spool: TrackerSpool
  private readonly metricSpool: TrackerSpool
  private readonly index: LandedRunsIndex

  /**
   * @param ctx - Cordis context.
   * @param config - resolved provider config; `baseUrl` and `lane` must be non-blank.
   * @throws when `baseUrl` or `lane` is an empty string (misconfiguration fails loud at mount).
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (config.baseUrl.trim().length === 0) {
      throw new Error('tracker-shrestech: baseUrl must be a non-empty string')
    }
    if (config.lane.trim().length === 0) {
      throw new Error('tracker-shrestech: lane must be a non-empty string')
    }
    this.entry = config
    const spoolPath = config.spoolPath ?? shresHomePath('tracker', `${config.lane}.spool.jsonl`)
    this.spool = new TrackerSpool(spoolPath)
    const metricsPath = config.spoolPath
      ? join(dirname(spoolPath), `${config.lane}.metrics.jsonl`)
      : shresHomePath('tracker', `${config.lane}.metrics.jsonl`)
    this.metricSpool = new TrackerSpool(metricsPath)
    const indexPath = config.indexPath ?? join(dirname(spoolPath), `${config.lane}.landed.jsonl`)
    this.index = new LandedRunsIndex(indexPath)
  }

  /**
   * Persist (or spool) a run. With no credential reference the run is
   * spool-only: it is held locally with a `spooled` reason and never posted.
   * Otherwise the run is attempted; a non-landed attempt is spooled with its
   * failure reason.
   * @param runId - the id allocated by the seam.
   * @param spec - the resolved run spec.
   * @returns the post outcome (landed, or spooled with a {@link TrackerFailureReason}).
   */
  async postRun(runId: TrackerRunId, spec: LogRunSpec): Promise<TrackerRunResult> {
    const ref = this.entry.credentialRef
    if (ref === undefined) {
      await this.spool.enqueue(toSpoolEntry(runId, spec, 'spooled'))
      return { kind: 'spooled', runId, reason: 'spooled' }
    }
    const token = await this.postToken(ref)
    if (token === undefined) {
      await this.spool.enqueue(toSpoolEntry(runId, spec, 'auth'))
      return { kind: 'spooled', runId, reason: 'auth' }
    }
    const outcome = await this.attemptPost(runId, spec, token)
    if (outcome === 'landed') {
      await this.index.record(toLandedRecord(runId, spec))
      return { kind: 'landed', runId }
    }
    await this.spool.enqueue(toSpoolEntry(runId, spec, outcome))
    return { kind: 'spooled', runId, reason: outcome }
  }

  /**
   * Persist a batched metric append. Metrics are held in the metric spool and
   * drained with the run spool on the next `POST /api/sync`; a metric batch is
   * only persisted once its run has landed.
   * @param runId - the run the metrics belong to.
   * @param metrics - the metric points to persist.
   */
  async postMetrics(runId: TrackerRunId, metrics: readonly MetricPoint[]): Promise<void> {
    await this.metricSpool.enqueueMetrics(toMetricSpoolEntry(runId, metrics))
  }

  /**
   * Query runs from the durable local spool and the derived landed-run index:
   * landed runs carry no reason, spooled runs carry their failure reason.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching run summaries.
   */
  async queryRuns(filter: RunFilter): Promise<TrackerRunSummary[]> {
    const [records, entries] = await Promise.all([this.index.list(), this.spool.peek()])
    const landed = records.filter(record => matchesRun(filter, record.gitSha, record.experiment, record.landedAt)).map(toLandedSummary)
    const spooled = entries.filter(entry => matchesRun(filter, entry.gitSha, entry.experiment, entry.enqueuedAt)).map(toSummary)
    return [...landed, ...spooled]
  }

  /**
   * Resolve one run by id from the derived landed-run index, then the run
   * spool, so `verifyDecisionRule` reaches spooled runs too.
   * @param runId - the run's id.
   * @returns the run record, or `undefined` when neither store holds it.
   */
  override async getRun(runId: TrackerRunId): Promise<TrackerRunRecord | undefined> {
    const [records, entries] = await Promise.all([this.index.list(), this.spool.peek()])
    const landed = records.find(record => record.runId === runId)
    if (landed !== undefined) {
      return {
        runId: landed.runId,
        experiment: landed.experiment,
        decisionRule: landed.decisionRule,
        dataVersion: landed.dataVersion,
        gitSha: landed.gitSha,
        ...(landed.machineRule !== undefined ? { machineRule: landed.machineRule } : {}),
      }
    }
    const entry = entries.find(candidate => candidate.runId === runId)
    if (entry === undefined) return undefined
    const spec = entryToSpec(entry)
    return {
      runId: entry.runId,
      experiment: spec.experiment,
      decisionRule: spec.decisionRule,
      dataVersion: spec.dataVersion,
      gitSha: spec.gitSha,
      ...(spec.machineRule !== undefined ? { machineRule: spec.machineRule } : {}),
      reason: entry.reason,
    }
  }

  /**
   * Merge the run's inline metrics (logged with the run, held in its spool
   * entry) with its pending metric appends by metric name, later appends
   * overriding earlier values. Metrics already drained to the tracker live
   * server-side and are not answered from here.
   * @param runId - the run the metrics belong to.
   * @returns the merged metric points, latest value per name.
   */
  override async getMetrics(runId: TrackerRunId): Promise<MetricPoint[]> {
    const [runEntries, metricEntries] = await Promise.all([this.spool.peek(), this.metricSpool.peekMetrics()])
    const byName = new Map<string, MetricPoint>()
    const runEntry = runEntries.find(entry => entry.runId === runId)
    for (const point of runEntry?.metrics ?? []) byName.set(point.name, point)
    for (const entry of metricEntries) {
      if (entry.runId !== runId) continue
      for (const point of entry.metrics) byName.set(point.name, point)
    }
    return [...byName.values()]
  }

  /**
   * Drain the run and metric spools through `POST /api/sync`. Runs the server
   * accepts are recorded in the landed-run index; runs it rejects (and any
   * metric appends for those runs) stay spooled with the sync failure reason.
   * @returns which run ids landed and which remain spooled.
   * @throws when there is no `ctx.credentials` service (a credential reference
   * is set) or the transport reports an unexpected response.
   */
  async sync(): Promise<SyncResult> {
    const ref = this.entry.credentialRef
    if (ref === undefined) {
      return { landedRunIds: [], failedRunIds: [] }
    }
    const token = await this.postToken(ref)
    if (token === undefined) {
      return { landedRunIds: [], failedRunIds: [] }
    }
    const [runEntries, metricEntries] = await Promise.all([
      this.spool.replay(),
      this.metricSpool.replayMetrics(),
    ])
    if (runEntries.length === 0 && metricEntries.length === 0) {
      return { landedRunIds: [], failedRunIds: [] }
    }
    const payload = buildSyncPayload(runEntries, metricEntries)
    const outcome = await postSyncRequest(
      globalThis.fetch.bind(globalThis),
      this.entry.baseUrl,
      token,
      payload,
    )
    if (outcome.kind === 'failure') {
      const failed = runEntries.map(entry => entry.runId)
      await this.reenqueue(runEntries, metricEntries, outcome.reason)
      return { landedRunIds: [], failedRunIds: failed }
    }
    const landedIds = new Set<string>(outcome.landedRunIds)
    const failedRunIds: TrackerRunId[] = []
    for (const entry of runEntries) {
      if (landedIds.has(entry.runId)) {
        await this.index.record(toLandedRecord(entry.runId, entryToSpec(entry)))
      } else {
        failedRunIds.push(entry.runId)
      }
    }
    const reenqueue = runEntries.filter(entry => !landedIds.has(entry.runId))
    const reenqueueMetrics = metricEntries.filter(entry => !landedIds.has(entry.runId))
    await this.reenqueue(reenqueue, reenqueueMetrics, 'spooled')
    return { landedRunIds: [...landedIds] as TrackerRunId[], failedRunIds }
  }

  /**
   * Attempt to post a run to the tracker transport with an already-resolved
   * bearer token. `POST`s the spec to `POST /api/runs`.
   * @param runId - the run's id.
   * @param spec - the resolved run spec.
   * @param token - the resolved bearer token; never logged.
   * @returns `'landed'` on a delivered post, else the mapped failure reason.
   * @throws when the tracker responds with an unexpected status.
   */
  protected async attemptPost(runId: TrackerRunId, spec: LogRunSpec, token: string): Promise<'landed' | TrackerFailureReason> {
    return postRunRequest(
      globalThis.fetch.bind(globalThis),
      this.entry.baseUrl,
      token,
      runId,
      spec,
    )
  }

  /**
   * Resolve the bearer token for a configured credential reference. The value
   * is returned to the transport and never logged.
   * @param ref - the credential reference to resolve.
   * @returns the resolved token, or `undefined` when the reference is unconfigured.
   * @throws when no credentials service is loaded.
   */
  private async postToken(ref: string): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error('tracker-shrestech: credentialRef set but no ctx.credentials service loaded')
    }
    return (await credentials.resolve(credentialRef(ref)))?.value
  }

  /**
   * Re-enqueue entries that a sync attempt did not land, stamping the failure
   * reason so a later query surfaces why they are still pending.
   * @param runEntries - the drained run posts to hold again.
   * @param metricEntries - the drained metric appends to hold again.
   * @param reason - the failure reason to stamp on the run posts.
   */
  private async reenqueue(
    runEntries: readonly TrackerSpoolEntry[],
    metricEntries: readonly TrackerMetricSpoolEntry[],
    reason: TrackerFailureReason,
  ): Promise<void> {
    for (const entry of runEntries) await this.spool.enqueue({ ...entry, reason })
    for (const entry of metricEntries) await this.metricSpool.enqueueMetrics(entry)
  }
}

/**
 * Project one spooled entry into a {@link TrackerRunSummary}.
 * @param entry - the spooled run post.
 * @returns the run summary carrying its spool reason.
 */
function toSummary(entry: TrackerSpoolEntry): TrackerRunSummary {
  return {
    runId: entry.runId,
    experiment: entry.experiment,
    decisionRule: entry.decisionRule,
    dataVersion: entry.dataVersion,
    gitSha: entry.gitSha,
    reason: entry.reason,
  }
}

/**
 * Project one landed record into a {@link TrackerRunSummary} (no reason).
 * @param record - the landed run.
 * @returns the run summary with no failure reason.
 */
function toLandedSummary(record: LandedRunRecord): TrackerRunSummary {
  return {
    runId: record.runId,
    experiment: record.experiment,
    decisionRule: record.decisionRule,
    dataVersion: record.dataVersion,
    gitSha: record.gitSha,
  }
}

/**
 * Predicate applying a {@link RunFilter} to one run's stored fields.
 * @param filter - the caller's filters; absent fields are not applied.
 * @param gitSha - the run's git commit.
 * @param experiment - the run's experiment.
 * @param timestamp - the run's recency basis (landedAt for landed, enqueuedAt for spooled).
 * @returns whether the run satisfies the filter.
 */
function matchesRun(filter: RunFilter, gitSha: string, experiment: string, timestamp: string): boolean {
  return (
    (filter.experiment === undefined || experiment === filter.experiment)
    && (filter.gitSha === undefined || gitSha === filter.gitSha)
    && (filter.since === undefined || timestamp >= filter.since)
  )
}

/**
 * Build a landed-run index record from a run id and spec.
 * @param runId - the run's allocated id.
 * @param spec - the resolved run spec.
 * @returns the record to write to the index.
 */
function toLandedRecord(runId: TrackerRunId, spec: LogRunSpec): LandedRunRecord {
  return {
    runId,
    experiment: spec.experiment,
    decisionRule: spec.decisionRule,
    dataVersion: spec.dataVersion,
    gitSha: spec.gitSha,
    ...(spec.machineRule !== undefined ? { machineRule: spec.machineRule } : {}),
    landedAt: new Date().toISOString(),
  }
}

/**
 * Rebuild a resolved spec from a spooled run entry (its flattened fields).
 * @param entry - the spooled run post.
 * @returns the resolved run spec.
 */
function entryToSpec(entry: TrackerSpoolEntry): LogRunSpec {
  return {
    experiment: entry.experiment,
    hypothesis: entry.hypothesis,
    decisionRule: entry.decisionRule,
    dataVersion: entry.dataVersion,
    gitSha: entry.gitSha,
    ...(entry.machineRule !== undefined ? { machineRule: entry.machineRule } : {}),
    metrics: entry.metrics,
    artifacts: entry.artifacts,
  }
}

export default ShrestechTrackerService
