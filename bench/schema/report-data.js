/**
 * Report data: the single `ui/data.js` payload the static report renders.
 * Produced by `report/build.js` from run directories; the demo generator emits
 * the same shape with `demo: true`.
 *
 * @module bench/schema/report-data
 */

import { validateTrial } from './trial.js'

/**
 * @typedef {object} ReportCell - one task×arm aggregate.
 * @property {string} taskId
 * @property {string} arm
 * @property {number} trials - trials with status success.
 * @property {number} errors - trials with status error.
 * @property {number} resolved
 * @property {number} passRate - resolved / trials; NaN when trials is 0.
 * @property {[number, number]} ci95 - Wilson interval on passRate.
 * @property {number} meanInputTokens
 * @property {number} meanOutputTokens
 * @property {number} meanDurationMs
 * @property {number} meanTurns
 * @property {number} meanToolCalls
 * @property {number} meanIdenticalRetries
 * @property {number} meanCheckpoints
 * @property {number | null} meanDanglingCard - fraction of trials with a dangling card; null for jspace-off.
 * @property {number | null} meanVerifiedCheckpointShare - mean of per-trial verifiedCheckpointShare; null when no trial has checkpoints.
 * @property {number} totalCoverageRefusalThenPad
 * @property {number} totalNoopNoteRefusals
 * @property {number} totalNoteCapRefusals
 * @property {number | null} meanSessionQueryCalls - null for arms excluding session-query.
 */

/**
 * @typedef {object} ReportPair - paired comparison of one task between two arms.
 * @property {string} taskId
 * @property {number} delta - passRate(on) - passRate(off).
 * @property {[number, number]} deltaCi95 - paired bootstrap interval on delta.
 * @property {number | null} mcnemarP - exact McNemar p over discordant trial pairs; null when no discordance.
 * @property {number} wins - trials resolved on, unresolved off (by trialIndex).
 * @property {number} losses - trials unresolved on, resolved off.
 * @property {number} ties
 * @property {'on' | 'off' | 'tie'} winner - by delta sign with interval check left to the reader.
 */

/**
 * @typedef {object} ReportArmSummary
 * @property {string} arm
 * @property {number} accuracy - resolved / trials across the experiment.
 * @property {number} stderr
 * @property {[number, number]} ci95 - Wilson interval.
 * @property {number} totalInputTokens
 * @property {number} totalOutputTokens
 * @property {number} totalDurationMs
 * @property {number} meanTurns
 * @property {number} totalIdenticalRetries
 * @property {number} trials
 */

/**
 * @typedef {object} ReportData
 * @property {1} version
 * @property {boolean} demo - true for synthetic data; the UI banners it.
 * @property {string} generatedAt - ISO 8601.
 * @property {string} experiment
 * @property {{ taskId: string, stratum: 'long' | 'short' | 'adversarial' | 'chain', description: string }[]} tasks
 * @property {ReportCell[]} cells
 * @property {ReportPair[]} pairs
 * @property {ReportArmSummary[]} arms
 * @property {{ grade: 'improvement' | 'regression' | 'tradeoff' | 'tie', deltaAccuracy: number, mcnemarP: number | null }} comparison
 * @property {import('./trial.js').Trial[]} [trials] - every validated trial, embedded so the report's drill-down needs no fetch.
 */

/**
 * Validate the report payload. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @returns {asserts value is ReportData}
 */
export function validateReportData(value) {
  const r = /** @type {Record<string, unknown>} */ (value)
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error('report must be a record')
  if (r.version !== 1) throw new Error('report.version must be 1')
  if (typeof r.demo !== 'boolean') throw new Error('report.demo must be boolean')
  for (const field of ['generatedAt', 'experiment']) {
    if (typeof r[field] !== 'string' || r[field].length === 0) throw new Error(`report.${field} must be a non-empty string`)
  }
  for (const field of ['tasks', 'cells', 'pairs', 'arms']) {
    if (!Array.isArray(r[field])) throw new Error(`report.${field} must be an array`)
  }
  if (r.trials !== undefined && !Array.isArray(r.trials)) throw new Error('report.trials must be an array when present')
  if (Array.isArray(r.trials)) {
    // Embedded trials are validated with the same rules as trials.jsonl,
    // including the optional chain fields (phases, integrity).
    r.trials.forEach((trial, index) => {
      try {
        validateTrial(trial)
      } catch (error) {
        throw new Error(`report.trials[${index}]: ${/** @type {Error} */ (error).message}`)
      }
    })
  }
  const c = /** @type {Record<string, unknown>} */ (r.comparison)
  if (typeof c !== 'object' || c === null) throw new Error('report.comparison must be a record')
  if (!['improvement', 'regression', 'tradeoff', 'tie'].includes(/** @type {string} */ (c.grade))) {
    throw new Error('report.comparison.grade must be improvement|regression|tradeoff|tie')
  }
}
