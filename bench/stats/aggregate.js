/**
 * Aggregates over validated Trial records: per task×arm cells and per-arm
 * summaries matching the ReportCell/ReportArmSummary shapes in
 * bench/schema/report-data.js. Trials with status 'error' are infrastructure
 * noise: they surface only in the cell's `errors` count and are excluded from
 * every rate, mean, and total, so all denominators in a cell or summary agree.
 *
 * @module bench/stats/aggregate
 */

import { summarizeAccounting } from '../runner/accounting.js'
import { wilsonInterval } from './intervals.js'

/** TrialMetrics field → ReportCell mean field, in ReportCell order. */
const CELL_MEAN_FIELDS = [
  ['inputTokens', 'meanInputTokens'],
  ['outputTokens', 'meanOutputTokens'],
  ['durationMs', 'meanDurationMs'],
  ['turns', 'meanTurns'],
  ['toolCalls', 'meanToolCalls'],
  ['identicalRetries', 'meanIdenticalRetries'],
  ['checkpoints', 'meanCheckpoints'],
]

/**
 * Aggregate one task×arm group into a ReportCell. `trials` must already be
 * restricted to this task×arm (any status); `taskId` and `arm` are passed
 * explicitly so an empty group still reports its identity.
 * @param {string} taskId
 * @param {string} arm
 * @param {import('../schema/trial.js').Trial[]} trials - the group's trials.
 * @returns {import('../schema/report-data.js').ReportCell}
 */
export function summarizeCell(taskId, arm, trials) {
  const ok = trials.filter(t => t.status === 'success')
  const resolved = ok.filter(t => t.resolved).length
  const cell = {
    taskId,
    arm,
    trials: ok.length,
    errors: trials.length - ok.length,
    resolved,
    passRate: ok.length === 0 ? NaN : resolved / ok.length,
    ci95: wilsonInterval(resolved, ok.length),
  }
  for (const [metric, field] of CELL_MEAN_FIELDS) {
    cell[field] = mean(ok.map(t => t.metrics[metric]))
  }
  // Forensics aggregates
  const danglingValues = ok.map(t => t.metrics.danglingCard).filter(v => v !== null)
  cell.meanDanglingCard = danglingValues.length > 0
    ? danglingValues.filter(v => v === true).length / danglingValues.length
    : null
  const verifiedValues = ok.map(t => t.metrics.verifiedCheckpointShare).filter(v => v !== null)
  cell.meanVerifiedCheckpointShare = verifiedValues.length > 0 ? mean(verifiedValues) : null
  cell.totalCoverageRefusalThenPad = sum(ok.map(t => t.metrics.coverageRefusalThenPad))
  cell.totalNoopNoteRefusals = sum(ok.map(t => t.metrics.noopNoteRefusals))
  cell.totalNoteCapRefusals = sum(ok.map(t => t.metrics.noteCapRefusals))
  const sqValues = ok.map(t => t.metrics.sessionQueryCalls).filter(v => v !== null)
  cell.meanSessionQueryCalls = sqValues.length > 0 ? mean(sqValues) : null
  cell.meanCompactionCount = mean(ok.map(t => t.metrics.compactionCount))
  cell.pressureFiredRate = ok.length === 0 ? NaN : ok.filter(t => t.metrics.pressureFired).length / ok.length
  const namedFails = ok.map(t => t.metrics.charterRunFailNamed).filter(v => v !== null && v !== undefined)
  cell.meanCharterRunFailNamed = namedFails.length > 0
    ? namedFails.filter(v => v === true).length / namedFails.length
    : null
  const emptyCharterValues = ok.map(t => t.metrics.emptyCharterRate).filter(v => typeof v === 'number')
  cell.meanEmptyCharterRate = emptyCharterValues.length > 0 ? mean(emptyCharterValues) : null
  const unverifiedValues = ok.map(t => t.metrics.unverifiedShare).filter(v => v !== null && v !== undefined)
  cell.meanUnverifiedShare = unverifiedValues.length > 0 ? mean(unverifiedValues) : null
  const echoOkValues = ok.map(t => t.metrics.echoOkRejectRate).filter(v => v !== null && v !== undefined)
  cell.meanEchoOkRejectRate = echoOkValues.length > 0 ? mean(echoOkValues) : null
  Object.assign(cell, jevAggregates(ok))
  return /** @type {import('../schema/report-data.js').ReportCell} */ (cell)
}

