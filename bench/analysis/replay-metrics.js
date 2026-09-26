/**
 * Replay arithmetic over cold-point rows and an explicit experiment method.
 * Coverage divides routed rows by ALL cold points; entryRate divides by ELIGIBLE
 * rows. AUROC and ECE use answered rows. False-downgrade divides insufficient
 * labels by routed rows. Unlabelled rows remain in these denominators; an unknown
 * label refuses the dependent metric, never the label-free counts or rates.
 * Threshold search refuses if any candidate point has unknown false-downgrade.
 * Numerical choices come from method fields without defaults. The method hash
 * must match each row's producing method, source, trigger table and reason.
 * No model, data collection or registration write occurs in this module.
 * @module
 */
import { percentile } from './routing-gate.js'

import { parseReplayMethod, MethodProvenanceError, TIE_BREAK_KEYS } from '../routing/replay-method.js'
export { REPLAY_ROW_SEMANTICS_VERSION, TIE_BREAK_KEYS } from '../routing/replay-method.js'

/**
 * The route answer's option id for keeping the strong route. Restated from the
 * router's `KEEP_CURRENT_OPTION_ID` (model-router config.ts); bench is
 * standalone tooling and imports no package source.
 */
export const KEEP_CURRENT_OPTION_ID = 'keep-current'

/**
 * One entry consult at one replayed cold point (`held` undefined). Every cold
 * point in the replay set is one row, including points where the router would
 * not ask. The answered-row fields are read exactly as the router reads them.
 * @typedef {object} ReplayRow
 * @property {string} task - the task id.
 * @property {'S' | 'C'} arm - source trial arm.
 * @property {string} methodSha256 - canonical hash of the producing method.
 * @property {'routine' | 'moderate' | 'hard'} stratum - the task's preregistered stratum.
 * @property {string} coldPointId - the cold point within the task's replay.
 * @property {boolean} eligible - at least one pool candidate passes the router's deterministic
 *   eligibility for this state; false means no ask was made.
 * @property {boolean} answered - the engine answered, and the fitting neither returned `unfit`
 *   nor `invalid-answer`.
 * @property {boolean | null} truncated - the current entry fit truncated the selected state, from
 *   the logged judgment token fit; null unless answered.
 * @property {number | null} headTokens - the fit's head-token count; null unless answered.
 * @property {string | null} winner - the route choice option: `keep-current` or a candidate id;
 *   null unless answered.
 * @property {number | null} confidence - the route answer's confidence as the router reads it,
 *   the engine-defined concentration that `downgradeThreshold` compares; null unless answered.
 * @property {number | null} margin - `routeMargin` of the answer's distribution: top1 minus top2
 *   over the whole distribution, the quantity `downgradeMargin` compares; null unless answered.
 * @property {number | null} pCheap - `1 - P(keep-current)`, the probability mass on downgrading;
 *   the AUROC and ECE score; null unless answered.
 * @property {number | null} difficultyScore - the difficulty answer's score, which an answered row
 *   always carries when the composition sets difficulty instructions; null unless answered.
 * @property {{ status: 'labelled', cheapSufficient: boolean, source: 'c-trajectory', triggerTableId: string } | { status: 'unlabelled', reason: 'no-label-source-for-arm' | 'final-window-unlabelled' }} label - the explicit trajectory label, or the reason no label source applies (an S trial, or the unlabelled final window); unlabelled rows are counted, never dropped.
 */

/**
 * Validate one labelled-scores row, throwing on the first malformed field.
 * @param {ReplayRow} row - the parsed JSON row.
 * @param {string} where - the row's location for error messages.
 * @returns {ReplayRow} the same row, validated.
 */
