#!/usr/bin/env node
/**
 * Report builder: scans bench/runs/<experiment>/<arm>/, validates every
 * record against bench/schema, rebuilds per-arm results.json (arm summary
 * + per-task cells) from the trial source of truth, computes off-vs-on
 * pairs and the comparison grade via bench/stats, validates the final
 * ReportData payload, and writes bench/ui/data.js as
 * `globalThis.BENCH_REPORT = <json>;`.
 *
 * Usage: node bench/report/build.js [--experiment <name> | latest]
 *
 * Consumed bench/stats API (kept narrow on purpose):
 * - aggregate.summarizeCells(trials) -> ReportCell[] (Wilson ci95 included).
 * - aggregate.summarizeArm(arm, trials) -> ReportArmSummary (ci95, stderr included).
 * - intervals.bootstrapDeltaCi(pairs) -> bootstrap CI on the paired pass-rate
 *   delta from matched outcomes [{ off: boolean, on: boolean }].
 * - paired.pairOutcomes(offTrials, onTrials) -> { pairs, wins, losses, ties }
 *   keyed by taskId + trialIndex; wins = resolved on / unresolved off.
 * - paired.mcnemarExactP(wins, losses) -> exact p, null without discordance.
 * - paired.gradeComparison({ mcnemarP, deltaAccuracy, tokenOverheadRatio }) -> grade.
 *
 * @module bench/report/build
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateTrial } from '../schema/trial.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateReportData } from '../schema/report-data.js'
import { summarizeArm, summarizeCells } from '../stats/aggregate.js'
import { bootstrapDeltaCi } from '../stats/intervals.js'
import { gradeComparison, mcnemarExactP, pairOutcomes } from '../stats/paired.js'

const RUNS_DIR = fileURLToPath(new URL('../runs', import.meta.url))
const TASKS_DIR = fileURLToPath(new URL('../tasks', import.meta.url))
const UI_DATA_PATH = fileURLToPath(new URL('../ui/data.js', import.meta.url))

/** Arms always compare against this baseline. */
const BASELINE_ARM = 'off'
/** The synthetic experiment arm pair this comparison supports. */
const TREATMENT_ARM = 'on'

/**
 * Per-arm rebuilt aggregate, written to runs/<experiment>/<arm>/results.json.
 *
 * @typedef {object} ArmResults
 * @property {1} version
 * @property {string} experiment
 * @property {string} arm
 * @property {string} generatedAt - ISO 8601.
 * @property {import('../schema/report-data.js').ReportArmSummary} summary
 * @property {import('../schema/report-data.js').ReportCell[]} cells
 */

/**
 * Parse CLI arguments.
 * @param {string[]} argv - arguments after the script path.
 * @returns {{ experiment: string }} experiment name; 'latest' when omitted.
 */
export function parseArgs(argv) {
  let experiment = 'latest'
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--experiment') {
      const value = argv[i + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error('--experiment requires a value (or "latest")')
      }
      experiment = value
      i += 1
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  return { experiment }
}

/**
 * Resolve an experiment name to its directory. 'latest' picks the runs/
 * subdirectory with the newest modification time.
 * @param {string} runsDir - runs root.
 * @param {string} experiment - experiment name or 'latest'.
 * @returns {Promise<string>} absolute experiment directory.
 */
export async function resolveExperimentDir(runsDir, experiment) {
  if (experiment !== 'latest') {
    const dir = join(runsDir, experiment)
    if (!existsSync(dir)) throw new Error(`experiment not found: ${dir}`)
    return dir
  }
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter(e => e.isDirectory())
  if (dirs.length === 0) throw new Error(`no experiments under ${runsDir}`)
  let newest = null
  let newestMtime = -Infinity
  for (const entry of dirs) {
    const dir = join(runsDir, entry.name)
    const { mtimeMs } = await stat(dir)
    if (mtimeMs > newestMtime) {
      newest = dir
      newestMtime = mtimeMs
    }
  }
  return /** @type {string} */ (newest)
}

