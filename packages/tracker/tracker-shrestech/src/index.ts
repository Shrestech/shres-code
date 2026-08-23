/**
 * shrestech-tracker Service Provider for the experiment tracking seam
 * (`ctx.tracker`). Stage 1 is offline-first: every run post lands in a durable
 * local spool — runs with no credential reference are spool-only mode (never an
 * error), and runs that would be posted but cannot reach a live transport are
 * held with an `unreachable` reason. Live HTTP is stage 2; until then
 * `attemptPost` reports the tracker as unreachable so no run is silently lost.
 *
 * @module @shres-code/shres-code-tracker-shrestech
 */

import { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
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
} from '@shres-code/shres-code-tracker'
import { TrackerSpool, toSpoolEntry } from './spool.ts'
import type { TrackerSpoolEntry } from './spool.ts'

export { TrackerSpool, toSpoolEntry } from './spool.ts'
export type { TrackerSpoolEntry } from './spool.ts'

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
}

/**
 * The shrestech-tracker provider. A Cordis Service subclass (mounted as
 * `ctx.tracker`); implements the seam's persistence hooks over the durable
 * local spool.
 */
export class ShrestechTrackerService extends TrackerService {
  static Config: z<Config> = z.object({
    baseUrl: z.string().required(),
    lane: z.string().required(),
    credentialRef: z.string(),
    spoolPath: z.string(),
  })

  private readonly entry: Config
  private readonly spool: TrackerSpool

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
    this.spool = new TrackerSpool(config.spoolPath ?? shresHomePath('tracker', `${config.lane}.spool.jsonl`))
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
    if (this.entry.credentialRef === undefined) {
      await this.spool.enqueue(toSpoolEntry(runId, spec, 'spooled'))
      return { kind: 'spooled', runId, reason: 'spooled' }
    }
    const outcome = await this.attemptPost(runId, spec)
    if (outcome === 'landed') return { kind: 'landed', runId }
    await this.spool.enqueue(toSpoolEntry(runId, spec, outcome))
    return { kind: 'spooled', runId, reason: outcome }
  }

  /**
   * Persist a batched metric append. Stage 1 keeps metrics only in the seam's
   * session event log; the shrestech-tracker transport persists them once it
   * lands (stage 2). A no-op now.
   * @param _runId - the run the metrics belong to.
   * @param _metrics - the metric points to persist.
   */
  postMetrics(_runId: TrackerRunId, _metrics: readonly MetricPoint[]): Promise<void> {
    return Promise.resolve(undefined)
  }

  /**
   * Query spooled runs from the durable local spool. Because stage 1 has no
   * authoritative landed store, only runs still held in the spool are
   * returned; stage 2 adds the tracker-derived index.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching run summaries with their spool reasons.
   */
  async queryRuns(filter: RunFilter): Promise<TrackerRunSummary[]> {
    const entries = await this.spool.peek()
    return entries
      .filter(entry => filter.experiment === undefined || entry.experiment === filter.experiment)
      .filter(entry => filter.gitSha === undefined || entry.gitSha === filter.gitSha)
      .filter(entry => filter.since === undefined || entry.enqueuedAt >= filter.since)
      .map(toSummary)
  }

  /**
   * Attempt to post a run to the tracker transport. Stage 1 has no live
   * transport and reports the tracker as unreachable; stage 2 replaces this
   * with the real HTTP post.
   * @param _runId - the run's id.
   * @param _spec - the resolved run spec.
   * @returns `'landed'` on a delivered post, else the failure reason.
   */
  protected attemptPost(_runId: TrackerRunId, _spec: LogRunSpec): Promise<'landed' | TrackerFailureReason> {
    return Promise.resolve('unreachable')
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

export default ShrestechTrackerService