export function validateReplayRow(row, where) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`${where}: a labelled-scores row must be a JSON object`)
  }
  for (const key of ['task', 'stratum', 'coldPointId']) {
    if (typeof row[key] !== 'string' || row[key] === '') throw new TypeError(`${where}: ${key} must be a non-empty string`)
  }
  if (Object.hasOwn(row, 'cheapSufficient')) throw new TypeError(`${where}: cheapSufficient must be represented by label`)
  if (row.arm !== 'S' && row.arm !== 'C') throw new TypeError(`${where}: arm must be S or C`)
  if (typeof row.methodSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.methodSha256)) throw new TypeError(`${where}: methodSha256 must be a SHA256 hex string`)
  for (const key of ['eligible', 'answered']) {
    if (typeof row[key] !== 'boolean') throw new TypeError(`${where}: ${key} must be a boolean`)
  }
  const label = row.label
  if (label === null || typeof label !== 'object' || Array.isArray(label)) {
    throw new TypeError(`${where}: label must be the labelled/unlabelled union the labeller emits`)
  }
  const keys = label.status === 'labelled' ? ['status', 'cheapSufficient', 'source', 'triggerTableId'] : ['status', 'reason']
  if (Object.keys(label).some(key => !keys.includes(key))) throw new TypeError(`${where}: unknown label field`)
  if (label.status === 'labelled') {
    if (typeof label.cheapSufficient !== 'boolean') throw new TypeError(`${where}: label.cheapSufficient must be a boolean on a labelled row`)
    if (label.source !== 'c-trajectory') throw new TypeError(`${where}: label.source must be 'c-trajectory' on a labelled row`)
    if (typeof label.triggerTableId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(label.triggerTableId)) throw new TypeError(`${where}: label.triggerTableId must be a non-empty string on a labelled row`)
  } else if (label.status === 'unlabelled') {
    if (label.reason !== 'no-label-source-for-arm' && label.reason !== 'final-window-unlabelled') {
      throw new TypeError(`${where}: label.reason must be 'no-label-source-for-arm' or 'final-window-unlabelled'`)
    }
  } else {
    throw new TypeError(`${where}: label.status must be 'labelled' or 'unlabelled'`)
  }
  if (!row.answered) {
    for (const key of ['truncated', 'headTokens', 'winner', 'confidence', 'margin', 'pCheap', 'difficultyScore']) {
      if (row[key] !== null) throw new TypeError(`${where}: ${key} must be null on an unanswered row`)
    }
    return row
  }
  if (typeof row.truncated !== 'boolean') throw new TypeError(`${where}: truncated must be a boolean on an answered row`)
  if (!Number.isSafeInteger(row.headTokens) || row.headTokens < 0) {
    throw new TypeError(`${where}: headTokens must be a non-negative integer on an answered row`)
  }
  if (typeof row.winner !== 'string' || row.winner === '') throw new TypeError(`${where}: winner must be a non-empty string on an answered row`)
  for (const key of ['confidence', 'margin', 'pCheap']) {
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1) {
      throw new TypeError(`${where}: ${key} must be a number from 0 through 1 on an answered row`)
    }
  }
  if (typeof row.difficultyScore !== 'number' || !Number.isFinite(row.difficultyScore)) {
    throw new TypeError(`${where}: difficultyScore must be a finite number on an answered row`)
  }
  return row
}

/**
 * Raised when a label-dependent metric's own denominator contains unlabelled
 * rows: the metric refuses rather than filter, rescale, or produce a partial
 * figure, and the gate verdict reads `method-unpinned`.
 */
export class UnlabelledRowsError extends TypeError {
  /**
   * @param {string} metric - the refusing metric.
   * @param {Record<string, number>} countsByReason - unlabelled-row counts by reason.
   */
  constructor(metric, countsByReason) {
    super(`metric ${metric} refuses: ${Object.entries(countsByReason).map(([reason, count]) => `${count} unlabelled (${reason})`).join(', ')} in its denominator`)
    this.name = 'UnlabelledRowsError'
    this.metric = metric
    this.countsByReason = countsByReason
  }
}

/**
 * The trajectory label of one row, for the label-dependent figures: `true`
 * and `false` for labelled rows, `undefined` for unlabelled rows.
 * @param {ReplayRow} row - the row to read.
 * @returns {boolean | undefined} the cheap-sufficient label, or undefined when unlabelled.
 */
function labelOf(row) {
  return row.label.status === 'labelled' ? row.label.cheapSufficient : undefined
}

/**
 * Count the unlabelled rows in one denominator by reason.
 * @param {readonly ReplayRow[]} rows - the denominator's rows.
 * @returns {Record<string, number> | null} counts by reason, or null when every row is labelled.
 */
function unlabelledCounts(rows) {
  const counts = {}
  for (const row of rows) {
    if (row.label.status !== 'unlabelled') continue
    counts[row.label.reason] = (counts[row.label.reason] ?? 0) + 1
  }
  return Object.keys(counts).length === 0 ? null : counts
}

