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
 * @typedef {object} BudgetStop - the `--max-dollars` stop, recorded when it ends a run early.
 * @property {'max-dollars'} reason
 * @property {number} maxDollars - the cap.
 * @property {number} spentDollars - counted spend (upper-bound dollars) of every settled trial.
 * @property {number} projectedTrialDollars - the largest settled trial's spend, used as the next trial's estimate.
 * @property {number} inFlight - trials running when the stop was decided.
 * @property {number} notLaunched - planned trials the runner never started.
 * @property {number} unpricedCalls - settled calls the cap could not count.
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
 * @property {TierPatchRecord[]} tierPatches - experiment-level overlay files in apply order (arm overlay first, then these); empty when none.
 * @property {number | null} maxTotalTokens - pre-registered live per-trial token cap recorded at experiment start; null when uncapped.
 * @property {number | null} [maxDollars] - experiment-wide `--max-dollars` cap; null when uncapped, absent on manifests
 *   written before the flag existed.
 * @property {string} [priceSnapshot] - `bench/prices` snapshot id every trial is priced under.
 * @property {string} [accountingConfigSha256] - hex SHA-256 of `bench/accounting.json` at experiment start.
 * @property {BudgetStop} [budgetStop] - why the runner stopped launching trials before the plan finished.
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
  if (!Array.isArray(m.tierPatches)) throw new Error('manifest.tierPatches must be an array')
  // Absent means uncapped: manifests written before the flag existed (w4–w9) ran uncapped.
  if (m.maxTotalTokens != null && !(Number.isSafeInteger(m.maxTotalTokens) && /** @type {number} */ (m.maxTotalTokens) >= 1)) {
    throw new Error('manifest.maxTotalTokens must be a positive integer or null')
  }
  if (m.maxDollars != null && !(typeof m.maxDollars === 'number' && Number.isFinite(m.maxDollars) && m.maxDollars > 0)) {
    throw new Error('manifest.maxDollars must be a positive number or null')
  }
  if (m.priceSnapshot !== undefined && (typeof m.priceSnapshot !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.priceSnapshot))) {
    throw new Error('manifest.priceSnapshot must be a YYYY-MM-DD snapshot id')
  }
  if (m.accountingConfigSha256 !== undefined && (typeof m.accountingConfigSha256 !== 'string' || m.accountingConfigSha256.length === 0)) {
    throw new Error('manifest.accountingConfigSha256 must be a non-empty string')
  }
  if (m.budgetStop !== undefined) {
    const stop = /** @type {Record<string, unknown>} */ (m.budgetStop)
    if (typeof stop !== 'object' || stop === null || stop.reason !== 'max-dollars') {
      throw new Error('manifest.budgetStop must be a max-dollars stop record')
    }
    for (const field of ['maxDollars', 'spentDollars', 'projectedTrialDollars', 'inFlight', 'notLaunched', 'unpricedCalls']) {
      if (typeof stop[field] !== 'number' || !Number.isFinite(stop[field]) || /** @type {number} */ (stop[field]) < 0) {
        throw new Error(`manifest.budgetStop.${field} must be a non-negative number`)
      }
    }
  }
  m.tierPatches.forEach((item, index) => {
    const tp = /** @type {Record<string, unknown>} */ (item)
    if (typeof tp !== 'object' || tp === null || Array.isArray(tp)) {
      throw new Error(`manifest.tierPatches[${index}] must be a record`)
    }
    if (typeof tp.path !== 'string' || tp.path.length === 0) {
      throw new Error(`manifest.tierPatches[${index}].path must be a non-empty string`)
    }
    if (typeof tp.sha256 !== 'string' || tp.sha256.length === 0) {
      throw new Error(`manifest.tierPatches[${index}].sha256 must be a non-empty string`)
    }
  })
}
