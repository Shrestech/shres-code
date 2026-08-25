/**
 * Tests for bench/report: build.js rebuilds results.json per arm and a
 * validated ReportData payload from a fake runs tree; serve.js resolves
 * requests safely and serves the UI with correct MIME types.
 *
 * @module bench/tests/report.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { validateReportData } from '../schema/report-data.js'
import { buildExperiment, loadArm, parseArgs, resolveExperimentDir } from '../report/build.js'
import { contentType, resolveRequest, serve } from '../report/serve.js'

const FIXED_NOW = '2026-08-18T00:00:00.000Z'

/**
 * Fabricate a valid Trial record.
 * @param {object} overrides - fields to override on the default record.
 * @returns {import('../schema/trial.js').Trial}
 */
function trial(overrides) {
  const { metrics: metricsOverride, ...rest } = overrides ?? {}
  return {
    taskId: 'alpha',
    trialIndex: 0,
    arm: 'off',
    status: 'success',
    resolved: true,
    failureMode: null,
    verifier: { command: 'node verify.mjs', exitCode: 0 },
    metrics: {
      inputTokens: 1000,
      outputTokens: 200,
      durationMs: 30_000,
      turns: 6,
      toolCalls: 8,
      identicalRetries: 0,
      checkpoints: 0,
      shipPasses: 0,
      tokensIncludingDescendants: null,
      costIncludingDescendants: null,
      danglingCard: null,
      verifiedCheckpointShare: null,
      coverageRefusalThenPad: 0,
      noopNoteRefusals: 0,
      noteCapRefusals: 0,
      sessionQueryCalls: null,
      compactionCount: 0,
      pressureFired: false,
      ...metricsOverride,
    },
    sessionFile: null,
    startedAt: '2026-08-18T00:00:00.000Z',
    endedAt: '2026-08-18T00:01:00.000Z',
    ...rest,
  }
}

/**
 * Fabricate a valid RunManifest.
 * @param {string} experiment - experiment name.
 * @param {string} arm - arm name.
 * @returns {import('../schema/run-manifest.js').RunManifest}
 */
function manifest(experiment, arm) {
  return {
    version: 1,
    experiment,
    arm,
    armConfig: { enabled: arm === 'on' },
    model: 'deepseek-chat',
    baseUrl: null,
    temperature: 0,
    repeats: 3,
    taskIds: ['alpha', 'beta'],
    gitCommit: 'deadbeef',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    tierPatches: [],
    startedAt: '2026-08-18T00:00:00.000Z',
    endedAt: '2026-08-18T01:00:00.000Z',
  }
}

/**
 * Write one arm directory: run.json plus trials.jsonl.
 * @param {string} experimentDir - parent experiment directory.
 * @param {string} arm - arm name.
 * @param {import('../schema/trial.js').Trial[]} trials - trials to append.
 */
async function writeArm(experimentDir, arm, trials) {
  const dir = join(experimentDir, arm)
  await mkdir(dir, { recursive: true })
  const experiment = experimentDir.split(/[/\\]/).pop()
  await writeFile(join(dir, 'run.json'), JSON.stringify(manifest(experiment, arm)) + '\n')
  await writeFile(join(dir, 'trials.jsonl'), trials.map(t => JSON.stringify(t)).join('\n') + '\n')
}

/**
 * Build the standard fake runs tree: two arms over tasks alpha and beta,
 * including one error trial in the off arm.
 * @param {string} root - temp root.
 * @param {string} [experiment] - experiment name.
 * @returns {Promise<string>} the experiment directory.
 */