/** Check method identity before any metric consumes a row. */
function verifyProvenance(row, method, methodSha256) {
  if (row.methodSha256 !== methodSha256) throw new MethodProvenanceError('row method hash mismatch')
  const source = method.labelSources?.[row.arm]
  if (row.label.status === 'labelled') {
    if (row.arm !== 'C' || row.label.source !== source || row.label.triggerTableId !== method.triggerTableId) throw new MethodProvenanceError('label source or trigger table does not match the method')
  } else if (row.label.reason === 'no-label-source-for-arm') {
    if (source !== 'unlabelled') throw new MethodProvenanceError('unlabelled source reason does not match the method')
  } else if (source !== 'c-trajectory' || method.finalWindow !== 'unlabelled') {
    throw new MethodProvenanceError('unlabelled final-window reason does not match the method')
  }
}

/**
 * Parse the labelled-scores JSONL: one {@link ReplayRow} per line, blank lines
 * skipped. Rows must be unique per (task, coldPointId); the calibration run is
 * one repeat, so a repeat dimension would be a new row schema.
 * @param {string} text - the JSONL document.
 * @returns {ReplayRow[]} the validated rows in file order.
 */
export function parseLabelledScores(text) {
  const rows = []
  const seen = new Set()
  for (const [index, line] of text.split('\n').entries()) {
    const where = `labelled-scores line ${index + 1}`
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new SyntaxError(`${where}: not valid JSON (${error.message})`)
    }
    const row = validateReplayRow(parsed, where)
    const key = JSON.stringify([row.task, row.arm, row.coldPointId])
    if (seen.has(key)) throw new TypeError(`${where}: duplicate cold-point row for task ${JSON.stringify(row.task)}`)
    seen.add(key)
    rows.push(row)
  }
  if (rows.length === 0) throw new TypeError('labelled-scores input carries no rows')
  return rows
}

/**
 * Rank-based AUROC with ties counted as 0.5, over the given samples.
 * @param {{ score: number, positive: boolean }[]} samples - one score and label per sample.
 * @returns {number | null} the AUROC, or null when either class is empty — a
 *   sample with no positive or no negative demonstrates no discrimination.
 */
export function auroc(samples) {
  const positives = samples.filter(sample => sample.positive).length
  const negatives = samples.length - positives
  if (positives === 0 || negatives === 0) return null
  const order = [...samples].sort((a, b) => a.score - b.score)
  let positiveRankSum = 0
  let start = 0
  while (start < order.length) {
    let end = start
    while (end < order.length && order[end].score === order[start].score) end += 1
    // The tie block occupies ranks start+1 through end; each member takes their average.
    const averageRank = (start + 1 + end) / 2
    for (let at = start; at < end; at += 1) {
      if (order[at].positive) positiveRankSum += averageRank
    }
    start = end
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

/**
 * Expected calibration error of the score against the label over equal-width
 * bins on [0, 1]: the count-weighted mean of each non-empty bin's absolute
 * mean-gap. The last bin is closed, so a score of 1 lands inside the grid.
 * @param {{ score: number, positive: boolean }[]} samples - one score and label per sample.
 * @param {number} binCount - the preregistered bin count; required, no default.
 * @returns {{ ece: number, bins: { lower: number, upper: number, count: number, meanScore: number | null, meanLabel: number | null }[] }} the ECE and the per-bin table for the report.
 */
export function ece(samples, binCount) {
  if (!Number.isSafeInteger(binCount) || binCount < 1) {
    throw new TypeError(`ece bin count must be a positive integer, got ${JSON.stringify(binCount)}`)
  }
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    scoreSum: 0,
    labelSum: 0,
    meanScore: null,
    meanLabel: null,
  }))
  for (const sample of samples) {
    const index = Math.min(Math.floor(sample.score * binCount), binCount - 1)
    const bin = bins[index]
    bin.count += 1
    bin.scoreSum += sample.score
    bin.labelSum += sample.positive ? 1 : 0
  }
  let total = 0
  for (const bin of bins) {
    if (bin.count > 0) {
      bin.meanScore = bin.scoreSum / bin.count
      bin.meanLabel = bin.labelSum / bin.count
      total += (bin.count / samples.length) * Math.abs(bin.meanLabel - bin.meanScore)
    }
    delete bin.scoreSum
    delete bin.labelSum
  }
  return { ece: total, bins }
}

