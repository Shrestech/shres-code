/**
 * Durable local spool for the shrestech-tracker provider: an append-only JSONL
 * file under the harness config directory that holds run posts that did not
 * land. The offline posture is a mode, not an error path — a run with no
 * credential reference, or one that could not reach the tracker, is held here
 * with the failure-taxonomy reason until it is drained and replayed through
 * the sync path (stage 2).
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
  readonly metrics: readonly MetricPoint[]
  readonly artifacts: readonly string[]
  readonly reason: TrackerFailureReason
  readonly enqueuedAt: string
}

/**
 * Append-only JSONL spool. `enqueue` appends one entry; `peek` reads the
 * current entries without draining; `replay` reads, deduplicates by run id
 * (keeping the most recent), and drains the file.
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
    await mkdir(dirname(this.spoolPath), { recursive: true })
    await appendFile(this.spoolPath, `${JSON.stringify(entry)}\n`, 'utf8')
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
    const entries = await this.readAll()
    const unique = this.dedupe(entries)
    if (entries.length > 0) await writeFile(this.spoolPath, '', 'utf8')
    return unique
  }

  /**
   * Read all entries, treating an absent file as an empty spool.
   * @returns the parsed entries in file order.
   * @throws when the file cannot be read for a reason other than absence.
   */
  private async readAll(): Promise<TrackerSpoolEntry[]> {
    let text: string
    try {
      text = await readFile(this.spoolPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: TrackerSpoolEntry[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      entries.push(JSON.parse(line) as TrackerSpoolEntry)
    }
    return entries
  }

  /**
   * Collapse duplicate run ids, keeping the most recently enqueued occurrence.
   * @param entries - entries in file order.
   * @returns one entry per run id, last occurrence wins.
   */
  private dedupe(entries: TrackerSpoolEntry[]): TrackerSpoolEntry[] {
    const latest = new Map<string, TrackerSpoolEntry>()
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
    metrics: spec.metrics,
    artifacts: spec.artifacts,
    reason,
    enqueuedAt: now,
  }
}