/**
 * Jev routing/compaction aggregates over one group of success-status trials.
 * Every mean is null when no trial in the group recorded that datum, and every
 * total is null when no trial recorded the event family it counts, so a report
 * distinguishes "measured zero" from "never measured". The trial counts are the
 * pre-registered screens' inputs: `cacheHitShareNullTrials` feeds the churn
 * screen's "≥80% of trials carry a reported cache-read count" (the share is the
 * root session's `metrics.cacheHitShare`), `routingDecisionTrials` the
 * routing-adoption screen's "≥2/3 of route-on trials log a decision", and
 * `compactionVerificationTrials` the verification-adoption screen's "≥2/3 of
 * trials that compact log a verification".
 * @param {import('../schema/trial.js').Trial[]} ok - trials with status success.
 * @returns {{ meanCacheHitShare: number | null, cacheHitShareNullTrials: number, meanCacheUnreportedShare: number | null,
 *   meanModelTransitions: number | null, routingDecisionTrials: number,
 *   meanDowngradedShare: number | null, meanKeptStrongShare: number | null,
 *   meanDowngradedStreakLongest: number | null, totalDowngradedRuns: number,
 *   totalRoutingHintCount: number | null, compactionVerificationTrials: number,
 *   totalJevCompactionAcceptedBelowThreshold: number | null,
 *   totalJevSelectionDegraded: number | null }} the group's Jev aggregate fields.
 */
function jevAggregates(ok) {
  const present = field => ok.map(t => t.metrics[field]).filter(v => v !== null && v !== undefined)
  const cacheShares = present('cacheHitShare')
  const unreportedShares = present('cacheUnreportedShare')
  const transitions = present('modelTransitions')
  const downgradedShares = present('downgradedShare')
  const keptStrongShares = present('keptStrongShare')
  const routingHints = present('routingHintCount')
  const selectionDegraded = present('jevSelectionDegraded')
  // A non-null verdict count is the fold's witness that the trial logged at
  // least one `compaction/verification` event.
  const verified = ok.filter(t => t.metrics.jevCompactionAcceptedBelowThreshold !== null && t.metrics.jevCompactionAcceptedBelowThreshold !== undefined)
  const belowThreshold = present('jevCompactionAcceptedBelowThreshold')
  // A recorded streak list is the fold's witness that the trial logged at least
  // one routing decision (an empty list still means the router judged turns).
  const judged = ok.filter(t => Array.isArray(t.metrics.downgradedStreaks))
  return {
    meanCacheHitShare: cacheShares.length > 0 ? mean(cacheShares) : null,
    cacheHitShareNullTrials: ok.length - cacheShares.length,
    meanCacheUnreportedShare: unreportedShares.length > 0 ? mean(unreportedShares) : null,
    meanModelTransitions: transitions.length > 0 ? mean(transitions) : null,
    routingDecisionTrials: judged.length,
    meanDowngradedShare: downgradedShares.length > 0 ? mean(downgradedShares) : null,
    meanKeptStrongShare: keptStrongShares.length > 0 ? mean(keptStrongShares) : null,
    meanDowngradedStreakLongest: judged.length > 0
      ? mean(judged.map(t => Math.max(0, ...(t.metrics.downgradedStreaks ?? []))))
      : null,
    totalDowngradedRuns: sum(ok.map(t => t.metrics.downgradedStreaks?.length ?? 0)),
    totalRoutingHintCount: routingHints.length > 0 ? sum(routingHints) : null,
    compactionVerificationTrials: verified.length,
    totalJevCompactionAcceptedBelowThreshold: belowThreshold.length > 0 ? sum(belowThreshold) : null,
    totalJevSelectionDegraded: selectionDegraded.length > 0 ? sum(selectionDegraded) : null,
  }
}

/**
 * Aggregate every task×arm group present in `trials`, sorted by taskId then arm.
 * @param {import('../schema/trial.js').Trial[]} trials - any arm's or experiment's trials.
 * @returns {import('../schema/report-data.js').ReportCell[]}
 */