/**
 * The gate bounds, passed explicitly from the registration's
 * `operatingPoint.layaGate` block — never defaulted here.
 * @typedef {object} LayaGateBounds
 * @property {number} aurocMin - minimum AUROC (preregistered 0.70).
 * @property {number} falseDowngradeMax - maximum false-downgrade share at the chosen point (preregistered 0.10).
 * @property {number} coverageMin - minimum coverage of cold points at the chosen point (preregistered 0.15).
 */

/**
 * The fixed entry conditions, passed explicitly from the R overlay — never
 * defaulted or searched here.
 * @typedef {object} FixedEntryConditions
 * @property {number} entryScoreCeiling - the R overlay's fixed difficulty ceiling; a row at or
 *   above it never routes at any operating point.
 * @property {string[]} candidateIds - the R overlay's pool candidate ids; only these winners route.
 */

/** Explicit method and fixed conditions for replay arithmetic.
 * @typedef {object} ReplayMetricsOptions
 * @property {object} method - validated replay method inputs, without defaults.
 * @property {LayaGateBounds} gate - bounds from the registration.
 * @property {FixedEntryConditions} entry - fixed conditions from the R overlay.
 */

/**
 * Refusal of a label-dependent metric; unknown labels are never scored as zero.
 * @typedef {object} LabelRefusal
 * @property {'refused'} status
 * @property {'unlabelled-rows'} reason
 * @property {number} unlabelledInDenominator
 */

/**
 * Replay results, with method provenance and explicit unevaluable states.
 * @typedef {object} ReplayMetricsResult
 * @property {object} method - method fields plus canonical methodSha256.
 * @property {FixedEntryConditions} fixed
 * @property {{ rows: number, eligible: number, answered: number, unanswered: number, truncated: number, routed: number | null, falseDowngrades: number | null }} counts - selected-point counts are null for a refused search.
 * @property {{ status: 'evaluated', auroc: number | null, positives: number, negatives: number } | LabelRefusal} discrimination
 * @property {{ status: 'evaluated', ece: number | null, bins: object[] } | LabelRefusal} calibration
 * @property {{ total: number, byArm: {S: number, C: number}, byReason: Record<string, number> }} unlabelled
 * @property {{ headTokensMean: number | null, headTokensP95: number | null, truncationRate: number | null, unansweredRate: number }} tokens
 * @property {{ downgradeThreshold: number, downgradeMargin: number, routes: number, coverage: number, entryRate: number | null, falseDowngrades: number | null, falseDowngrade: number | null, feasible: boolean | null, falseDowngradeStatus: 'evaluated' | 'refused-unlabelled' }[]} curve - all grid points, including label-free rates at refused points.
 * @property {{ status: 'evaluated', downgradeThreshold: number, downgradeMargin: number, routes: number, coverage: number, entryRate: number, falseDowngrades: number, falseDowngrade: number } | { status: 'refused', reason: 'unlabelled-rows' } | null} operatingPoint - null means no feasible point in an evaluated search.
 * @property {{ status: 'evaluated' | 'method-unpinned', passed: boolean | null, legs: { auroc: boolean | null, feasiblePoint: boolean | null, coverage: boolean | null }, bounds: LayaGateBounds, reading: string }} gate - an unevaluable gate neither passes nor fails.
 */

/**
 * Compute the replay metrics and the Laya replay gate over labelled-scores rows.
 *
 * A row routes at (t, m) only when it passes every fixed condition — eligible
 * and answered, difficultyScore below the fixed ceiling, and a winner that is
 * a pool candidate and not `keep-current` — and then confidence >= t and
 * margin >= m. A row that fails a fixed condition never routes, at any
 * (t, m). The grid is exhaustive over the distinct confidence and margin
 * values of the rows that pass the fixed conditions.
 * @param {ReplayRow[]} rows - one row per replayed cold point.
 * @param {ReplayMetricsOptions} options - the preregistered method inputs, gate bounds, and fixed conditions; every field is required.
 * @returns {ReplayMetricsResult} the metrics, curve, operating point, and gate verdict.
 */
