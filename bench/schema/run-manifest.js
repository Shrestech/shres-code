/**
 * Run manifest: `run.json`, written once per arm per experiment. The manifest
 * pins everything that must be identical across arms for the comparison to be
 * valid; a difference in anything but `arm`/`armConfig` invalidates the pairing.
 *
 * @module bench/schema/run-manifest
 */

/**
 * @typedef {object} RunManifest
 * @property {1} version - manifest format version.
 * @property {string} experiment - experiment directory name, e.g. `w0-2026-08-18`.
 * @property {string} arm - arm name; `off` is the baseline every comparison is against.
 * @property {Record<string, unknown>} armConfig - the exact jspace config applied.
 * @property {string} provider - harness provider id the agent-default-model row was pinned to (e.g. `deepseek-official`, `ollama-cloud`).
 * @property {string} model - provider model id.
 * @property {string | null} baseUrl - provider base URL override, when used.
 * @property {number | null} contextWindow - harness-side context-window pin, when used.
 * @property {number} [temperature] - legacy field from runs that recorded, but did not apply, this value.
 * @property {number} repeats - planned trials per task.
 * @property {string[]} taskIds - the pinned task set, in catalog order.
 * @property {string} gitCommit - harness commit the runs executed against.
 * @property {string} startedAt - ISO 8601.
 * @property {string} endedAt - ISO 8601, empty string while running.
 */

/**
 * Validate one run manifest. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @returns {asserts value is RunManifest}
 */
export function validateRunManifest(value) {
  const m = /** @type {Record<string, unknown>} */ (value)
  if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new Error('manifest must be a record')
  if (m.version !== 1) throw new Error('manifest.version must be 1')
  for (const field of ['experiment', 'arm', 'provider', 'model', 'gitCommit', 'startedAt']) {
    if (typeof m[field] !== 'string' || m[field].length === 0) throw new Error(`manifest.${field} must be a non-empty string`)
  }
  if (typeof m.endedAt !== 'string') throw new Error('manifest.endedAt must be a string (empty while running)')
  if (typeof m.armConfig !== 'object' || m.armConfig === null) throw new Error('manifest.armConfig must be a record')
  if (m.temperature !== undefined && typeof m.temperature !== 'number') {
    throw new Error('manifest.temperature must be a number when present')
  }
  if (!Number.isSafeInteger(m.repeats) || /** @type {number} */ (m.repeats) < 1) throw new Error('manifest.repeats must be a positive integer')
  if (!Array.isArray(m.taskIds) || m.taskIds.some(id => typeof id !== 'string')) throw new Error('manifest.taskIds must be a string array')
  if (m.baseUrl !== null && typeof m.baseUrl !== 'string') throw new Error('manifest.baseUrl must be string|null')
  if (m.contextWindow !== undefined && m.contextWindow !== null && !Number.isSafeInteger(m.contextWindow)) {
    throw new Error('manifest.contextWindow must be a positive integer, null, or absent')
  }
}
