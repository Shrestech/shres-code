/**
 * Durable append-only JSONL store for the decision-ledger seam: every recorded
 * entry is appended to a JSONL file and mirrored into an in-memory query
 * index, so `query` answers without re-reading the file. The file is the
 * authoritative record; the index is derived and rebuilt from it on load.
 *
 * @module @shres-code/shres-code-ledger/store
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LedgerError } from './resolve.ts'
import type { LedgerEntry, LedgerEntryId, LedgerFilter } from './types.ts'

/**
 * Append-only JSONL store of decision entries. `append` writes one entry and
 * mirrors it into the in-memory index; `query` filters the index; `has` checks
 * the index synchronously. The file is loaded into the index lazily on first
 * use, so a fresh store instance over an existing file round-trips its
 * entries.
 */
export class LedgerStore {
  private entries: LedgerEntry[] = []
  private loaded = false

  /**
   * @param storagePath - absolute path of the JSONL store file.
   */
  constructor(private readonly storagePath: string) {}

  /**
   * Append one entry to the store, creating the parent directory as needed.
   * @param entry - the entry to record.
   */
  async append(entry: LedgerEntry): Promise<void> {
    await this.ensureLoaded()
    await mkdir(dirname(this.storagePath), { recursive: true })
    await appendFile(this.storagePath, `${JSON.stringify(entry)}\n`, 'utf8')
    this.entries.push(entry)
  }

  /**
   * Query the in-memory index, applying the optional filters.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching entries in file order.
   */
  async query(filter: LedgerFilter): Promise<LedgerEntry[]> {
    await this.ensureLoaded()
    return this.entries.filter(entry => matches(entry, filter))
  }

  /**
   * Whether the in-memory index holds an entry with the given id. Synchronous
   * so the invariant companion can check a `ledger/decision` event against the
   * store without awaiting a query.
   * @param entryId - the entry id to look up.
   * @returns whether the entry is present in the loaded index.
   */
  has(entryId: LedgerEntryId): boolean {
    return this.entries.some(entry => entry.entryId === entryId)
  }

  /**
   * Load the file into the in-memory index once.
   * @throws {@link LedgerError} naming the first corrupt line.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.entries = await this.readAll()
    this.loaded = true
  }

  /**
   * Read every entry from the file, treating an absent file as an empty store.
   * @returns the parsed entries in file order.
   * @throws {@link LedgerError} naming the first corrupt line.
   */
  private async readAll(): Promise<LedgerEntry[]> {
    let text: string
    try {
      text = await readFile(this.storagePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: LedgerEntry[] = []
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue
      try {
        entries.push(JSON.parse(line) as LedgerEntry)
      } catch {
        throw new LedgerError(`ledger store line ${index + 1} is corrupt`, 'corrupt-store')
      }
    }
    return entries
  }
}

/**
 * Predicate applying a {@link LedgerFilter} to one entry's stored fields.
 * @param entry - the stored entry.
 * @param filter - the caller's filters; absent fields are not applied.
 * @returns whether the entry satisfies the filter.
 */
function matches(entry: LedgerEntry, filter: LedgerFilter): boolean {
  return (
    (filter.decision === undefined || entry.decision === filter.decision)
    && (filter.hypothesisSubstring === undefined || entry.hypothesis.includes(filter.hypothesisSubstring))
    && (filter.since === undefined || entry.recordedAt >= filter.since)
  )
}
