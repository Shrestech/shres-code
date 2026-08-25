/**
 * Run manifest: `run.json`, written once per arm per experiment. The manifest
 * pins everything that must be identical across arms for the comparison to be
 * valid; a difference in anything but `arm`/`armConfig` invalidates the pairing.
 *
 * @module bench/schema/run-manifest
 */

/**
 * @typedef {object} TierPatchRecord
 * @property {string} path - relative path of the tier patch file from the bench root.
 * @property {string} sha256 - hex SHA-256 of the file contents at experiment start.
 */

/**
 * @typedef {object} RunManifest
 * @property {1} version - manifest format version.
 * @property {string} experiment - experiment directory name, e.g. `w0-2026-08-18`.
 * @property {string} arm - arm name; `off` is the baseline every comparison is against.
 * @property {Record<string, unknown>} armConfig - the exact jspace config applied.
 * @property {string} model - provider model id.
 * @property {string | null} baseUrl - provider base URL override, when used.
 * @property {number} temperature
 * @property {number} repeats - planned trials per task.
 * @property {string[]} taskIds - the pinned task set, in catalog order.
 * @property {string} gitCommit - harness commit the runs executed against.
 * @property {string} apiKeyEnv - environment variable name for the API key (`none` for keyless tiers).
 * @property {TierPatchRecord | null} tierPatch - tier overlay file record; null when no tier patch is used.
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
  for (const field of ['experiment', 'arm', 'model', 'gitCommit', 'startedAt']) {
    if (typeof m[field] !== 'string' || m[field].length === 0) throw new Error(`manifest.${field} must be a non-empty string`)
  }
  if (typeof m.endedAt !== 'string') throw new Error('manifest.endedAt must be a string (empty while running)')
  if (typeof m.armConfig !== 'object' || m.armConfig === null) throw new Error('manifest.armConfig must be a record')
  if (typeof m.temperature !== 'number') throw new Error('manifest.temperature must be a number')
  if (!Number.isSafeInteger(m.repeats) || /** @type {number} */ (m.repeats) < 1) throw new Error('manifest.repeats must be a positive integer')
  if (!Array.isArray(m.taskIds) || m.taskIds.some(id => typeof id !== 'string')) throw new Error('manifest.taskIds must be a string array')
  if (m.baseUrl !== null && typeof m.baseUrl !== 'string') throw new Error('manifest.baseUrl must be string|null')
  if (typeof m.apiKeyEnv !== 'string') throw new Error('manifest.apiKeyEnv must be a string')
  if (m.tierPatch !== null) {
    const tp = /** @type {Record<string, unknown>} */ (m.tierPatch)
    if (typeof tp !== 'object' || Array.isArray(tp)) throw new Error('manifest.tierPatch must be a record or null')
    if (typeof tp.path !== 'string' || tp.path.length === 0) throw new Error('manifest.tierPatch.path must be a non-empty string')
    if (typeof tp.sha256 !== 'string' || tp.sha256.length === 0) throw new Error('manifest.tierPatch.sha256 must be a non-empty string')
  }
}
