#!/usr/bin/env node
/**
 * Reproduce the w9 McNemar sample-size table.
 *
 * Usage:
 *   node bench/analysis/w9-power.js
 *   node bench/analysis/w9-power.js --from-runs
 *
 * Default reads the committed pairing fixture (so the table does not depend
 * on gitignored `bench/runs/`). `--from-runs` rebuilds the same pairing from
 * trials.jsonl via `pairOutcomes` and fails if it disagrees with the fixture.
 *
 * Primary ψ pools w7 off↔on with w8 off↔on-core. Sensitivity scales that ψ
 * by 0.5× and 1.5×. α = 0.05 two-sided, power = 0.8, δ = 0.25.
 *
 * @module bench/analysis/w9-power
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pairOutcomes } from '../stats/paired.js'
import {
  connorN,
  discordantCells,
  exactDiscordantN,
  exactMcnemarN,
  exactMcnemarPower,
  miettinenCorrectedN,
  planN,
} from './mcnemar-n.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, 'w7-w8-pairing.json')
const runs = join(here, '..', 'runs')

/** w7-scale paired proportion difference the contract plan names. */
const DELTA = 0.25

/** Pressure-task count in the w9 catalog (build + the source-form task). */
const W9_TASKS = 2

/**
 * @typedef {{ taskId: string, trialIndex: number, off: boolean, on: boolean }} Pair
 * @typedef {{ id: string, label: string, experiment: string, baseline: string, treatment: string, pool: boolean, pairs: Pair[] }} ContrastSpec
 * @typedef {{ label: string, n: number, wins: number, losses: number, ties: number, discordant: number, psi: number, delta: number, pool: boolean }} ContrastSummary
 */

/**
 * Summarize one contrast's pairs.
 * @param {string} label
 * @param {Pair[]} pairs
 * @param {boolean} pool
 * @returns {ContrastSummary}
 */
function summarize(label, pairs, pool) {
  const n = pairs.length
  const wins = pairs.filter(p => p.on && !p.off).length
  const losses = pairs.filter(p => !p.on && p.off).length
  const ties = pairs.filter(p => p.on === p.off).length
  const discordant = wins + losses
  const offPass = pairs.filter(p => p.off).length / n
  const onPass = pairs.filter(p => p.on).length / n
  return { label, n, wins, losses, ties, discordant, psi: discordant / n, delta: onPass - offPass, pool }
}

/**
 * Load the committed pairing fixture.
 * @returns {ContrastSpec[]}
 */
export function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, 'utf8')).contrasts
}

/**
 * Parse a trials.jsonl file into trial records.
 * @param {string} rel - path under bench/runs/.
 * @returns {import('../schema/trial.js').Trial[]}
 */