/**
 * Load and validate one arm directory: run.json plus every trials.jsonl line.
 * A missing trials.jsonl reads as zero trials so an interrupted run still builds.
 * @param {string} armDir - runs/<experiment>/<arm> directory.
 * @returns {Promise<{ manifest: import('../schema/run-manifest.js').RunManifest, trials: import('../schema/trial.js').Trial[] }>}
 */
export async function loadArm(armDir) {
  const manifestPath = join(armDir, 'run.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateRunManifest(manifest)
  const trialsPath = join(armDir, 'trials.jsonl')
  /** @type {import('../schema/trial.js').Trial[]} */
  const trials = []
  if (existsSync(trialsPath)) {
    const text = await readFile(trialsPath, 'utf8')
    const lines = text.split('\n').filter(line => line.trim().length > 0)
    for (let i = 0; i < lines.length; i += 1) {
      let record
      try {
        record = JSON.parse(lines[i])
      } catch (error) {
        throw new Error(`${trialsPath}:${i + 1} is not valid JSON: ${error.message}`)
      }
      try {
        validateTrial(record)
      } catch (error) {
        throw new Error(`${trialsPath}:${i + 1}: ${error.message}`)
      }
      trials.push(record)
    }
  }
  return { manifest, trials }
}

/**
 * Read the task catalog entry for a taskId. Missing or unreadable entries
 * fall back to the taskId as description and the 'long' stratum.
 * @param {string} tasksDir - task catalog root.
 * @param {string} taskId - task directory name.
 * @returns {Promise<{ taskId: string, stratum: 'long' | 'short' | 'adversarial' | 'chain', description: string }>}
 */
export async function loadTaskInfo(tasksDir, taskId) {
  try {
    const raw = JSON.parse(await readFile(join(tasksDir, taskId, 'task.json'), 'utf8'))
    const stratum = ['long', 'short', 'adversarial', 'chain'].includes(raw.stratum) ? raw.stratum : 'long'
    const description = typeof raw.description === 'string' && raw.description.length > 0
      ? raw.description
      : taskId
    return { taskId, stratum, description }
  } catch {
    return { taskId, stratum: 'long', description: taskId }
  }
}

/**
 * Build the per-task paired comparison between the baseline and treatment arm.
 * @param {string} taskId - task to compare.
 * @param {import('../schema/trial.js').Trial[]} offTrials - baseline trials for the task.
 * @param {import('../schema/trial.js').Trial[]} onTrials - treatment trials for the task.
 * @param {number} offPass - baseline pass rate for the task.
 * @param {number} onPass - treatment pass rate for the task.
 * @returns {import('../schema/report-data.js').ReportPair}
 */
export function buildPair(taskId, offTrials, onTrials, offPass, onPass) {
  const { pairs, wins, losses, ties } = pairOutcomes(offTrials, onTrials)
  const delta = onPass - offPass
  return {
    taskId,
    delta,
    deltaCi95: bootstrapDeltaCi(pairs),
    mcnemarP: mcnemarExactP(wins, losses),
    wins,
    losses,
    ties,
    winner: delta > 0 ? 'on' : delta < 0 ? 'off' : 'tie',
  }
}

/**
 * Rebuild all report artifacts for one experiment directory.
 * @param {string} experimentDir - runs/<experiment> directory.
 * @param {{ tasksDir?: string, uiDataPath?: string, generatedAt?: string }} [options]
 *   tasksDir/uiDataPath default to bench/tasks and bench/ui/data.js; generatedAt
 *   defaults to now (injectable for deterministic tests).
 * @returns {Promise<import('../schema/report-data.js').ReportData>} validated payload.
 */
export async function buildExperiment(experimentDir, options = {}) {
  const tasksDir = options.tasksDir ?? TASKS_DIR
  const uiDataPath = options.uiDataPath ?? UI_DATA_PATH
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const experiment = /** @type {string} */ (experimentDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop())

  const entries = await readdir(experimentDir, { withFileTypes: true })
  const armNames = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => (a === BASELINE_ARM ? -1 : b === BASELINE_ARM ? 1 : a < b ? -1 : a > b ? 1 : 0))
  if (armNames.length === 0) throw new Error(`no arm directories under ${experimentDir}`)

  /** @type {Map<string, { manifest: import('../schema/run-manifest.js').RunManifest, trials: import('../schema/trial.js').Trial[] }>} */
  const arms = new Map()
  for (const arm of armNames) {
    arms.set(arm, await loadArm(join(experimentDir, arm)))
  }

  // Task set: manifest order first, then any extra taskIds seen in trials.
  /** @type {string[]} */
  const taskIds = []
  const seen = new Set()
  for (const { manifest, trials } of arms.values()) {
    for (const id of manifest.taskIds) {
      if (!seen.has(id)) { seen.add(id); taskIds.push(id) }
    }
    for (const t of trials) {
      if (!seen.has(t.taskId)) { seen.add(t.taskId); taskIds.push(t.taskId) }
    }
  }

  /** @type {import('../schema/report-data.js').ReportCell[]} */
  const cells = []
  /** @type {import('../schema/report-data.js').ReportArmSummary[]} */
  const armSummaries = []
  /** @type {import('../schema/trial.js').Trial[]} */
  const allTrials = []
  for (const [arm, { trials }] of arms) {
    const armCells = summarizeCells(trials)
    const summary = summarizeArm(arm, trials)
    cells.push(...armCells)
    armSummaries.push(summary)
    allTrials.push(...trials)
    /** @type {ArmResults} */
    const results = { version: 1, experiment, arm, generatedAt, summary, cells: armCells }
    await writeFile(join(experimentDir, arm, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  }

  const off = arms.get(BASELINE_ARM)
  const on = arms.get(TREATMENT_ARM)
  /** @type {import('../schema/report-data.js').ReportPair[]} */
  const pairs = []
  /** @type {import('../schema/report-data.js').ReportData['comparison']} */
  let comparison = { grade: 'tie', deltaAccuracy: 0, mcnemarP: null }
  if (off && on) {
    const offSummary = armSummaries[armNames.indexOf(BASELINE_ARM)]
    const onSummary = armSummaries[armNames.indexOf(TREATMENT_ARM)]
    const offTokens = offSummary.totalInputTokens + offSummary.totalOutputTokens
    const onTokens = onSummary.totalInputTokens + onSummary.totalOutputTokens
    const tokenOverheadRatio = offTokens > 0 ? onTokens / offTokens : Number.POSITIVE_INFINITY
    for (const taskId of taskIds) {
      const offTrials = off.trials.filter(t => t.taskId === taskId)
      const onTrials = on.trials.filter(t => t.taskId === taskId)
      if (offTrials.length === 0 && onTrials.length === 0) continue
      const offCell = cells.find(c => c.arm === BASELINE_ARM && c.taskId === taskId)
      const onCell = cells.find(c => c.arm === TREATMENT_ARM && c.taskId === taskId)
      pairs.push(buildPair(taskId, offTrials, onTrials, offCell?.passRate ?? 0, onCell?.passRate ?? 0))
    }
    const overall = pairOutcomes(off.trials, on.trials)
    const deltaAccuracy = onSummary.accuracy - offSummary.accuracy
    comparison = {
      grade: gradeComparison({
        mcnemarP: mcnemarExactP(overall.wins, overall.losses),
        deltaAccuracy,
        tokenOverheadRatio,
      }),
      deltaAccuracy,
      mcnemarP: mcnemarExactP(overall.wins, overall.losses),
    }
  }

  const tasks = await Promise.all(taskIds.map(id => loadTaskInfo(tasksDir, id)))
  const demo = experiment === 'demo' && existsSync(join(experimentDir, 'demo'))

  /** @type {import('../schema/report-data.js').ReportData} */
  const report = {
    version: 1,
    demo,
    generatedAt,
    experiment,
    tasks,
    cells,
    pairs,
    arms: armSummaries,
    comparison,
    trials: allTrials,
  }
  validateReportData(report)

  await mkdir(dirname(uiDataPath), { recursive: true })
  await writeFile(uiDataPath, `globalThis.BENCH_REPORT = ${JSON.stringify(report)};\n`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { experiment } = parseArgs(process.argv.slice(2))
    const dir = await resolveExperimentDir(RUNS_DIR, experiment)
    const report = await buildExperiment(dir)
    console.log(`built report for ${report.experiment}: ${report.arms.length} arms, ${report.tasks.length} tasks -> ${UI_DATA_PATH}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
