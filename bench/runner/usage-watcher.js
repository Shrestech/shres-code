/**
 * Live token-usage watcher: incremental byte-offset polling over every
 * `session.jsonl` under a trial persistence root while the harness child is
 * running. Powers the `--max-total-tokens` live cap — when the observed
 * running total (root + descendants, `assistant/message` usage only, matching
 * the root fold's numerator) exceeds the cap, `executeTrial` terminates the
 * child and the trial is recorded with failure mode `BUDGET_EXCEEDED`.
 *
 * Each file is read only from its last newline boundary forward, so a poll
 * costs the bytes appended since the previous poll, not a log re-read. Seeded
 * prior-session fixtures (`bench-prior-*`) are excluded.
 *
 * @module bench/runner/usage-watcher
 */

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSeededPriorSession } from './session-layout.js'

/**
 * @typedef {object} UsageTotals
 * @property {number} inputTokens - running input-token total over all observed sessions.
 * @property {number} outputTokens - running output-token total over all observed sessions.
 */

/** Per-file incremental state. */
class FileState {
  /** @param {string} path */ constructor(path) {
    this.path = path
    this.offset = 0
    this.inputTokens = 0
    this.outputTokens = 0
    this.excluded = false
  }
}

/**
 * Incremental usage watcher over one persistence root.
 */
export class UsageWatcher {
  /** @param {string} sessionLogRoot - per-trial persistence root. */
  constructor(sessionLogRoot) {
    this.sessionLogRoot = sessionLogRoot
    /** @type {Map<string, FileState>} */
    this.files = new Map()
    this.inputTokens = 0
    this.outputTokens = 0
  }

  /**
   * Enumerate session logs under the root, recursively.
   * @returns {Promise<string[]>} absolute session.jsonl paths.
   */
  async listLogs() {
    /** @type {string[]} */
    const found = []
    /** @param {string} dir */
    const walk = async dir => {
      /** @type {import('node:fs').Dirent[]} */
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile() && entry.name === 'session.jsonl') found.push(path)
      }
    }
    await walk(this.sessionLogRoot)
    return found
  }

  /**
   * One poll: absorb bytes appended since the last poll and refresh totals.
   * Idempotent when nothing changed.
   * @returns {Promise<UsageTotals>} the running totals.
   */
  async poll() {
    for (const path of await this.listLogs()) {
      let state = this.files.get(path)
      if (state === undefined) {
        state = new FileState(path)
        this.files.set(path, state)
        // First sight of a log: decide exclusion from its header before counting.
        const { text: first } = await this.readFrom(path, 0, 8192)
        try {
          const header = JSON.parse(first.split('\n', 1)[0] ?? '')
          if (header.type !== 'session' || isSeededPriorSession(header.id)) state.excluded = true
        } catch {
          // Header not yet complete: retry classification on the next poll.
          this.files.delete(path)
          continue
        }
      }
      if (state.excluded) continue

      const { bytes, text } = await this.readFrom(path, state.offset)
      if (bytes === 0) continue
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline === -1) continue // no complete line yet; retry next poll
      const complete = text.slice(0, lastNewline + 1)
      for (const line of complete.split('\n')) {
        if (line.trim() === '') continue
        /** @type {{ type?: unknown, data?: unknown }} */
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue // a torn line inside the absorbed prefix is skipped, not fatal
        }
        if (event.type !== 'assistant/message') continue
        const usage = /** @type {Record<string, unknown>} */ ((/** @type {Record<string, unknown>} */ (event.data ?? {})).usage ?? {})
        if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
          state.inputTokens += usage.inputTokens
        }
        if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
          state.outputTokens += usage.outputTokens
        }
      }
      state.offset += lastNewline + 1
    }
    this.inputTokens = 0
    this.outputTokens = 0
    for (const state of this.files.values()) {
      if (state.excluded) continue
      this.inputTokens += state.inputTokens
      this.outputTokens += state.outputTokens
    }
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
  }

  /**
   * Read a byte range from a file.
   * @param {string} path - file to read.
   * @param {number} offset - byte offset to start at.
   * @param {number} [limit] - maximum bytes to read (default 32 MiB per poll per file).
   * @returns {Promise<{ bytes: number, text: string }>} bytes actually read and decoded text.
   */
  async readFrom(path, offset, limit = 32 << 20) {
    let handle
    try {
      handle = await open(path, 'r')
    } catch {
      return { bytes: 0, text: '' }
    }
    try {
      const size = (await stat(path)).size
      if (size <= offset) return { bytes: 0, text: '' }
      const want = Math.min(limit, size - offset)
      const buffer = Buffer.alloc(want)
      const { bytesRead } = await handle.read(buffer, 0, want, offset)
      return { bytes: bytesRead, text: buffer.toString('utf8', 0, bytesRead) }
    } finally {
      await handle.close()
    }
  }
}
