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
 * @property {number | null} meanCacheHitShare - mean of per-trial cacheHitShare; null when no trial carried usage.
 * @property {number} cacheHitShareNullTrials - success trials with a null cacheHitShare: the pre-registered churn screen's input.
 * @property {number | null} meanModelTransitions - mean of per-trial modelTransitions; null when no trial logged a request header.
 * @property {number} routingDecisionTrials - success trials logging at least one routing decision: the adoption screen's input.
 * @property {number | null} meanDowngradedShare - mean of per-trial downgradedShare; null when no trial logged a decision.
 * @property {number | null} meanKeptStrongShare - mean of per-trial keptStrongShare; null when no trial logged a decision.
 * @property {number | null} meanDowngradedStreakLongest - mean longest downgraded run over the trials that logged a decision; null when none did.
 * @property {number} totalDowngradedRuns - downgraded runs summed over the group's trials.
 * @property {number | null} totalRoutingHintCount - routing hints summed over the trials that logged a decision; null when none did.
 * @property {number} compactionVerificationTrials - success trials logging at least one compaction verification: the verification-adoption screen's input.
 * @property {number | null} totalJevCompactionAcceptedBelowThreshold - below-threshold acceptances summed over the trials that logged a verification; null when none did.
 * @property {number | null} totalJevSelectionDegraded - degraded selections summed over the trials that logged a selection; null when none did.
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
 * @property {number | null} meanCacheHitShare - mean of per-trial cacheHitShare; null when no trial carried usage.
 * @property {number} cacheHitShareNullTrials - success trials with a null cacheHitShare: the pre-registered churn screen's input.
 * @property {number | null} meanModelTransitions - mean of per-trial modelTransitions; null when no trial logged a request header.
 * @property {number} routingDecisionTrials - success trials logging at least one routing decision: the adoption screen's input.
 * @property {number | null} meanDowngradedShare - mean of per-trial downgradedShare; null when no trial logged a decision.
 * @property {number | null} meanKeptStrongShare - mean of per-trial keptStrongShare; null when no trial logged a decision.
 * @property {number | null} meanDowngradedStreakLongest - mean longest downgraded run over the trials that logged a decision; null when none did.
 * @property {number} totalDowngradedRuns - downgraded runs summed over the group's trials.
 * @property {number | null} totalRoutingHintCount - routing hints summed over the trials that logged a decision; null when none did.
 * @property {number} compactionVerificationTrials - success trials logging at least one compaction verification: the verification-adoption screen's input.
 * @property {number | null} totalJevCompactionAcceptedBelowThreshold - below-threshold acceptances summed over the trials that logged a verification; null when none did.
 * @property {number | null} totalJevSelectionDegraded - degraded selections summed over the trials that logged a selection; null when none did.
 * @property {import('../runner/accounting.js').AccountingSummary | null} accounting - pooled priced accounting over the
 *   arm's success trials: dollars and their upper bound, quota tokens, raw tokens by class, cache-hit and unreported
 *   shares, judge calls and latency, and TTFT percentiles; null when no trial carries accounting.
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
 * @property {import('../report/verdicts.js').ReportVerdict[]} [verdicts] - the pre-registered Jev hypotheses, each evaluable with an interval or not-evaluable with its reason; every experiment gets the whole block.
 */

const GRADES = ['improvement', 'regression', 'tradeoff', 'tie']

/** Verdict statuses: a rule is either evaluated or declared not-evaluable. */
const VERDICT_STATUSES = ['evaluable', 'not-evaluable']

/** Outcomes of an evaluated verdict. */
const VERDICT_OUTCOMES = ['pass', 'fail']

/**
 * Validate one pre-registered verdict and enforce its honesty invariant: an
 * evaluable verdict carries an outcome, an interval, and no reason; a
 * not-evaluable verdict carries a reason and no outcome — never a default pass
 * and never a fail-by-default. Throws on the first violation.
 * @param {unknown} value - candidate verdict.
 * @param {string} path - error path prefix.
 * @returns {void}
 */
function validateVerdict(value, path) {
  const v = /** @type {Record<string, unknown>} */ (value)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${path} must be a record`)
  for (const field of ['id', 'rule']) {
    if (typeof v[field] !== 'string' || /** @type {string} */ (v[field]).length === 0) {
      throw new Error(`${path}.${field} must be a non-empty string`)
    }
  }
  if (!Array.isArray(v.arms) || v.arms.length === 0 || v.arms.some(arm => typeof arm !== 'string' || arm.length === 0)) {
    throw new Error(`${path}.arms must be a non-empty string array`)
  }
  if (!VERDICT_STATUSES.includes(/** @type {string} */ (v.status))) {
    throw new Error(`${path}.status must be evaluable|not-evaluable`)
  }
  if (!Number.isSafeInteger(v.trials) || /** @type {number} */ (v.trials) < 0) {
    throw new Error(`${path}.trials must be a non-negative integer`)
  }
  if (typeof v.facts !== 'object' || v.facts === null || Array.isArray(v.facts)) {
    throw new Error(`${path}.facts must be a record`)
  }
  if (v.status === 'evaluable') {
    if (!VERDICT_OUTCOMES.includes(/** @type {string} */ (v.outcome))) {
      throw new Error(`${path}.outcome must be pass|fail when the verdict is evaluable`)
    }
    if (v.reason !== null) throw new Error(`${path}.reason must be null when the verdict is evaluable`)
    for (const field of ['observed', 'threshold']) {
      if (typeof v[field] !== 'number' || !Number.isFinite(/** @type {number} */ (v[field]))) {
        throw new Error(`${path}.${field} must be a finite number when the verdict is evaluable`)
      }
    }
    const ci = v.ci95
    if (!Array.isArray(ci) || ci.length !== 2 || ci.some(edge => typeof edge !== 'number' || !Number.isFinite(edge))) {
      throw new Error(`${path}.ci95 must be a finite two-number interval when the verdict is evaluable`)
    }
    return
  }
  if (v.outcome !== null) throw new Error(`${path}.outcome must be null when the verdict is not evaluable`)
  if (typeof v.reason !== 'string' || v.reason.length === 0) {
    throw new Error(`${path}.reason must state why the verdict is not evaluable`)
  }
  for (const field of ['observed', 'threshold', 'ci95']) {
    if (v[field] !== null) throw new Error(`${path}.${field} must be null when the verdict is not evaluable`)
  }
}

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
  if (r.verdicts !== undefined) {
    if (!Array.isArray(r.verdicts)) throw new Error('report.verdicts must be an array when present')
    r.verdicts.forEach((verdict, index) => validateVerdict(verdict, `report.verdicts[${index}]`))
  }
}
