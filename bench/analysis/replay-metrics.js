/**
 * Replay metrics of the PR 16 routing measurement's offline judge replay.
 *
 * Pure functions over the labelled-scores JSONL the replay front end produces:
 * one row per entry consult at one replayed cold point, with the values
 * exactly as the live model-router controller reads them (its `decide()` entry
 * path and `gate()`, and `routeMargin` from its stats fold). The module
 * computes the preregistered discrimination and calibration figures, the
 * coverage/false-downgrade curve over the router's actual gate quantities, the
 * operating point, and the Laya replay gate of
 * `bench/routing/prereg-2026-10.md` (AUROC >= 0.70; at the chosen point
 * false-downgrade <= 10% with coverage >= 15% of cold points; ECE is reported
 * against the preregistered 0.10 clause, whose second disjunct — thresholds
 * read only from the replay curve — always holds here, because the operating
 * point is selected on this curve and on nothing else).
 *
 * The ECE bin count and the operating-point tie-break are preregistered
 * method inputs: both are required arguments with no default, and both are
 * recorded verbatim in the returned `method` block that the registration
 * writer copies into `prereg-2026-10.registration.json`. A changed method is
 * a new experiment name.
 *
 * Denominators, both reported:
 * - **Coverage** (the gate's ">= 15% of cold points") divides by every
 *   cold-point row of the replay set, including points where the router would
 *   not ask.
 * - **Entry rate** (`enforced.entryRate`, arm N's matched rate) divides by the
 *   eligible rows: bench-random draws once per asked consult, and arm N asks
 *   exactly at eligible cold points, so its per-consult rate must use the
 *   asked denominator.
 *
 * @module bench/analysis/replay-metrics
 */
import { percentile } from './routing-gate.js'

/**
 * Version of the pinned row semantics this module implements. The
 * registration writer records it beside the method inputs, so a registration
 * names the exact row semantics its calibration was computed under.
 */
export const REPLAY_ROW_SEMANTICS_VERSION = 'pr16-replay@1'

/**
 * The route answer's option id for keeping the strong route. Restated from the
 * router's `KEEP_CURRENT_OPTION_ID` (model-router config.ts); bench is
 * standalone tooling and imports no package source.
 */
export const KEEP_CURRENT_OPTION_ID = 'keep-current'

/**
 * The supported operating-point tie-break keys and their direction, applied in
 * caller order after the primary objective (maximum coverage): a lower value
 * wins for `falseDowngrade`, a higher value wins for the two gate quantities.
 */
export const TIE_BREAK_KEYS = Object.freeze({
  falseDowngrade: 'asc',
  downgradeThreshold: 'desc',
  downgradeMargin: 'desc',
})

/**
 * One entry consult at one replayed cold point (`held` undefined). Every cold
 * point in the replay set is one row, including points where the router would
 * not ask. The answered-row fields are read exactly as the router reads them.
 * @typedef {object} ReplayRow
 * @property {string} task - the task id.
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
 * @property {boolean} cheapSufficient - the label: C passed the task, and C's trajectory from this
 *   cold point reached the next cold point without a worker-escalation trigger.
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
  for (const key of ['eligible', 'answered', 'cheapSufficient']) {
    if (typeof row[key] !== 'boolean') throw new TypeError(`${where}: ${key} must be a boolean`)
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
    const key = `${row.task}\u0000${row.coldPointId}`
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

/** Required, defaulted-nowhere options of {@link computeReplayMetrics}.
 * @typedef {object} ReplayMetricsOptions
 * @property {number} eceBins - the preregistered ECE bin count; required, no default.
 * @property {('falseDowngrade' | 'downgradeThreshold' | 'downgradeMargin')[]} tieBreak - the
 *   preregistered tie-break, applied in order after maximum coverage; required, no default.
 * @property {LayaGateBounds} gate - the gate bounds from the registration.
 * @property {FixedEntryConditions} entry - the fixed entry conditions from the R overlay.
 */

