/**
 * Report data: the single `ui/data.js` payload the static report renders.
 * Produced by `report/build.js` from run directories; the demo generator emits
 * the same shape with `demo: true`.
 *
 * @module bench/schema/report-data
 */

import { validateTrial } from './trial.js'

/** Task strata the report catalog accepts; unknown values fall back to `long`. */
export const REPORT_STRATA = Object.freeze(['long', 'short', 'adversarial', 'chain', 'pressure'])

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
 * @property {number} meanCompactionCount
 * @property {number} pressureFiredRate - fraction of success trials with pressureFired.
 * @property {number | null} meanCharterRunFailNamed - fraction of trials with a named checkpoint/ship charter failure; null for jspace-off.
 * @property {number | null} meanEmptyCharterRate - mean of per-trial emptyCharterRate; null for jspace-off.
 * @property {number | null} meanUnverifiedShare - mean of per-trial unverifiedShare; null when no trial registered checks.
 * @property {number | null} meanEchoOkRejectRate - mean of per-trial echoOkRejectRate; null when no trial attempted registration.
 */

/**
 * @typedef {object} ReportPair - paired comparison of one task between `off` and one treatment arm.
 * @property {string} taskId
 * @property {string} treatment - intervention arm compared to `off`.
 * @property {number} delta - passRate(treatment) - passRate(off).
 * @property {[number, number]} deltaCi95 - paired bootstrap interval on delta.
 * @property {number | null} mcnemarP - exact McNemar p over discordant trial pairs; null when no discordance.
 * @property {number} wins - trials resolved on the treatment, unresolved off (by trialIndex).
 * @property {number} losses - trials unresolved on the treatment, resolved off.
 * @property {number} ties
 * @property {string} winner - the treatment arm name, `off`, or `tie`, by delta sign.
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
 * @property {number | null} meanDanglingCard - fraction of trials with a dangling card; null for jspace-off.
 * @property {number | null} meanVerifiedCheckpointShare - mean of per-trial verifiedCheckpointShare; null when no trial has checkpoints.
 * @property {number} totalCoverageRefusalThenPad
 * @property {number} totalNoopNoteRefusals
 * @property {number} totalNoteCapRefusals
 * @property {number | null} meanSessionQueryCalls - null for arms excluding session-query.
 * @property {number} totalCompactionCount
 * @property {number} pressureFiredRate - fraction of success trials with pressureFired.
 * @property {number | null} meanCharterRunFailNamed - fraction of trials with a named checkpoint/ship charter failure; null for jspace-off.
 * @property {number | null} meanEmptyCharterRate - mean of per-trial emptyCharterRate; null for jspace-off.
 * @property {number | null} meanUnverifiedShare - mean of per-trial unverifiedShare; null when no trial registered checks.
 * @property {number | null} meanEchoOkRejectRate - mean of per-trial echoOkRejectRate; null when no trial attempted registration.
 */

/**
 * @typedef {object} ReportComparison - one `off` vs treatment pairing for the experiment.
 * @property {string} treatment - intervention arm compared to `off`.
 * @property {'improvement' | 'regression' | 'tradeoff' | 'tie'} grade
 * @property {number} deltaAccuracy - treatment accuracy minus off accuracy.
 * @property {number | null} mcnemarP
 * @property {ReportPair[]} pairs
 */

/**
 * @typedef {object} ReportData
 * @property {1} version
 * @property {boolean} demo - true for synthetic data; the UI banners it.
 * @property {string} generatedAt - ISO 8601.
 * @property {string} experiment
 * @property {{ taskId: string, stratum: 'long' | 'short' | 'adversarial' | 'chain' | 'pressure', description: string }[]} tasks
 * @property {ReportCell[]} cells
 * @property {ReportArmSummary[]} arms
 * @property {ReportComparison[]} comparisons - one entry per non-`off` arm present in the experiment.
 * @property {import('./trial.js').Trial[]} [trials] - every validated trial, embedded so the report's drill-down needs no fetch.
 */

const GRADES = ['improvement', 'regression', 'tradeoff', 'tie']

/**
 * Validate one comparison record. Throws on the first violation.
 * @param {unknown} value - candidate.
 * @param {string} path - error path prefix.
 * @returns {void}
 */
function validateComparison(value, path) {
  const c = /** @type {Record<string, unknown>} */ (value)
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error(`${path} must be a record`)
  if (typeof c.treatment !== 'string' || c.treatment.length === 0) {
    throw new Error(`${path}.treatment must be a non-empty string`)
  }
  if (c.treatment === 'off') throw new Error(`${path}.treatment must not be the baseline arm "off"`)
  if (!GRADES.includes(/** @type {string} */ (c.grade))) {
    throw new Error(`${path}.grade must be improvement|regression|tradeoff|tie`)
  }
  if (typeof c.deltaAccuracy !== 'number') throw new Error(`${path}.deltaAccuracy must be a number`)
  if (c.mcnemarP !== null && typeof c.mcnemarP !== 'number') {
    throw new Error(`${path}.mcnemarP must be a number or null`)
  }
  if (!Array.isArray(c.pairs)) throw new Error(`${path}.pairs must be an array`)
}

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
  for (const field of ['tasks', 'cells', 'arms', 'comparisons']) {
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
  /** @type {unknown[]} */ (r.comparisons).forEach((comparison, index) => {
    validateComparison(comparison, `report.comparisons[${index}]`)
  })
}
