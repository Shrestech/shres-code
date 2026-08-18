/**
 * Tests for bench/demo/generate.js: schema validity of every written record,
 * the intended directional story, cross-arm interleaving, seed determinism,
 * and the non-synthetic overwrite guard.
 *
 * @module bench/tests/demo.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateExperiment, parseArgs, TASKS } from '../demo/generate.js'
import { buildExperiment } from '../report/build.js'
import { validateRunManifest } from '../schema/run-manifest.js'
import { validateTrial } from '../schema/trial.js'

const STRATUM = Object.fromEntries(TASKS.map(t => [t.taskId, t.stratum]))

/**
 * Generate into a fresh temp runs root and read both arms back from disk.
 * @param {number} [seed] - generator seed; default 42.
 * @returns {Promise<{ dir: string, arms: Record<string, { manifest: object, trials: object[] }> }>} written experiment, re-read from disk.
 */
async function generateAndRead(seed) {
  const runsRoot = await mkdtemp(path.join(tmpdir(), 'bench-demo-'))
  const result = await generateExperiment({ runsRoot, experiment: 'demo', ...(seed === undefined ? {} : { seed }) })
  const arms = {}
  for (const arm of ['off', 'on']) {
    const manifest = JSON.parse(await readFile(path.join(result.dir, arm, 'run.json'), 'utf8'))
    const text = await readFile(path.join(result.dir, arm, 'trials.jsonl'), 'utf8')
    const trials = text.trimEnd().split('\n').map(line => JSON.parse(line))
    arms[arm] = { manifest, trials }
  }
  return { dir: result.dir, arms }
}

/**
 * Pass rate over non-error trials.
 * @param {object[]} trials - trial records.
 * @returns {number} resolved / success-status trials.
 */
function passRate(trials) {
  const live = trials.filter(t => t.status === 'success')
  return live.filter(t => t.resolved).length / live.length
}

/**
 * Sum one metrics field over trials.
 * @param {object[]} trials - trial records.
 * @param {string} field - TrialMetrics field name.
 * @returns {number} sum.
 */
function sumMetric(trials, field) {
  return trials.reduce((acc, t) => acc + t.metrics[field], 0)
}

test('writes schema-valid run manifests and trial records for both arms', async () => {
  const { dir, arms } = await generateAndRead()
  assert.ok(path.basename(dir) === 'demo')
  await readFile(path.join(dir, 'demo'), 'utf8') // synthetic marker exists
  for (const arm of ['off', 'on']) {
    validateRunManifest(arms[arm].manifest)
    assert.equal(arms[arm].manifest.arm, arm)
    assert.equal(arms[arm].trials.length, TASKS.length * 5)
    const seen = new Set()
    for (const trial of arms[arm].trials) {
      validateTrial(trial)
      assert.equal(trial.arm, arm)
      seen.add(`${trial.taskId}:${trial.trialIndex}`)
    }
    assert.equal(seen.size, TASKS.length * 5)
  }
  // Protocol rule 2: everything but arm/armConfig is pinned identically.
  const { off, on } = arms
  for (const field of ['version', 'experiment', 'model', 'baseUrl', 'temperature', 'repeats', 'gitCommit']) {
    assert.deepEqual(on.manifest[field], off.manifest[field])
  }
  assert.deepEqual(on.manifest.taskIds, off.manifest.taskIds)
  assert.deepEqual(off.manifest.armConfig, { enabled: false })
  assert.deepEqual(on.manifest.armConfig, { enabled: true, mode: 'available' })
})