export function computeReplayMetrics(rows, options) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('computeReplayMetrics needs at least one row')
  const { method, methodSha256, gate: bounds, entry } = readOptions(options)
  const { eceBins, tieBreak } = method
  const seen = new Set()
  for (const [index, row] of rows.entries()) {
    validateReplayRow(row, 'row ' + index)
    const key = JSON.stringify([row.task, row.arm, row.coldPointId])
    if (seen.has(key)) throw new TypeError('duplicate cold-point row: ' + key)
    seen.add(key)
    verifyProvenance(row, method, methodSha256)
  }
  const answeredRows = rows.filter(row => row.answered)
  const eligibleRows = rows.filter(row => row.eligible)
  const candidateIds = new Set(entry.candidateIds)
  const candidates = rows.filter(row => row.eligible && row.answered
    && row.difficultyScore < entry.entryScoreCeiling
    && row.winner !== KEEP_CURRENT_OPTION_ID && candidateIds.has(row.winner))
  const unlabelledRows = rows.filter(row => row.label.status === 'unlabelled')
  const unlabelled = { total: unlabelledRows.length, byArm: { S: 0, C: 0 }, byReason: {} }
  for (const row of unlabelledRows) {
    unlabelled.byArm[row.arm] += 1
    const reason = row.label.reason
    unlabelled.byReason[reason] = (unlabelled.byReason[reason] ?? 0) + 1
  }
  const missingAnswered = answeredRows.filter(row => row.label.status === 'unlabelled').length
  const samples = missingAnswered === 0
    ? answeredRows.map(row => ({ score: row.pCheap, positive: row.label.cheapSufficient })) : []
  const refusal = { status: 'refused', reason: 'unlabelled-rows', unlabelledInDenominator: missingAnswered }
  const discrimination = missingAnswered > 0 ? { ...refusal } : {
    status: 'evaluated', auroc: auroc(samples),
    positives: samples.filter(sample => sample.positive).length,
    negatives: samples.filter(sample => !sample.positive).length,
  }
  const calibration = missingAnswered > 0 ? { ...refusal } : {
    status: 'evaluated', ...(answeredRows.length > 0 ? ece(samples, eceBins) : { ece: null, bins: [] }),
  }
  const thresholds = [...new Set(candidates.map(row => row.confidence))].sort((a, b) => b - a)
  const margins = [...new Set(candidates.map(row => row.margin))].sort((a, b) => b - a)
  const curve = []
  for (const downgradeThreshold of thresholds) {
    for (const downgradeMargin of margins) {
      const routed = candidates.filter(row => row.confidence >= downgradeThreshold && row.margin >= downgradeMargin)
      const missingLabels = routed.some(row => row.label.status === 'unlabelled')
      const falseDowngrades = missingLabels ? null : routed.filter(row => !row.label.cheapSufficient).length
      const falseDowngrade = missingLabels || routed.length === 0 ? null : falseDowngrades / routed.length
      curve.push({
        downgradeThreshold, downgradeMargin, routes: routed.length,
        coverage: routed.length / rows.length,
        entryRate: eligibleRows.length === 0 ? null : routed.length / eligibleRows.length,
        falseDowngrades, falseDowngrade,
        falseDowngradeStatus: missingLabels ? 'refused-unlabelled' : 'evaluated',
        feasible: missingLabels ? null : routed.length > 0 && falseDowngrade !== null && falseDowngrade <= bounds.falseDowngradeMax,
      })
    }
  }
  const searchRefused = curve.some(point => point.feasible === null)
  const selected = searchRefused ? null : chooseOperatingPoint(curve, tieBreak)
  const operatingPoint = searchRefused ? { status: 'refused', reason: 'unlabelled-rows' }
    : selected === null ? null : { ...selected, status: 'evaluated' }
  const gateRefused = searchRefused || missingAnswered > 0
  const legs = gateRefused ? { auroc: null, feasiblePoint: null, coverage: null } : {
    auroc: discrimination.auroc !== null && discrimination.auroc >= bounds.aurocMin,
    feasiblePoint: selected !== null,
    coverage: selected !== null && selected.coverage >= bounds.coverageMin,
  }
  const failed = Object.entries(legs).filter(([, ok]) => !ok).map(([leg]) => leg)
  const headTokens = answeredRows.map(row => row.headTokens)
  const truncatedCount = answeredRows.filter(row => row.truncated).length
  return {
    method: { ...method, methodSha256 },
    fixed: { entryScoreCeiling: entry.entryScoreCeiling, candidateIds: [...entry.candidateIds] },
    counts: {
      rows: rows.length, eligible: eligibleRows.length, answered: answeredRows.length,
      unanswered: rows.length - answeredRows.length, truncated: truncatedCount,
      routed: searchRefused ? null : selected?.routes ?? 0,
      falseDowngrades: searchRefused ? null : selected?.falseDowngrades ?? 0,
    },
    discrimination, calibration, unlabelled,
    tokens: {
      headTokensMean: headTokens.length === 0 ? null : headTokens.reduce((sum, value) => sum + value, 0) / headTokens.length,
      headTokensP95: headTokens.length === 0 ? null : percentile(headTokens, 95),
      truncationRate: answeredRows.length === 0 ? null : truncatedCount / answeredRows.length,
      unansweredRate: (rows.length - answeredRows.length) / rows.length,
    },
    curve, operatingPoint,
    gate: {
      status: gateRefused ? 'method-unpinned' : 'evaluated',
      passed: gateRefused ? null : failed.length === 0,
      legs, bounds: { ...bounds },
      reading: gateRefused ? 'gate not evaluable: unlabelled rows in label-dependent denominators'
        : failed.length === 0 ? 'replay gate passed' : 'replay gate failed on ' + failed.join(' and '),
    },
  }
}