async function fakeRunsTree(root, experiment = 'exp1') {
  const dir = join(root, experiment)
  const off = [
    trial({ taskId: 'alpha', trialIndex: 0, arm: 'off', resolved: true }),
    trial({ taskId: 'alpha', trialIndex: 1, arm: 'off', resolved: false, failureMode: 'VERIFY_FAILED', verifier: { command: 'node verify.mjs', exitCode: 1 } }),
    trial({ taskId: 'alpha', trialIndex: 2, arm: 'off', status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR' }),
    trial({ taskId: 'beta', trialIndex: 0, arm: 'off', resolved: false, failureMode: 'VERIFY_FAILED', verifier: { command: 'node verify.mjs', exitCode: 1 }, metrics: { inputTokens: 500, outputTokens: 100, durationMs: 10_000, turns: 3, toolCalls: 2, identicalRetries: 1, checkpoints: 0, shipPasses: 0 } }),
    trial({ taskId: 'beta', trialIndex: 1, arm: 'off', resolved: false, failureMode: 'VERIFY_FAILED', verifier: { command: 'node verify.mjs', exitCode: 1 }, metrics: { inputTokens: 500, outputTokens: 100, durationMs: 10_000, turns: 3, toolCalls: 2, identicalRetries: 1, checkpoints: 0, shipPasses: 0 } }),
  ]
  const on = [
    trial({ taskId: 'alpha', trialIndex: 0, arm: 'on', resolved: true, metrics: { inputTokens: 1100, outputTokens: 220, durationMs: 32_000, turns: 6, toolCalls: 9, identicalRetries: 0, checkpoints: 2, shipPasses: 1 } }),
    trial({ taskId: 'alpha', trialIndex: 1, arm: 'on', resolved: true, metrics: { inputTokens: 1100, outputTokens: 220, durationMs: 32_000, turns: 6, toolCalls: 9, identicalRetries: 0, checkpoints: 2, shipPasses: 1 } }),
    trial({ taskId: 'alpha', trialIndex: 2, arm: 'on', resolved: true, metrics: { inputTokens: 1100, outputTokens: 220, durationMs: 32_000, turns: 6, toolCalls: 9, identicalRetries: 0, checkpoints: 2, shipPasses: 1 } }),
    trial({ taskId: 'beta', trialIndex: 0, arm: 'on', resolved: true, metrics: { inputTokens: 550, outputTokens: 110, durationMs: 11_000, turns: 3, toolCalls: 3, identicalRetries: 0, checkpoints: 1, shipPasses: 1 } }),
    trial({ taskId: 'beta', trialIndex: 1, arm: 'on', resolved: true, metrics: { inputTokens: 550, outputTokens: 110, durationMs: 11_000, turns: 3, toolCalls: 3, identicalRetries: 0, checkpoints: 1, shipPasses: 1 } }),
  ]
  await writeArm(dir, 'off', off)
  await writeArm(dir, 'on', on)
  return dir
}

/**
 * Write a task catalog with only alpha present; beta exercises the fallback.
 * @param {string} root - temp root.
 * @returns {Promise<string>} the tasks directory.
 */
async function fakeTasksCatalog(root) {
  const dir = join(root, 'tasks')
  await mkdir(join(dir, 'alpha'), { recursive: true })
  await writeFile(join(dir, 'alpha', 'task.json'), JSON.stringify({
    taskId: 'alpha',
    stratum: 'adversarial',
    description: 'Alpha task from the catalog.',
    instruction: 'Do the alpha thing.',
    verify: 'node verify.mjs',
    timeoutMs: 600_000,
    maxTurns: 40,
  }) + '\n')
  return dir
}

test('parseArgs: defaults to latest, accepts --experiment, rejects junk', () => {
  assert.deepEqual(parseArgs([]), { experiment: 'latest' })
  assert.deepEqual(parseArgs(['--experiment', 'w0']), { experiment: 'w0' })
  assert.deepEqual(parseArgs(['--experiment', 'latest']), { experiment: 'latest' })
  assert.throws(() => parseArgs(['--experiment']), /--experiment requires a value/)
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
})

test('resolveExperimentDir: named dir, latest by mtime, empty runs dir throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-resolve-'))
  try {
    const named = await fakeRunsTree(root, 'exp1')
    assert.equal(await resolveExperimentDir(root, 'exp1'), named)
    assert.equal(await resolveExperimentDir(root, 'latest'), named)
    await assert.rejects(() => resolveExperimentDir(root, 'missing'), /experiment not found/)
    const empty = join(root, 'empty')
    await mkdir(empty)
    await assert.rejects(() => resolveExperimentDir(empty, 'latest'), /no experiments/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadArm: validates manifest and every trials.jsonl line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-load-'))
  try {
    const dir = join(root, 'exp1')
    await writeArm(dir, 'off', [trial({})])
    const { manifest: m, trials } = await loadArm(join(dir, 'off'))
    assert.equal(m.arm, 'off')
    assert.equal(trials.length, 1)

    await writeFile(join(dir, 'off', 'trials.jsonl'), '{"taskId":\n')
    await assert.rejects(() => loadArm(join(dir, 'off')), /not valid JSON/)

    await writeFile(join(dir, 'off', 'trials.jsonl'), JSON.stringify({ taskId: 'alpha' }) + '\n')
    await assert.rejects(() => loadArm(join(dir, 'off')), /trials\.jsonl:1/)

    // A missing trials.jsonl (interrupted run) reads as zero trials.
    await rm(join(dir, 'off', 'trials.jsonl'))
    const empty = await loadArm(join(dir, 'off'))
    assert.equal(empty.trials.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildExperiment: skips experiment subdirectories without a run.json (scratch, .shres-home)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-scratch-'))
  try {
    const experimentDir = await fakeRunsTree(root)
    const tasksDir = await fakeTasksCatalog(root)
    await mkdir(join(experimentDir, 'scratch', 'off'), { recursive: true })
    await mkdir(join(experimentDir, '.shres-home'), { recursive: true })

    const report = await buildExperiment(experimentDir, { tasksDir, uiDataPath: join(root, 'ui', 'data.js'), generatedAt: FIXED_NOW })
    assert.deepEqual(report.arms.map(a => a.arm), ['off', 'on'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildExperiment: results.json per arm and a valid ReportData payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-build-'))
  try {
    const experimentDir = await fakeRunsTree(root)
    const tasksDir = await fakeTasksCatalog(root)
    const uiDataPath = join(root, 'ui', 'data.js')

    const report = await buildExperiment(experimentDir, { tasksDir, uiDataPath, generatedAt: FIXED_NOW })
    validateReportData(report)

    assert.equal(report.version, 1)
    assert.equal(report.experiment, 'exp1')
    assert.equal(report.demo, false)
    assert.equal(report.generatedAt, FIXED_NOW)

    // Task catalog: alpha from disk, beta falls back to taskId + long stratum.
    assert.deepEqual(report.tasks, [
      { taskId: 'alpha', stratum: 'adversarial', description: 'Alpha task from the catalog.' },
      { taskId: 'beta', stratum: 'long', description: 'beta' },
    ])

    // Arm summaries: error trials excluded from rates, arms ordered off first.
    assert.deepEqual(report.arms.map(a => a.arm), ['off', 'on'])
    const [off, on] = report.arms
    assert.equal(off.trials, 4)
    assert.equal(off.accuracy, 0.25)
    assert.equal(off.totalInputTokens, 3000)
    assert.equal(off.totalIdenticalRetries, 2)
    assert.equal(on.trials, 5)
    assert.equal(on.accuracy, 1)
    assert.ok(Array.isArray(off.ci95) && off.ci95.length === 2)

    // Cells: one per task×arm, error trial counted but excluded from passRate.
    assert.equal(report.cells.length, 4)
    const alphaOff = report.cells.find(c => c.arm === 'off' && c.taskId === 'alpha')
    assert.equal(alphaOff.trials, 2)
    assert.equal(alphaOff.errors, 1)
    assert.equal(alphaOff.resolved, 1)
    assert.equal(alphaOff.passRate, 0.5)
    const alphaOn = report.cells.find(c => c.arm === 'on' && c.taskId === 'alpha')
    assert.equal(alphaOn.passRate, 1)
    assert.equal(alphaOn.meanCheckpoints, 2)

    // Comparisons: one off-vs-on pairing with McNemar counts and bootstrap interval.
    assert.equal(report.comparisons.length, 1)
    assert.equal(report.comparisons[0].treatment, 'on')
    const pairs = report.comparisons[0].pairs
    assert.equal(pairs.length, 2)
    const alphaPair = pairs.find(p => p.taskId === 'alpha')
    assert.equal(alphaPair.delta, 0.5)
    assert.equal(alphaPair.winner, 'on')
    assert.equal(alphaPair.treatment, 'on')
    assert.equal(alphaPair.wins, 1)
    assert.equal(alphaPair.losses, 0)
    assert.equal(alphaPair.ties, 1)
    assert.ok(Array.isArray(alphaPair.deltaCi95) && alphaPair.deltaCi95.length === 2)
    const betaPair = pairs.find(p => p.taskId === 'beta')
    assert.equal(betaPair.delta, 1)
    assert.equal(betaPair.wins, 2)

    // Comparison: 3 wins, 0 losses overall -> p = 2 * 0.5^3 = 0.25, grade tie.
    assert.equal(report.comparisons[0].mcnemarP, 0.25)
    assert.equal(report.comparisons[0].deltaAccuracy, 0.75)
    assert.equal(report.comparisons[0].grade, 'tie')

    // results.json rebuilt per arm.
    const offResults = JSON.parse(await readFile(join(experimentDir, 'off', 'results.json'), 'utf8'))
    assert.equal(offResults.version, 1)
    assert.equal(offResults.experiment, 'exp1')
    assert.equal(offResults.arm, 'off')
    assert.equal(offResults.summary.trials, 4)
    assert.equal(offResults.cells.length, 2)
    const onResults = JSON.parse(await readFile(join(experimentDir, 'on', 'results.json'), 'utf8'))
    assert.equal(onResults.summary.accuracy, 1)

    // ui/data.js: global assignment wrapping the same payload.
    const dataJs = await readFile(uiDataPath, 'utf8')
    assert.ok(dataJs.startsWith('globalThis.BENCH_REPORT = '))
    assert.ok(dataJs.endsWith(';\n'))
    const roundTripped = JSON.parse(dataJs.slice('globalThis.BENCH_REPORT = '.length, -2))
    validateReportData(roundTripped)
    assert.equal(roundTripped.experiment, 'exp1')
    assert.equal(roundTripped.cells.length, 4)
    assert.equal(roundTripped.comparisons[0].mcnemarP, 0.25)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildExperiment: demo marker file flags the synthetic experiment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-demo-'))
  try {
    const experimentDir = await fakeRunsTree(root, 'demo')
    const tasksDir = await fakeTasksCatalog(root)
    const uiDataPath = join(root, 'ui', 'data.js')

    let report = await buildExperiment(experimentDir, { tasksDir, uiDataPath, generatedAt: FIXED_NOW })
    assert.equal(report.demo, false, 'no marker file yet')

    await writeFile(join(experimentDir, 'demo'), 'synthetic data\n')
    report = await buildExperiment(experimentDir, { tasksDir, uiDataPath, generatedAt: FIXED_NOW })
    assert.equal(report.demo, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildExperiment: fails loud on a corrupt trials.jsonl', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-corrupt-'))
  try {
    const experimentDir = await fakeRunsTree(root)
    await writeFile(join(experimentDir, 'on', 'trials.jsonl'), JSON.stringify({ bogus: true }) + '\n')
    await assert.rejects(
      () => buildExperiment(experimentDir, { tasksDir: join(root, 'tasks'), uiDataPath: join(root, 'ui', 'data.js') }),
      /trials\.jsonl:1/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('buildExperiment: chain strata and chain trials flow through unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-chain-'))
  try {
    const dir = join(root, 'exp1')
    /**
     * Fabricate a valid PhaseRecord.
     * @param {number} phaseIndex - zero-based phase order.
     * @param {number} inputTokens - phase input tokens.
     * @returns {import('../schema/trial.js').PhaseRecord}
     */
    const phase = (phaseIndex, inputTokens) => ({
      phaseIndex,
      sessionFile: `sessions/chain-task/0/phase-${phaseIndex}/w/s1/session.jsonl`,
      resumedFrom: null,
      exitCode: 0,
      timedOut: false,
      metrics: {
        inputTokens, outputTokens: 20, durationMs: 5000, turns: 2, toolCalls: 3, identicalRetries: 0, checkpoints: 0, shipPasses: 0,
        tokensIncludingDescendants: null, costIncludingDescendants: null, danglingCard: null, verifiedCheckpointShare: null,
        coverageRefusalThenPad: 0, noopNoteRefusals: 0, noteCapRefusals: 0, sessionQueryCalls: null,
        compactionCount: 0, pressureFired: false,
      },
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:00:05.000Z',
    })
    const chainPhases = [phase(0, 100), phase(1, 70)]
    await writeArm(dir, 'off', [trial({
      taskId: 'chain-task',
      arm: 'off',
      trialIndex: 0,
      metrics: { inputTokens: 170, outputTokens: 40, durationMs: 10_000, turns: 4, toolCalls: 6, identicalRetries: 0, checkpoints: 0, shipPasses: 0 },
      sessionFile: chainPhases[1].sessionFile,
      phases: chainPhases,
      integrity: { violations: ['off-arm-jspace-event:jspace/card'] },
    })])
    await writeArm(dir, 'on', [trial({
      taskId: 'chain-task',
      arm: 'on',
      trialIndex: 0,
      metrics: { inputTokens: 130, outputTokens: 40, durationMs: 9000, turns: 4, toolCalls: 6, identicalRetries: 0, checkpoints: 2, shipPasses: 1 },
      sessionFile: chainPhases[1].sessionFile,
      phases: chainPhases,
    })])

    const tasksDir = join(root, 'tasks')
    await mkdir(join(tasksDir, 'chain-task'), { recursive: true })
    await writeFile(join(tasksDir, 'chain-task', 'task.json'), JSON.stringify({
      taskId: 'chain-task',
      stratum: 'chain',
      description: 'Chain task from the catalog.',
      phases: [{ instruction: 'one' }, { instruction: 'two' }],
      verify: 'node verify.mjs',
      timeoutMs: 600_000,
    }) + '\n')

    const report = await buildExperiment(dir, { tasksDir, uiDataPath: join(root, 'ui', 'data.js'), generatedAt: FIXED_NOW })
    validateReportData(report)

    // The catalog's chain stratum reaches the report (alpha/beta fall back).
    assert.deepEqual(
      report.tasks.find(t => t.taskId === 'chain-task'),
      { taskId: 'chain-task', stratum: 'chain', description: 'Chain task from the catalog.' },
    )

    // Embedded trials keep phases and integrity intact.
    const embedded = report.trials.find(t => t.arm === 'off')
    assert.equal(embedded.phases.length, 2)
    assert.deepEqual(embedded.integrity, { violations: ['off-arm-jspace-event:jspace/card'] })

    // Aggregates stay trial-level: one cell per arm, sums from trial.metrics.
    assert.equal(report.cells.length, 2)
    assert.equal(report.arms[0].totalInputTokens, 170)
    assert.equal(report.comparisons.length, 1)
    assert.equal(report.comparisons[0].pairs.length, 1)
    assert.equal(report.comparisons[0].pairs[0].taskId, 'chain-task')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateReportData: rejects a malformed embedded chain trial', () => {
  const report = {
    version: 1,
    demo: false,
    generatedAt: FIXED_NOW,
    experiment: 'exp1',
    tasks: [],
    cells: [],
    pairs: [],
    arms: [],
    comparisons: [],
    trials: [trial({ phases: [{ phaseIndex: 7 }] })],
  }
  assert.throws(() => validateReportData(report), /report\.trials\[0\]: trial\.phases\[0\]/)
})

test('validateReportData: rejects a non-array comparisons field and a baseline treatment', () => {
  const base = {
    version: 1,
    demo: false,
    generatedAt: FIXED_NOW,
    experiment: 'exp1',
    tasks: [],
    cells: [],
    arms: [],
  }
  assert.throws(
    () => validateReportData({ ...base, comparisons: { grade: 'tie', deltaAccuracy: 0, mcnemarP: null } }),
    /report\.comparisons must be an array/,
  )
  assert.throws(
    () => validateReportData({
      ...base,
      comparisons: [{ treatment: 'off', grade: 'tie', deltaAccuracy: 0, mcnemarP: null, pairs: [] }],
    }),
    /report\.comparisons\[0\]\.treatment must not be the baseline arm "off"/,
  )
  assert.throws(
    () => validateReportData({
      ...base,
      comparisons: [{ treatment: 'on', grade: 'maybe', deltaAccuracy: 0, mcnemarP: null, pairs: [] }],
    }),
    /report\.comparisons\[0\]\.grade must be improvement\|regression\|tradeoff\|tie/,
  )
})

test('buildExperiment: pressure stratum and one comparison per treatment arm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-multi-'))
  try {
    const dir = join(root, 'exp1')
    await writeArm(dir, 'off', [
      trial({ taskId: 'press', trialIndex: 0, arm: 'off', resolved: false, failureMode: 'VERIFY_FAILED', verifier: { command: 'node verify.mjs', exitCode: 1 } }),
      trial({ taskId: 'press', trialIndex: 1, arm: 'off', resolved: false, failureMode: 'VERIFY_FAILED', verifier: { command: 'node verify.mjs', exitCode: 1 } }),
    ])
    await writeArm(dir, 'on', [
      trial({
        taskId: 'press', trialIndex: 0, arm: 'on', resolved: true,
        metrics: { danglingCard: false, verifiedCheckpointShare: 1, noopNoteRefusals: 1, sessionQueryCalls: null, compactionCount: 2, pressureFired: true },
      }),
      trial({
        taskId: 'press', trialIndex: 1, arm: 'on', resolved: true,
        metrics: { danglingCard: true, verifiedCheckpointShare: 0.5, noopNoteRefusals: 0, sessionQueryCalls: null, compactionCount: 1, pressureFired: true },
      }),
    ])
    await writeArm(dir, 'on-adaptive', [
      trial({
        taskId: 'press', trialIndex: 0, arm: 'on-adaptive', resolved: true,
        metrics: { danglingCard: false, verifiedCheckpointShare: 0.8, sessionQueryCalls: 3, compactionCount: 2, pressureFired: true },
      }),
      trial({
        taskId: 'press', trialIndex: 1, arm: 'on-adaptive', resolved: false, failureMode: 'VERIFY_FAILED', verifier: { command: 'node verify.mjs', exitCode: 1 },
        metrics: { danglingCard: false, verifiedCheckpointShare: null, sessionQueryCalls: 1, compactionCount: 0, pressureFired: false },
      }),
    ])

    const tasksDir = join(root, 'tasks')
    await mkdir(join(tasksDir, 'press'), { recursive: true })
    await writeFile(join(tasksDir, 'press', 'task.json'), JSON.stringify({
      taskId: 'press',
      stratum: 'pressure',
      description: 'Pressure task from the catalog.',
      instruction: 'Survive.',
      verify: 'node verify.mjs',
      timeoutMs: 600_000,
      maxTurns: 80,
    }) + '\n')

    const report = await buildExperiment(dir, { tasksDir, uiDataPath: join(root, 'ui', 'data.js'), generatedAt: FIXED_NOW })
    validateReportData(report)

    assert.deepEqual(
      report.tasks.find(t => t.taskId === 'press'),
      { taskId: 'press', stratum: 'pressure', description: 'Pressure task from the catalog.' },
    )
    assert.deepEqual(report.comparisons.map(c => c.treatment), ['on', 'on-adaptive'])
    assert.equal(report.comparisons[0].pairs[0].winner, 'on')
    assert.equal(report.comparisons[1].treatment, 'on-adaptive')
    assert.equal(report.comparisons[1].pairs[0].treatment, 'on-adaptive')

    const onArm = report.arms.find(a => a.arm === 'on')
    assert.equal(onArm.meanDanglingCard, 0.5)
    assert.equal(onArm.meanVerifiedCheckpointShare, 0.75)
    assert.equal(onArm.totalNoopNoteRefusals, 1)
    assert.equal(onArm.totalCompactionCount, 3)
    assert.equal(onArm.pressureFiredRate, 1)
    const adaptive = report.arms.find(a => a.arm === 'on-adaptive')
    assert.equal(adaptive.meanSessionQueryCalls, 2)
    assert.equal(adaptive.totalCompactionCount, 2)
    assert.equal(adaptive.pressureFiredRate, 0.5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveRequest: traversal guard and index.html fallback', () => {
  const root = join(tmpdir(), 'bench-ui-root')
  assert.deepEqual(resolveRequest(root, '/'), { file: join(root, 'index.html'), fallback: true })
  assert.deepEqual(resolveRequest(root, '/app.js'), { file: join(root, 'app.js'), fallback: false })
  assert.deepEqual(resolveRequest(root, '/some/route'), { file: join(root, 'some/route', 'index.html'), fallback: true })
  // normalize() clamps leading '..' segments: the request stays inside root.
  const clamped = resolveRequest(root, '/../../etc/passwd')
  assert.equal(clamped.file, join(root, 'etc/passwd', 'index.html'))
  assert.equal(clamped.fallback, true)
  const encoded = resolveRequest(root, '/%2e%2e/%2e%2e/etc/passwd')
  assert.equal(encoded.file, join(root, 'etc/passwd', 'index.html'))
  assert.equal(encoded.fallback, true)
  // A relative escape (no leading slash) survives normalize; the guard catches it.
  const escaped = resolveRequest(root, 'a/../../../etc/passwd')
  assert.equal(escaped.file, join(root, 'index.html'))
  assert.equal(escaped.fallback, true)
})

test('contentType: known extensions and the octet-stream default', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8')
  assert.equal(contentType('app.js'), 'text/javascript; charset=utf-8')
  assert.equal(contentType('styles.css'), 'text/css; charset=utf-8')
  assert.equal(contentType('logo.svg'), 'image/svg+xml')
  assert.equal(contentType('x.bin'), 'application/octet-stream')
})

test('serve: serves files with MIME types, falls back, and 404s assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bench-report-serve-'))
  const server = serve({ root, port: 0 })
  try {
    await writeFile(join(root, 'index.html'), '<html>bench</html>\n')
    await writeFile(join(root, 'app.js'), 'export {}\n')
    // The bind may complete during the writes above; only wait when it has not.
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
    const base = `http://127.0.0.1:${port}`

    const index = await fetch(`${base}/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type'), /text\/html/)
    assert.match(await index.text(), /bench/)

    const js = await fetch(`${base}/app.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /text\/javascript/)

    const fallback = await fetch(`${base}/deep/link`)
    assert.equal(fallback.status, 200)
    assert.match(fallback.headers.get('content-type'), /text\/html/)

    const missing = await fetch(`${base}/missing.js`)
    assert.equal(missing.status, 404)

    const traversal = await fetch(`${base}/../../../etc/passwd`)
    assert.equal(traversal.status, 200)
    assert.match(await traversal.text(), /bench/)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