test('tells the intended directional story', async () => {
  const { arms } = await generateAndRead()
  const off = arms.off.trials
  const on = arms.on.trials
  const byStratum = (trials, stratum) => trials.filter(t => STRATUM[t.taskId] === stratum)

  // Long stratum: on beats off by a wide margin.
  const offLong = passRate(byStratum(off, 'long'))
  const onLong = passRate(byStratum(on, 'long'))
  assert.ok(onLong > offLong, `long pass rate on (${onLong}) should beat off (${offLong})`)
  assert.ok(onLong >= 0.7 && offLong <= 0.55, `long rates in the ~0.75 vs ~0.5 story: on=${onLong} off=${offLong}`)

  // Short stratum: equal pass rate, on pays ~15% more input tokens.
  const offShort = byStratum(off, 'short')
  const onShort = byStratum(on, 'short')
  assert.ok(Math.abs(passRate(onShort) - passRate(offShort)) <= 0.05, 'short pass rates stay equal')
  const tokenRatio = (sumMetric(onShort, 'inputTokens') / onShort.length) / (sumMetric(offShort, 'inputTokens') / offShort.length)
  assert.ok(tokenRatio >= 1.08 && tokenRatio <= 1.22, `short input-token ratio ~1.15, got ${tokenRatio.toFixed(3)}`)

  // Only the on arm opens cards; the off arm retries more.
  assert.equal(sumMetric(off, 'checkpoints'), 0)
  assert.equal(sumMetric(off, 'shipPasses'), 0)
  assert.ok(sumMetric(on, 'checkpoints') > 0)
  assert.ok(sumMetric(on, 'shipPasses') > 0)
  assert.ok(sumMetric(off, 'identicalRetries') > sumMetric(on, 'identicalRetries'))

  // A handful of PROVIDER_ERROR trials, plus VERIFY_FAILED misses; resolved
  // trials are clean.
  const errors = [...off, ...on].filter(t => t.status === 'error')
  assert.ok(errors.length >= 3 && errors.length <= 6, `a handful of error trials, got ${errors.length}`)
  for (const t of errors) {
    assert.equal(t.failureMode, 'PROVIDER_ERROR')
    assert.equal(t.resolved, false)
  }
  const failed = [...off, ...on].filter(t => t.status === 'success' && !t.resolved)
  assert.ok(failed.length > 0)
  for (const t of failed) {
    assert.equal(t.failureMode, 'VERIFY_FAILED')
    assert.equal(t.verifier.exitCode, 1)
  }
  for (const t of [...off, ...on].filter(t => t.resolved)) {
    assert.equal(t.failureMode, null)
    assert.equal(t.verifier.exitCode, 0)
  }
})

test('interleaves arms per task and trial (protocol rule 1)', async () => {
  const { arms } = await generateAndRead()
  const all = [...arms.off.trials, ...arms.on.trials].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  assert.equal(new Set(all.map(t => t.startedAt)).size, all.length, 'startedAt values are unique')
  for (let k = 0; k < all.length; k += 2) {
    const [a, b] = [all[k], all[k + 1]]
    assert.equal(a.taskId, b.taskId)
    assert.equal(a.trialIndex, b.trialIndex)
    assert.notEqual(a.arm, b.arm)
    assert.ok(a.endedAt <= b.startedAt, 'the pair runs sequentially: off then on')
  }
  for (const t of all) {
    assert.ok(t.endedAt > t.startedAt)
    assert.equal(new Date(t.endedAt) - new Date(t.startedAt), t.metrics.durationMs)
  }
})

