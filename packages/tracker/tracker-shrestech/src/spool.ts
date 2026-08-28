/**
 * Durable local spool for the shrestech-tracker provider: append-only JSONL
 * files under the harness config directory that hold run posts that did not
 * land and metric appends awaiting sync. The offline posture is a mode, not an
 * error path — a run with no credential reference, one that could not reach the
 * tracker, or a metric batch for a run that has not landed is held here with
 * the failure-taxonomy reason until the sync drain replays it through the
 * `/api/sync` path.
 *
 * @module @shres-code/shres-code-tracker-shrestech/spool
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  LogRunSpec,
  MetricPoint,
  TrackerFailureReason,
  TrackerRunId,
  MachineRule,
} from '@shres-code/shres-code-tracker'

/**
 * One spooled run post. Flattens the resolved {@link LogRunSpec} plus the
 * failure-taxonomy reason and the enqueue time, so a stage-2 sync can rebuild
 * the full post and a query can surface why the run has not landed.
 */
export interface TrackerSpoolEntry {
  readonly runId: TrackerRunId
  readonly experiment: string
  readonly hypothesis: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  readonly machineRule?: MachineRule
  readonly metrics: readonly MetricPoint[]
  readonly artifacts: readonly string[]
  readonly reason: TrackerFailureReason
  readonly enqueuedAt: string
}

/**
 * One spooled metric append. A run's metrics batch is held here until the
 * sync drain attaches it to the run's wire payload; the entry carries only the
 * run id, the points, and the enqueue time.
 */
export interface TrackerMetricSpoolEntry {
  readonly runId: TrackerRunId
  readonly metrics: readonly MetricPoint[]
  readonly enqueuedAt: string
}

/**
 * Append-only JSONL spool. `enqueue`/`enqueueMetrics` append one entry;
 * `peek`/`peekMetrics` read the current entries without draining;
 * `replay`/`replayMetrics` read, deduplicate by run id (keeping the most
 * recent), and drain the file.
 */
export class TrackerSpool {
  /**
   * @param spoolPath - absolute path of the JSONL spool file.
   */
  constructor(private readonly spoolPath: string) {}

  /**
   * Append one run post to the spool, creating the parent directory as needed.
   * @param entry - the run post to hold.
   */
  async enqueue(entry: TrackerSpoolEntry): Promise<void> {
    await this.append(entry)
  }

  /**
   * Read the current spooled entries without draining.
   * @returns every entry currently held.
   */
  async peek(): Promise<TrackerSpoolEntry[]> {
    return this.readAll()
  }

  /**
   * Replay the spool: read every held entry, deduplicate by run id keeping the
   * most recent, and drain the file so a replay never re-delivers.
   * @returns the drained, deduplicated entries.
   */
  async replay(): Promise<TrackerSpoolEntry[]> {
    return this.replayDrain<TrackerSpoolEntry>()
  }

  /**
   * Append one metric batch to the spool, creating the parent directory as
   * needed.
   * @param entry - the metric append to hold.
   */
  async enqueueMetrics(entry: TrackerMetricSpoolEntry): Promise<void> {
    await this.append(entry)
  }

  /**
   * Read the current spooled metric appends without draining.
   * @returns every metric append currently held.
   */
  async peekMetrics(): Promise<TrackerMetricSpoolEntry[]> {
    return this.readAll<TrackerMetricSpoolEntry>()
  }

  /**
   * Replay the metric spool: read every held append, deduplicate by run id
   * keeping the most recent, and drain the file so a replay never re-delivers.
   * @returns the drained, deduplicated metric appends.
   */
  async replayMetrics(): Promise<TrackerMetricSpoolEntry[]> {
    return this.replayDrain<TrackerMetricSpoolEntry>()
  }

  /**
   * Append one entry to the JSONL file, creating the parent directory as needed.
   * @param entry - the entry to hold.
   */
  private async append(entry: TrackerSpoolEntry | TrackerMetricSpoolEntry): Promise<void> {
    await mkdir(dirname(this.spoolPath), { recursive: true })
    await appendFile(this.spoolPath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /**
   * Drain the spool: read every held entry, deduplicate by run id keeping the
   * most recent, and truncate the file so a replay never re-delivers.
   * @returns the drained, deduplicated entries.
   */
  private async replayDrain<T extends { readonly runId: TrackerRunId }>(): Promise<T[]> {
    const entries = await this.readAll<T>()
    const unique = this.dedupe(entries)
    if (entries.length > 0) await writeFile(this.spoolPath, '', 'utf8')
    return unique
  }

  /**
   * Read all entries, treating an absent file as an empty spool.
   * @returns the parsed entries in file order.
   * @throws when the file cannot be read for a reason other than absence.
   */
  private async readAll<T extends { readonly runId: TrackerRunId } = TrackerSpoolEntry>(): Promise<T[]> {
    let text: string
    try {
      text = await readFile(this.spoolPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: T[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      entries.push(JSON.parse(line) as T)
    }
    return entries
  }

  /**
   * Collapse duplicate run ids, keeping the most recently enqueued occurrence.
   * @param entries - entries in file order.
   * @returns one entry per run id, last occurrence wins.
   */
  private dedupe<T extends { readonly runId: TrackerRunId }>(entries: T[]): T[] {
    const latest = new Map<string, T>()
    for (const entry of entries) latest.set(entry.runId, entry)
    return [...latest.values()]
  }
}

/**
 * Build a spool entry from a resolved run spec and the reason it did not land.
 * @param runId - the run's allocated id.
 * @param spec - the resolved run spec.
 * @param reason - why the post did not land.
 * @param now - ISO timestamp; overridable for deterministic tests.
 * @returns the entry to enqueue.
 */
export function toSpoolEntry(
  runId: TrackerRunId,
  spec: LogRunSpec,
  reason: TrackerFailureReason,
  now: string = new Date().toISOString(),
): TrackerSpoolEntry {
  return {
    runId,
    experiment: spec.experiment,
    hypothesis: spec.hypothesis,
    decisionRule: spec.decisionRule,
    dataVersion: spec.dataVersion,
    gitSha: spec.gitSha,
    ...(spec.machineRule !== undefined ? { machineRule: spec.machineRule } : {}),
    metrics: spec.metrics,
    artifacts: spec.artifacts,
    reason,
    enqueuedAt: now,
  }
}

/**
 * Build a metric spool entry from a run id and its metric points.
 * @param runId - the run the metrics belong to.
 * @param metrics - the metric points to hold for sync.
 * @param now - ISO timestamp; overridable for deterministic tests.
 * @returns the entry to enqueue.
 */
export function toMetricSpoolEntry(
  runId: TrackerRunId,
  metrics: readonly MetricPoint[],
  now: string = new Date().toISOString(),
): TrackerMetricSpoolEntry {
  return { runId, metrics, enqueuedAt: now }
}