export function summarizeCells(trials) {
  const groups = new Map()
  for (const t of trials) {
    const key = JSON.stringify([t.taskId, t.arm])
    const group = groups.get(key)
    if (group) group.push(t)
    else groups.set(key, [t])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [taskId, arm] = JSON.parse(key)
      return summarizeCell(taskId, arm, group)
    })
}

/**
 * Aggregate one arm into a ReportArmSummary over all its tasks.
 * @param {string} arm - arm name; passed explicitly so an empty arm still reports.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the arm.
 * @returns {import('../schema/report-data.js').ReportArmSummary}
 */
export function summarizeArm(arm, trials) {
  const ok = trials.filter(t => t.status === 'success')
  const resolved = ok.filter(t => t.resolved).length
  const accuracy = ok.length === 0 ? NaN : resolved / ok.length
  const danglingValues = ok.map(t => t.metrics.danglingCard).filter(v => v !== null)
  const verifiedValues = ok.map(t => t.metrics.verifiedCheckpointShare).filter(v => v !== null)
  const sqValues = ok.map(t => t.metrics.sessionQueryCalls).filter(v => v !== null)
  const namedFails = ok.map(t => t.metrics.charterRunFailNamed).filter(v => v !== null && v !== undefined)
  const emptyCharterValues = ok.map(t => t.metrics.emptyCharterRate).filter(v => typeof v === 'number')
  const unverifiedValues = ok.map(t => t.metrics.unverifiedShare).filter(v => v !== null && v !== undefined)
  const echoOkValues = ok.map(t => t.metrics.echoOkRejectRate).filter(v => v !== null && v !== undefined)
  return {
    arm,
    accuracy,
    stderr: ok.length === 0 ? NaN : Math.sqrt((accuracy * (1 - accuracy)) / ok.length),
    ci95: wilsonInterval(resolved, ok.length),
    totalInputTokens: sum(ok.map(t => t.metrics.inputTokens)),
    totalOutputTokens: sum(ok.map(t => t.metrics.outputTokens)),
    totalDurationMs: sum(ok.map(t => t.metrics.durationMs)),
    meanTurns: mean(ok.map(t => t.metrics.turns)),
    totalIdenticalRetries: sum(ok.map(t => t.metrics.identicalRetries)),
    trials: ok.length,
    meanDanglingCard: danglingValues.length > 0
      ? danglingValues.filter(v => v === true).length / danglingValues.length
      : null,
    meanVerifiedCheckpointShare: verifiedValues.length > 0 ? mean(verifiedValues) : null,
    totalCoverageRefusalThenPad: sum(ok.map(t => t.metrics.coverageRefusalThenPad)),
    totalNoopNoteRefusals: sum(ok.map(t => t.metrics.noopNoteRefusals)),
    totalNoteCapRefusals: sum(ok.map(t => t.metrics.noteCapRefusals)),
    meanSessionQueryCalls: sqValues.length > 0 ? mean(sqValues) : null,
    totalCompactionCount: sum(ok.map(t => t.metrics.compactionCount)),
    pressureFiredRate: ok.length === 0 ? NaN : ok.filter(t => t.metrics.pressureFired).length / ok.length,
    meanCharterRunFailNamed: namedFails.length > 0
      ? namedFails.filter(v => v === true).length / namedFails.length
      : null,
    meanEmptyCharterRate: emptyCharterValues.length > 0 ? mean(emptyCharterValues) : null,
    meanUnverifiedShare: unverifiedValues.length > 0 ? mean(unverifiedValues) : null,
    meanEchoOkRejectRate: echoOkValues.length > 0 ? mean(echoOkValues) : null,
    ...jevAggregates(ok),
    accounting: summarizeAccounting(ok),
  }
}

/**
 * Arithmetic mean; NaN for empty input, matching the passRate convention.
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  return values.length === 0 ? NaN : sum(values) / values.length
}

/**
 * Sum of a numeric list; 0 for empty input.
 * @param {number[]} values
 * @returns {number}
 */
function sum(values) {
  let total = 0
  for (const v of values) total += v
  return total
}
