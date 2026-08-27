/**
 * Aggregates over validated Trial records: per task×arm cells and per-arm
 * summaries matching the ReportCell/ReportArmSummary shapes in
 * bench/schema/report-data.js. Trials with status 'error' are infrastructure
 * noise: they surface only in the cell's `errors` count and are excluded from
 * every rate, mean, and total, so all denominators in a cell or summary agree.
 *
 * @module bench/stats/aggregate
 */

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
  return /** @type {import('../schema/report-data.js').ReportCell} */ (cell)
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
