/**
 * Model strength-and-cost ranking over recorded bench runs: one row per roster
 * model, where the roster is the set of `run.json` `model` pins across the
 * stored experiments. Strength is the frozen arm pass rate (verifier-passed
 * success-status trials over success-status trials, `status: error` excluded,
 * the same `summarizeArm().accuracy` every report carries); cost is realized
 * usage, the `assistant/message` provider-reported `inputTokens + outputTokens`
 * the runner folded into each trial record, summed over the same trials. Rows
 * rank by strength per realized cost. No price table and no per-model rate
 * ratio enter the computation: tokens are the only cost currency.
 *
 * Usage:
 *   node bench/analysis/model-ranking.js                       # every stored experiment
 *   node bench/analysis/model-ranking.js --experiment w4-      # experiment-name substring filter
 *   node bench/analysis/model-ranking.js --arm off --arm on    # restrict to these arms
 *   node bench/analysis/model-ranking.js --runs-dir <path>     # an archived runs tree
 *   node bench/analysis/model-ranking.js --json
 *
 * A model that recorded exactly one arm reports that arm's pass rate as its
 * strength; a model that recorded several arms pools their gradable trials,
 * and each arm's own frozen pass rate stays listed under the row, so the
 * `--arm` filter is how a ranking on one frozen arm is read. Arm directories
 * without `run.json` (the `scratch` dir, an aborted launch) contribute nothing;
 * an invalid manifest or trial record fails the command.
 *
 * @module bench/analysis/model-ranking
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadArm } from '../report/build.js'
import { summarizeArm } from '../stats/aggregate.js'

const DEFAULT_RUNS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runs')

/** Display unit of the table's rank column: strength per million realized tokens. */
const TOKENS_PER_MILLION = 1_000_000

/**
 * @typedef {object} RankedArmRun - one recorded arm run that contributes to a model row.
 * @property {string} experiment - experiment directory name.
 * @property {string} arm - arm name.
 * @property {number} trials - success-status trials, the frozen pass-rate denominator.
 * @property {number} resolved - verifier-passed trials among them.
 * @property {number | null} passRate - the frozen arm pass rate; null when the run has no gradable trial.
 * @property {number} realizedTokens - `inputTokens + outputTokens` summed over the gradable trials.
 */

/**
 * @typedef {object} ModelRankingRow
 * @property {number | null} rank - 1-based position among rankable rows; null when the row
 *   has no gradable trial or no realized usage, in which case strength per cost is undefined.
 * @property {string} model - the `run.json` model pin.
 * @property {RankedArmRun[]} runs - contributing arm runs, sorted by experiment then arm.
 * @property {number} trials - gradable trials pooled over `runs`.
 * @property {number} resolved - verifier-passed trials pooled over `runs`.
 * @property {number | null} strength - pooled pass rate; equals the arm pass rate for a
 *   single-arm model. Null when `trials` is 0.
 * @property {number} realizedTokens - realized usage summed over `runs`.
 * @property {number | null} meanRealizedTokens - realized usage per gradable trial; null when
 *   `trials` is 0.
 * @property {number | null} strengthPerCost - `strength / meanRealizedTokens`, the rank key.
 *   Null when either operand is unavailable or `realizedTokens` is 0.
 */

/**
 * @typedef {object} RankingOptions
 * @property {string} [runsDir] - runs root; defaults to `bench/runs`.
 * @property {string[]} [experiments] - experiment-name substrings; empty means every experiment.
 * @property {string[]} [arms] - arm names to include; empty means every arm.
 */