test('emits valid chain trials with cold per-phase records', async () => {
  const { arms } = await generateAndRead()
  const chainTasks = TASKS.filter(t => t.stratum === 'chain')
  assert.ok(chainTasks.length >= 2, 'the demo includes chain tasks')
  for (const task of chainTasks) {
    for (const arm of ['off', 'on']) {
      const trials = arms[arm].trials.filter(t => t.taskId === task.taskId)
      assert.equal(trials.length, 5)
      for (const trial of trials) {
        validateTrial(trial)
        assert.equal(trial.status, 'success', 'demo chains never hit infrastructure errors')
        assert.ok(!('integrity' in trial), 'demo chains are clean')
        assert.equal(trial.phases.length, task.phases)
        assert.deepEqual(trial.phases.map(p => p.phaseIndex), Array.from({ length: task.phases }, (_, i) => i))
        // Trial-level rollups: per-phase sums, the final phase's session log,
        // and a span equal to the summed durations (phases run back-to-back).
        for (const field of ['inputTokens', 'outputTokens', 'durationMs', 'turns', 'toolCalls', 'identicalRetries', 'checkpoints', 'shipPasses']) {
          assert.equal(trial.metrics[field], trial.phases.reduce((acc, p) => acc + p.metrics[field], 0), `${task.taskId} ${arm} #${trial.trialIndex} ${field}`)
        }
        assert.equal(trial.sessionFile, trial.phases[trial.phases.length - 1].sessionFile)
        assert.equal(trial.startedAt, trial.phases[0].startedAt)
        assert.equal(trial.endedAt, trial.phases[trial.phases.length - 1].endedAt)
        assert.equal(new Date(trial.endedAt) - new Date(trial.startedAt), trial.metrics.durationMs)
        for (const phase of trial.phases) {
          assert.equal(phase.resumedFrom, null, 'cold carry: no resume exists yet')
          assert.equal(phase.exitCode, 0)
          assert.equal(phase.timedOut, false)
          assert.match(phase.sessionFile, new RegExp(`^sessions/${task.taskId}/${trial.trialIndex}/phase-${phase.phaseIndex}/`))
        }
      }
    }
    // The cold-carry hope, per (task, trial): the on arm's later phases reopen
    // fewer input tokens than the off arm's — without a pass-rate claim.
    for (let i = 0; i < 5; i += 1) {
      const off = arms.off.trials.find(t => t.taskId === task.taskId && t.trialIndex === i)
      const on = arms.on.trials.find(t => t.taskId === task.taskId && t.trialIndex === i)
      for (let p = 1; p < task.phases; p += 1) {
        assert.ok(
          on.phases[p].metrics.inputTokens < off.phases[p].metrics.inputTokens,
          `${task.taskId} #${i} phase ${p}: on ${on.phases[p].metrics.inputTokens} < off ${off.phases[p].metrics.inputTokens}`,
        )
      }
    }
  }
})

test('keeps the built report at the honest tie grade', async () => {
  const { dir } = await generateAndRead()
  const uiDataPath = path.join(dir, 'ui-data-out.js')
  const report = await buildExperiment(dir, { uiDataPath, generatedAt: '2026-08-18T00:00:00.000Z' })
  assert.equal(report.comparison.grade, 'tie')
})

test('is deterministic from the seed', async () => {
  const a = await generateAndRead(7)
  const b = await generateAndRead(7)
  const c = await generateAndRead(8)
  for (const arm of ['off', 'on']) {
    for (const file of ['run.json', 'trials.jsonl']) {
      const [xa, xb, xc] = await Promise.all([a, b, c].map(x => readFile(path.join(x.dir, arm, file), 'utf8')))
      assert.equal(xa, xb, `seed 7 twice: ${arm}/${file} must be byte-identical`)
      assert.notEqual(xa, xc, `seed 7 vs 8: ${arm}/${file} must differ`)
    }
  }
})

test('refuses to overwrite a directory without the synthetic marker', async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), 'bench-demo-guard-'))
  const realDir = path.join(runsRoot, 'w0-real')
  await mkdir(realDir)
  await writeFile(path.join(realDir, 'note.txt'), 'real data')
  await assert.rejects(
    generateExperiment({ runsRoot, experiment: 'w0-real' }),
    /refusing to overwrite non-synthetic/,
  )
  await assert.rejects(
    generateExperiment({ runsRoot, experiment: '../escape' }),
    /plain directory name/,
  )
})

test('parseArgs handles defaults, flags, and rejects junk', () => {
  assert.deepEqual(parseArgs([]), { experiment: 'demo', seed: 42, help: false })
  assert.deepEqual(parseArgs(['--experiment', 'w0', '--seed', '7']), { experiment: 'w0', seed: 7, help: false })
  assert.deepEqual(parseArgs(['--seed=9']), { experiment: 'demo', seed: 9, help: false })
  assert.deepEqual(parseArgs(['--help']), { experiment: 'demo', seed: 42, help: true })
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--seed', 'x']), /--seed must be a non-negative integer/)
  assert.throws(() => parseArgs(['--seed']), /needs a value/)
})
