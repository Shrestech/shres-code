/**
 * Out-of-loop experiment recomputation over stored runs: replays each recorded
 * `sessionFile` through the same descendant walk the live runner uses, so the
 * process-metric table covers historical experiments with zero API spend.
 *
 * Usage:
 *   node bench/analysis/out-of-loop.js                  # every stored experiment
 *   node bench/analysis/out-of-loop.js w7-build-confirm # substring filter
 *   node bench/analysis/out-of-loop.js --json
 *
 * A trial's persistence root is reconstructed from its `sessionFile` path:
 * `sessions/<taskId>/<trialIndex>/<project>/<session>/session.jsonl` — the
 * directory two levels above the log file. Arms without `trials.jsonl` (an
 * aborted launch, the `scratch` dir) contribute nothing, matching how the
 * report loader treats them.
 *
 * @module bench/analysis/out-of-loop
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { descendantUsage } from '../runner/descendants.js'
import { foldSessionLog } from '../runner/metrics.js'

const benchRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @typedef {object} OutOfLoopRow
 * @property {string} experiment - experiment directory name.
 * @property {string} arm - arm name.
 * @property {number} trials - trials with a recorded session file.
 * @property {number} mainlineRequests - model requests (`turns`) over counted trials.
 * @property {number} runCodeCalls - `run_code` calls over the whole trial tree.
 * @property {number} delegatedSessions - descendant sessions with `origin: 'subagent'`.
 * @property {number} outOfLoopExperiments - `runCodeCalls + delegatedSessions`.
 */

/**
 * List experiment directories under `bench/runs`.
 * @param {string} runsDir - absolute `bench/runs` directory.
 * @returns {Promise<string[]>} experiment names, sorted.
 */
async function listExperiments(runsDir) {
  const entries = await readdir(runsDir, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/**
 * Fold one experiment's arms into table rows.
 * @param {string} runsDir - absolute `bench/runs` directory.
 * @param {string} experiment - experiment directory name.
 * @returns {Promise<OutOfLoopRow[]>} one row per arm with recorded trials.
 */
async function foldExperiment(runsDir, experiment) {
  const arms = (await readdir(join(runsDir, experiment), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== 'scratch' && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
  /** @type {OutOfLoopRow[]} */
  const rows = []
  for (const arm of arms) {
    const armDir = join(runsDir, experiment, arm)
    let text
    try {
      text = await readFile(join(armDir, 'trials.jsonl'), 'utf8')
    } catch {
      continue
    }
    let trials = 0
    let mainlineRequests = 0
    let runCodeCalls = 0
    let delegatedSessions = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const trial = JSON.parse(line)
      if (typeof trial.sessionFile !== 'string') continue
      const rootLogPath = resolve(armDir, trial.sessionFile)
      let rootText
      try {
        rootText = await readFile(rootLogPath, 'utf8')
      } catch {
        // The recorded log is gone (pruned scratch, synthetic demo data); the
        // trial contributes nothing to a log-forensics table.
        continue
      }
      const sessionRoot = dirname(dirname(rootLogPath))
      const rootFold = foldSessionLog(rootText)
      const tree = await descendantUsage(sessionRoot, rootLogPath)
      trials += 1
      mainlineRequests += trial.metrics?.turns ?? rootFold.turns
      runCodeCalls += rootFold.outOfLoopExperiments + tree.descendantRunCodeCalls
      delegatedSessions += tree.delegatedSessions
    }
    rows.push({ experiment, arm, trials, mainlineRequests, runCodeCalls, delegatedSessions, outOfLoopExperiments: runCodeCalls + delegatedSessions })
  }
  return rows
}

/**
 * Build the full table.
 * @param {string[]} filters - experiment-name substrings; empty means all.
 * @returns {Promise<OutOfLoopRow[]>} rows over matching stored experiments.
 */
export async function buildOutOfLoopTable(filters = []) {
  const runsDir = join(benchRoot, 'runs')
  const experiments = (await listExperiments(runsDir))
    .filter(name => filters.length === 0 || filters.some(filter => name.includes(filter)))
  /** @type {OutOfLoopRow[]} */
  const rows = []
  for (const experiment of experiments) {
    rows.push(...await foldExperiment(runsDir, experiment))
  }
  return rows
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const filters = argv.filter(arg => !arg.startsWith('--'))
  const rows = await buildOutOfLoopTable(filters)
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  } else {
    process.stdout.write('| Experiment | Arm | Trials | Mainline requests | run_code | Delegated | outOfLoopExperiments |\n')
    process.stdout.write('|---|---|---|---|---|---|---|\n')
    for (const row of rows) {
      process.stdout.write(`| ${row.experiment} | ${row.arm} | ${row.trials} | ${row.mainlineRequests} | ${row.runCodeCalls} | ${row.delegatedSessions} | ${row.outOfLoopExperiments} |\n`)
    }
  }
}