/**
 * Parse CLI arguments. Every flag that takes a value rejects a missing or
 * flag-like value, and an unknown argument is an error.
 * @param {string[]} argv - arguments after the script path.
 * @returns {{ runsDir: string | null, experiments: string[], arms: string[], json: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let runsDir = null
  /** @type {string[]} */
  const experiments = []
  /** @type {string[]} */
  const arms = []
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--experiment' || arg === '--arm' || arg === '--runs-dir') {
      const value = argv[i + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`)
      }
      if (arg === '--experiment') experiments.push(value)
      else if (arg === '--arm') arms.push(value)
      else runsDir = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return { runsDir, experiments, arms, json }
}

/**
 * List experiment directories under a runs root.
 * @param {string} runsDir - absolute runs directory.
 * @returns {Promise<string[]>} experiment names, sorted.
 */
async function listExperiments(runsDir) {
  if (!existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`)
  const entries = await readdir(runsDir, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/**
 * Fold one arm run into its ranked record.
 * @param {string} experiment - experiment directory name.
 * @param {string} arm - arm name.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the run.
 * @returns {RankedArmRun}
 */
function foldArmRun(experiment, arm, trials) {
  const summary = summarizeArm(arm, trials)
  const resolved = trials.filter(t => t.status === 'success' && t.resolved).length
  return {
    experiment,
    arm,
    trials: summary.trials,
    resolved,
    passRate: summary.trials === 0 ? null : summary.accuracy,
    realizedTokens: summary.totalInputTokens + summary.totalOutputTokens,
  }
}

/**
 * Compare two rows for the ranking order: rankable rows before unrankable
 * ones, then descending strength per cost, then descending strength, then
 * model name.
 * @param {ModelRankingRow} a
 * @param {ModelRankingRow} b
 * @returns {number} sort order.
 */
function compareRows(a, b) {
  const byRankable = Number(b.strengthPerCost !== null) - Number(a.strengthPerCost !== null)
  if (byRankable !== 0) return byRankable
  const byCost = (b.strengthPerCost ?? 0) - (a.strengthPerCost ?? 0)
  if (byCost !== 0) return byCost
  const byStrength = (b.strength ?? 0) - (a.strength ?? 0)
  if (byStrength !== 0) return byStrength
  return a.model.localeCompare(b.model)
}

/**
 * Build the ranking over the stored runs.
 * @param {RankingOptions} [options] - runs root and filters.
 * @returns {Promise<ModelRankingRow[]>} rows in rank order.
 */
export async function buildModelRanking(options = {}) {
  const runsDir = options.runsDir === undefined ? DEFAULT_RUNS_DIR : resolve(options.runsDir)
  const experimentFilters = options.experiments ?? []
  const armFilter = options.arms ?? []
  const experiments = (await listExperiments(runsDir))
    .filter(name => experimentFilters.length === 0 || experimentFilters.some(filter => name.includes(filter)))

  /** @type {Map<string, RankedArmRun[]>} */
  const runsByModel = new Map()
  for (const experiment of experiments) {
    const experimentDir = join(runsDir, experiment)
    const arms = (await readdir(experimentDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && existsSync(join(experimentDir, entry.name, 'run.json')))
      .map(entry => entry.name)
      .filter(arm => armFilter.length === 0 || armFilter.includes(arm))
      .sort()
    for (const arm of arms) {
      const { manifest, trials } = await loadArm(join(experimentDir, arm))
      const runs = runsByModel.get(manifest.model) ?? []
      runs.push(foldArmRun(experiment, arm, trials))
      runsByModel.set(manifest.model, runs)
    }
  }

  /** @type {ModelRankingRow[]} */
  const rows = []
  for (const [model, runs] of runsByModel) {
    let trials = 0
    let resolved = 0
    let realizedTokens = 0
    for (const run of runs) {
      trials += run.trials
      resolved += run.resolved
      realizedTokens += run.realizedTokens
    }
    const strength = trials === 0 ? null : resolved / trials
    const meanRealizedTokens = trials === 0 ? null : realizedTokens / trials
    const strengthPerCost = strength === null || meanRealizedTokens === null || meanRealizedTokens === 0
      ? null
      : strength / meanRealizedTokens
    rows.push({ rank: null, model, runs, trials, resolved, strength, realizedTokens, meanRealizedTokens, strengthPerCost })
  }
  rows.sort(compareRows)
  let rank = 0
  for (const row of rows) {
    if (row.strengthPerCost !== null) {
      rank += 1
      row.rank = rank
    }
  }
  return rows
}

/**
 * Render the ranking as a Markdown table: one line per model row followed by
 * one indented line per contributing arm run.
 * @param {ModelRankingRow[]} rows - rows in rank order.
 * @returns {string} the table text, newline-terminated.
 */
export function renderTable(rows) {
  const perMillion = value => value === null ? '—' : (value * TOKENS_PER_MILLION).toFixed(3)
  const rate = value => value === null ? '—' : value.toFixed(3)
  const lines = [
    '| Rank | Model | Trials | Strength (pass rate) | Realized tokens | Mean tokens/trial | Strength per 1M tokens |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    lines.push(`| ${row.rank ?? '—'} | ${row.model} | ${row.trials} | ${rate(row.strength)} | ${row.realizedTokens} | ${row.meanRealizedTokens === null ? '—' : Math.round(row.meanRealizedTokens)} | ${perMillion(row.strengthPerCost)} |`)
    for (const run of row.runs) {
      lines.push(`| | ↳ ${run.experiment} / ${run.arm} | ${run.trials} | ${rate(run.passRate)} | ${run.realizedTokens} | | |`)
    }
  }
  return `${lines.join('\n')}\n`
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  try {
    const { runsDir, experiments, arms, json } = parseArgs(process.argv.slice(2))
    const rows = await buildModelRanking({ runsDir: runsDir ?? undefined, experiments, arms })
    process.stdout.write(json ? `${JSON.stringify(rows, null, 2)}\n` : renderTable(rows))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
