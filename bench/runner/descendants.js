/**
 * Descendant-inclusive token accounting: walk every `session.jsonl` under a
 * trial persistence root, key sessions by header ids, and sum provider-reported
 * usage over the root session plus its descendant closure. The numerator is
 * identical to the root fold in `metrics.js` — `assistant/message` `usage`
 * input+output tokens — so root and descendant numbers stay comparable; the
 * token-meter's `assistant/chunk` fallback is intentionally not duplicated
 * here (root metrics never counted it).
 *
 * Seeded prior-session fixtures (`bench-prior-*`) are excluded, matching
 * `findSessionLog`. A torn final line (child killed mid-append) is tolerated;
 * a corrupt line before the end throws, same stance as `foldSessionLog`.
 *
 * @module bench/runner/descendants
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSeededPriorSession } from './session-layout.js'

/**
 * @typedef {object} DescendantUsage
 * @property {number | null} tokensIncludingDescendants - input+output tokens summed over
 *   the root session and every descendant session; null when the root header cannot be read.
 * @property {number} descendantSessions - count of descendant sessions in the closure
 *   (excludes the root; includes descendants whose logs carry no usage).
 * @property {number} delegatedSessions - descendants with header `origin: 'subagent'`;
 *   each is one delegated experiment (the delegation tool name is configurable, so the
 *   durable header is the counter, not a tool-call name).
 * @property {number} descendantRunCodeCalls - `run_code` tool calls inside descendants.
 *   The root's own `run_code` calls are counted by `foldSessionLog`, never here.
 */

/** Enumerate every session.jsonl under the persistence root. @param {string} root @returns {Promise<string[]>} */
async function listSessionLogs(root) {
  /** @type {string[]} */
  const found = []
  /** @param {string} dir */
  const walk = async dir => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // No root directory means no sessions at all.
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'session.jsonl') found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

/**
 * Sum `assistant/message` usage from one log's text. The final line may be torn
 * (no trailing newline, invalid JSON) — it is skipped, not an error.
 * @param {string} text - raw JSONL contents.
 * @returns {{ inputTokens: number, outputTokens: number, runCodeCalls: number }} usage sums plus code-mode call count.
 */
function foldUsage(text) {
  let inputTokens = 0
  let outputTokens = 0
  let runCodeCalls = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      if (index === lines.length - 1) break // torn tail from a killed child append
      throw new Error(`session log line ${index + 1} is not valid JSON: ${/** @type {Error} */ (error).message}`)
    }
    if (event.type === 'tool/call' && (/** @type {Record<string, unknown>} */ (event.data ?? {})).name === 'run_code') {
      runCodeCalls += 1
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = /** @type {Record<string, unknown>} */ ((/** @type {Record<string, unknown>} */ (event.data ?? {})).usage ?? {})
    if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) inputTokens += usage.inputTokens
    if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) outputTokens += usage.outputTokens
  }
  return { inputTokens, outputTokens, runCodeCalls }
}

/**
 * Compute descendant-inclusive usage for one trial.
 * @param {string} sessionLogRoot - per-trial persistence root.
 * @param {string} rootLogPath - the trial's top-level session log (as located by `findSessionLog`).
 * @returns {Promise<DescendantUsage>} the summed usage and descendant count.
 */
export async function descendantUsage(sessionLogRoot, rootLogPath) {
  const logs = await listSessionLogs(sessionLogRoot)

  /** @type {Map<string, { path: string, parentSession: string | null, origin: string | null }>} */
  const byId = new Map()
  /** @type {Map<string, string[]>} */
  const childrenOf = new Map()

  let rootId = null
  for (const path of logs) {
    const text = await readFile(path, 'utf8')
    const firstLine = text.split('\n', 1)[0] ?? ''
    /** @type {{ type?: unknown, id?: unknown, parentSession?: unknown }} */
    let header
    try {
      header = JSON.parse(firstLine)
    } catch {
      // A log whose header never parsed is mid-create or corrupt; it cannot
      // join the forest. Counted neither as descendant nor as usage.
      continue
    }
    if (header.type !== 'session' || typeof header.id !== 'string') continue
    if (isSeededPriorSession(header.id)) continue
    const parent = typeof header.parentSession === 'string' ? header.parentSession : null
    const origin = header.origin === 'subagent' ? 'subagent' : null
    byId.set(header.id, { path, parentSession: parent, origin })
    if (parent !== null) {
      const siblings = childrenOf.get(parent) ?? []
      siblings.push(header.id)
      childrenOf.set(parent, siblings)
    }
    if (path === rootLogPath) rootId = header.id
  }

  if (rootId === null) return { tokensIncludingDescendants: null, descendantSessions: 0, delegatedSessions: 0, descendantRunCodeCalls: 0 }

  // Header-keyed BFS: parentSession links decide membership, not path shape.
  /** @type {string[]} */
  const closure = []
  /** @type {string[]} */
  const queue = [rootId]
  const seen = new Set([rootId])
  while (queue.length > 0) {
    const id = /** @type {string} */ (queue.shift())
    closure.push(id)
    for (const childId of childrenOf.get(id) ?? []) {
      if (seen.has(childId)) continue // a malformed cycle must not loop the walk
      seen.add(childId)
      queue.push(childId)
    }
  }

  let inputTokens = 0
  let outputTokens = 0
  let delegatedSessions = 0
  let descendantRunCodeCalls = 0
  for (const id of closure) {
    const entry = /** @type {{ path: string, origin: string | null }} */ (byId.get(id))
    const usage = foldUsage(await readFile(entry.path, 'utf8'))
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    if (id !== rootId) {
      if (entry.origin === 'subagent') delegatedSessions += 1
      descendantRunCodeCalls += usage.runCodeCalls
    }
  }
  return { tokensIncludingDescendants: inputTokens + outputTokens, descendantSessions: closure.length - 1, delegatedSessions, descendantRunCodeCalls }
}