/**
 * The replay metrics result. `method` is the block the registration writer
 * records; `curve` lists every (threshold, margin) point of the search grid,
 * feasible or not; `operatingPoint` is the selected feasible point or null.
 * @typedef {object} ReplayMetricsResult
 * @property {{ version: string, eceBins: number, tieBreak: string[] }} method - the preregistered method inputs and the row-semantics version.
 * @property {{ entryScoreCeiling: number, candidateIds: string[] }} fixed - the fixed entry conditions used.
 * @property {{ rows: number, eligible: number, answered: number, unanswered: number, truncated: number, routed: number, falseDowngrades: number }} counts - row counts; `routed` and `falseDowngrades` are at the chosen point.
 * @property {{ auroc: number | null, positives: number, negatives: number }} discrimination - AUROC of `pCheap` against `cheapSufficient` over answered rows.
 * @property {{ ece: number | null, bins: object[] }} calibration - ECE of `pCheap` over answered rows with its bin table; null-scored when no answered row exists.
 * @property {{ headTokensMean: number | null, headTokensP95: number | null, truncationRate: number | null, unansweredRate: number }} tokens - truncation and token figures; the rates are over answered rows, the unanswered rate over all rows.
 * @property {{ downgradeThreshold: number, downgradeMargin: number, routes: number, coverage: number, entryRate: number | null, falseDowngrades: number, falseDowngrade: number | null, feasible: boolean }[]} curve - every searched point, threshold descending then margin descending. `coverage` divides by every cold-point row; `entryRate` divides by the eligible rows and is null when none is eligible.
 * @property {{ downgradeThreshold: number, downgradeMargin: number, routes: number, coverage: number, entryRate: number, falseDowngrades: number, falseDowngrade: number } | null} operatingPoint - the chosen point: maximum coverage subject to false-downgrade within the bound, tie-broken by the preregistered order. Its `entryRate` is the eligible-row rate arm N's draw matches.
 * @property {{ passed: boolean, legs: { auroc: boolean, feasiblePoint: boolean, coverage: boolean }, bounds: LayaGateBounds, reading: string }} gate - the Laya replay gate verdict, each leg separately.
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
  const { eceBins, tieBreak, gate: bounds, entry } = readOptions(options)
  for (const [index, row] of rows.entries()) validateReplayRow(row, `row ${index}`)
  const seen = new Set()
  for (const row of rows) {
    const key = `${row.task}\u0000${row.coldPointId}`
    if (seen.has(key)) throw new TypeError(`duplicate cold-point row: task ${JSON.stringify(row.task)}, coldPointId ${JSON.stringify(row.coldPointId)}`)
    seen.add(key)
  }

  const answeredRows = rows.filter(row => row.answered)
  const eligibleRows = rows.filter(row => row.eligible)
  const candidateIds = new Set(entry.candidateIds)
  const candidates = rows.filter(row =>
    row.eligible
    && row.answered
    && row.difficultyScore < entry.entryScoreCeiling
    && row.winner !== KEEP_CURRENT_OPTION_ID
    && candidateIds.has(row.winner),
  )

  const answerSamples = answeredRows.map(row => ({ score: /** @type {number} */ (row.pCheap), positive: row.cheapSufficient }))
  const discriminationValue = auroc(answerSamples)
  const calibration = answeredRows.length > 0 ? ece(answerSamples, eceBins) : { ece: null, bins: [] }

  const thresholds = [...new Set(candidates.map(row => /** @type {number} */ (row.confidence)))].sort((a, b) => b - a)
  const margins = [...new Set(candidates.map(row => /** @type {number} */ (row.margin)))].sort((a, b) => b - a)
  const curve = []
  for (const downgradeThreshold of thresholds) {
    for (const downgradeMargin of margins) {
      const routed = candidates.filter(row => /** @type {number} */ (row.confidence) >= downgradeThreshold && /** @type {number} */ (row.margin) >= downgradeMargin)
      const falseDowngrades = routed.filter(row => !row.cheapSufficient).length
      const falseDowngrade = routed.length === 0 ? null : falseDowngrades / routed.length
      const feasible = routed.length > 0 && falseDowngrade !== null && falseDowngrade <= bounds.falseDowngradeMax
      curve.push({
        downgradeThreshold,
        downgradeMargin,
        routes: routed.length,
        coverage: routed.length / rows.length,
        entryRate: eligibleRows.length === 0 ? null : routed.length / eligibleRows.length,
        falseDowngrades,
        falseDowngrade,
        feasible,
      })
    }
  }

  const operatingPoint = chooseOperatingPoint(curve, tieBreak)
  const legs = {
    auroc: discriminationValue !== null && discriminationValue >= bounds.aurocMin,
    feasiblePoint: operatingPoint !== null,
    coverage: operatingPoint !== null && operatingPoint.coverage >= bounds.coverageMin,
  }
  const failed = Object.entries(legs).filter(([, ok]) => !ok).map(([leg]) => leg)
  const headTokens = answeredRows.map(row => /** @type {number} */ (row.headTokens))
  const truncatedCount = answeredRows.filter(row => row.truncated).length

  return {
    method: { version: REPLAY_ROW_SEMANTICS_VERSION, eceBins, tieBreak: [...tieBreak] },
    fixed: { entryScoreCeiling: entry.entryScoreCeiling, candidateIds: [...entry.candidateIds] },
    counts: {
      rows: rows.length,
      eligible: eligibleRows.length,
      answered: answeredRows.length,
      unanswered: rows.length - answeredRows.length,
      truncated: truncatedCount,
      routed: operatingPoint?.routes ?? 0,
      falseDowngrades: operatingPoint?.falseDowngrades ?? 0,
    },
    discrimination: {
      auroc: discriminationValue,
      positives: answerSamples.filter(sample => sample.positive).length,
      negatives: answerSamples.filter(sample => !sample.positive).length,
    },
    calibration,
    tokens: {
      headTokensMean: headTokens.length === 0 ? null : headTokens.reduce((sum, value) => sum + value, 0) / headTokens.length,
      headTokensP95: headTokens.length === 0 ? null : percentile(headTokens, 95),
      truncationRate: answeredRows.length === 0 ? null : truncatedCount / answeredRows.length,
      unansweredRate: (rows.length - answeredRows.length) / rows.length,
    },
    curve,
    operatingPoint,
    gate: {
      passed: failed.length === 0,
      legs,
      bounds: { ...bounds },
      reading: failed.length === 0 ? 'replay gate passed' : `replay gate failed on ${failed.join(' and ')}`,
    },
  }
}

/** Validate the required options of {@link computeReplayMetrics}; nothing is defaulted. */
function readOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('computeReplayMetrics requires an options object')
  const { eceBins, tieBreak, gate, entry } = options
  if (!Number.isSafeInteger(eceBins) || eceBins < 1) throw new TypeError(`options.eceBins must be a positive integer, got ${JSON.stringify(eceBins)}`)
  if (!Array.isArray(tieBreak) || tieBreak.length === 0) throw new TypeError('options.tieBreak must be a non-empty array of tie-break keys')
  if (new Set(tieBreak).size !== tieBreak.length) throw new TypeError('options.tieBreak must not repeat a key')
  for (const key of tieBreak) {
    if (!(key in TIE_BREAK_KEYS)) throw new TypeError(`options.tieBreak key ${JSON.stringify(key)} is not one of ${Object.keys(TIE_BREAK_KEYS).join(', ')}`)
  }
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
  return { eceBins, tieBreak, gate, entry }
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
  const { feasible: _feasible, ...chosen } = best
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