function loadTrials(rel) {
  return readFileSync(join(runs, rel), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/**
 * Re-pair from on-disk trials.jsonl using the same function the report grades with.
 * @param {ContrastSpec[]} fixture
 * @returns {ContrastSpec[]}
 */
export function pairFromRuns(fixture) {
  return fixture.map(spec => {
    const off = loadTrials(`${spec.experiment}/${spec.baseline}/trials.jsonl`)
    const on = loadTrials(`${spec.experiment}/${spec.treatment}/trials.jsonl`)
    const { pairs } = pairOutcomes(off, on)
    return { ...spec, pairs }
  })
}

/**
 * Fail if run-derived pairs disagree with the fixture.
 * @param {ContrastSpec[]} fixture
 * @param {ContrastSpec[]} fromRuns
 * @returns {void}
 */
export function assertFixtureMatchesRuns(fixture, fromRuns) {
  for (const spec of fixture) {
    const got = fromRuns.find(c => c.id === spec.id)
    if (!got) throw new Error(`--from-runs missing contrast ${spec.id}`)
    const a = JSON.stringify(spec.pairs)
    const b = JSON.stringify(got.pairs)
    if (a !== b) throw new Error(`fixture ${spec.id} disagrees with trials.jsonl pairing`)
  }
}

/**
 * Build the w9 sample-size report.
 * @param {ContrastSpec[]} [contrasts]
 * @returns {{ text: string, observedPsi: number, pooledN: number, pooledDiscordant: number, rows: ContrastSummary[], primary: { n: number, power: number, planN: number } | null }}
 */
export function w9PowerReport(contrasts = loadFixture()) {
  const rows = contrasts.map(c => summarize(c.label, c.pairs, c.pool))
  const pooled = rows.filter(r => r.pool)
  const pooledN = pooled.reduce((s, r) => s + r.n, 0)
  const pooledDiscordant = pooled.reduce((s, r) => s + r.discordant, 0)
  const observedPsi = pooledDiscordant / pooledN

  const scales = [
    { name: '0.5× observed', psi: observedPsi * 0.5 },
    { name: 'observed (primary)', psi: observedPsi },
    { name: '1.5× observed', psi: observedPsi * 1.5 },
  ]

  const lines = []
  const log = (s = '') => lines.push(s)

  log('w9 McNemar sample size — α = 0.05 two-sided, power = 0.8, δ = 0.25 (w7-scale |off−on|)')
  log('')
  log('Empirical pairing (taskId + trialIndex, status=success only):')
  for (const row of rows) {
    log(`  ${row.label}: n=${row.n}  ${row.wins} wins / ${row.losses} losses / ${row.ties} ties  ψ=${row.psi.toFixed(4)}  δ=${row.delta.toFixed(4)}`)
  }
  log(`  pooled w7 off↔on + w8 off↔on-core: n=${pooledN}  discordant=${pooledDiscordant}  ψ=${observedPsi.toFixed(6)}  (= ${pooledDiscordant}/${pooledN})`)
  log('  (w7 off↔on-adaptive is reported, not pooled: different composition, session-query mounted.)')
  log('')
  log(`${'ψ assumption'.padEnd(22)} ${'ψ'.padStart(8)} ${'Connor'.padStart(8)} ${'Miettinen'.padStart(10)} ${'exact n'.padStart(8)} ${'exact power'.padStart(12)} ${'n_d'.padStart(6)} ${'plan n (2 tasks)'.padStart(18)}`)

  /** @type {{ n: number, power: number, planN: number } | null} */
  let primary = null
  for (const { name, psi } of scales) {
    if (discordantCells(psi, DELTA) === null) {
      log(`${name.padEnd(22)} ${psi.toFixed(4).padStart(8)}  infeasible (|δ| > ψ); a 0.25 delta cannot occur at this discordance`)
      continue
    }
    const connor = connorN(psi, DELTA)
    const miett = miettinenCorrectedN(psi, DELTA)
    const exact = exactMcnemarN(psi, DELTA)
    const nd = exactDiscordantN(psi, DELTA)
    const planned = exact ? planN(exact.n, W9_TASKS) : null
    const plannedPower = planned ? exactMcnemarPower(planned, psi, DELTA) : null
    if (name.startsWith('observed') && exact && planned !== null) {
      primary = { n: exact.n, power: exact.power, planN: planned }
    }
    log(
      `${name.padEnd(22)} ${psi.toFixed(4).padStart(8)} ${connor.toFixed(2).padStart(8)} ${miett.toFixed(2).padStart(10)} ${String(exact?.n ?? '—').padStart(8)} ${((exact?.power ?? 0) * 100).toFixed(1).padStart(11)}% ${String(nd?.nDiscordant ?? '—').padStart(6)} ${String(planned ?? '—').padStart(18)}`
      + (plannedPower !== null ? `  (power at plan n ${(plannedPower * 100).toFixed(1)}%)` : ''),
    )
  }

  log('')
  log(`Primary registration: exact n at observed ψ, ceiled to a multiple of ${W9_TASKS} so repeats split evenly.`)
  log(`Token-neutrality is not in this table; see the W0 note's w9 pre-registration.`)

  return { text: lines.join('\n'), observedPsi, pooledN, pooledDiscordant, rows, primary }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  const fromRuns = process.argv.includes('--from-runs')
  const fixture = loadFixture()
  if (fromRuns) {
    if (!existsSync(join(runs, 'w7-build-confirm-2026-08-26/off/trials.jsonl'))) {
      throw new Error('--from-runs requires bench/runs/w7 and w8 trials.jsonl')
    }
    assertFixtureMatchesRuns(fixture, pairFromRuns(fixture))
  }
  process.stdout.write(`${w9PowerReport(fixture).text}\n`)
}
