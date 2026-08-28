/**
 * Derived landed-run index for the shrestech-tracker provider: a durable
 * append-only JSONL file recording every run the transport confirmed landed,
 * so `queryRuns` returns landed runs without a network round-trip. The
 * authoritative record of what landed is the tracker itself (and the git
 * run-record in production); this index is derived from sync/run outcomes and
 * rebuildable — {@link LandedRunsIndex.reset} wipes it so a re-derivation can
 * start clean.
 *
 * @module @shres-code/shres-code-tracker-shrestech/index-store
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MachineRule } from '@shres-code/shres-code-tracker'
import type { TrackerRunId } from '@shres-code/shres-code-tracker'

/** One landed run as recorded in the derived index. */
export interface LandedRunRecord {
  readonly runId: TrackerRunId
  readonly experiment: string
  readonly decisionRule: string
  readonly dataVersion: string
  readonly gitSha: string
  /** The run's machine-readable decision rule, when it logged one. */
  readonly machineRule?: MachineRule
  /** ISO-8601 timestamp when the run was confirmed landed. */
  readonly landedAt: string
}

/** Append-only JSONL index of landed runs. */
export class LandedRunsIndex {
  /**
   * @param indexPath - absolute path of the JSONL index file.
   */
  constructor(private readonly indexPath: string) {}

  /**
   * Append one landed run to the index, creating the parent directory as needed.
   * @param record - the landed run to record.
   */
  async record(record: LandedRunRecord): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true })
    await appendFile(this.indexPath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /**
   * Read every recorded landed run in file order.
   * @returns the recorded runs.
   * @throws when the file cannot be read for a reason other than absence.
   */
  async list(): Promise<LandedRunRecord[]> {
    let text: string
    try {
      text = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: LandedRunRecord[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      records.push(JSON.parse(line) as LandedRunRecord)
    }
    return records
  }

  /**
   * Wipe the index so it can be re-derived from the authoritative run-record.
   */
  async reset(): Promise<void> {
    await writeFile(this.indexPath, '', 'utf8')
  }
}