/** Validate the required options of {@link computeReplayMetrics}; nothing is defaulted. */
function readOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('computeReplayMetrics requires an options object')
  if (Object.hasOwn(options, 'eceBins') || Object.hasOwn(options, 'tieBreak')) throw new TypeError('eceBins and tieBreak belong in options.method')
  const { method, methodSha256 } = parseReplayMethod(options.method, { require: ['version', 'eceBins', 'tieBreak'] })
  const { gate, entry } = options
  if (gate === null || typeof gate !== 'object') throw new TypeError('options.gate is required: the registration layaGate bounds')
  for (const key of ['aurocMin', 'falseDowngradeMax', 'coverageMin']) {
    const value = gate[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`options.gate.${key} must be a number from 0 through 1`)
    }
  }
  if (entry === null || typeof entry !== 'object') throw new TypeError('options.entry is required: the fixed entry conditions from the R overlay')
  if (typeof entry.entryScoreCeiling !== 'number' || !Number.isFinite(entry.entryScoreCeiling)) {
    throw new TypeError('options.entry.entryScoreCeiling must be a finite number')
  }
  if (!Array.isArray(entry.candidateIds) || entry.candidateIds.length === 0 || entry.candidateIds.some(id => typeof id !== 'string' || id === '')) {
    throw new TypeError('options.entry.candidateIds must be a non-empty array of non-empty strings')
  }
  return { method, methodSha256, gate, entry }
}

/**
 * Select the operating point: maximum coverage over feasible points, then the
 * preregistered tie-break in order (a lower false-downgrade wins; higher
 * threshold and margin win). Feasible means at least one routed row and a
 * false-downgrade within the bound; with no feasible point there is no
 * operating point and the gate fails on that leg.
 * @param {ReplayMetricsResult['curve']} curve - the searched points.
 * @param {string[]} tieBreak - the preregistered tie-break keys, in order.
 * @returns {ReplayMetricsResult['operatingPoint']} the chosen point, or null.
 */
function chooseOperatingPoint(curve, tieBreak) {
  const feasible = curve.filter(point => point.feasible)
  if (feasible.length === 0) return null
  let best = feasible[0]
  for (const point of feasible.slice(1)) {
    if (better(point, best, tieBreak)) best = point
  }
  const { feasible: _feasible, falseDowngradeStatus: _status, ...chosen } = best
  return chosen
}

/** Whether `point` beats `best` under maximum coverage and the tie-break order. */
function better(point, best, tieBreak) {
  if (point.coverage !== best.coverage) return point.coverage > best.coverage
  for (const key of tieBreak) {
    const value = point[key]
    const against = best[key]
    if (value === against) continue
    return TIE_BREAK_KEYS[key] === 'asc' ? value < against : value > against
  }
  return false
}
