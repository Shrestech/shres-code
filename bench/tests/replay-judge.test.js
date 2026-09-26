/**
 * Fitted-judge stage: exact eligible/answered counts, live-equal inputs,
 * mapping, honest failures, preflight refusals, prepare-only zero asks.
 * Hosted, keyless. Do not invent labels.
 * @module
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  KEEP_CURRENT_OPTION_ID,
  MODEL_ROUTER_JUDGMENT_CONSUMER,
} from '../../packages/llm/model-router/lib/index.js'
import { hostReplayRun, hostReplayTrial } from '../routing/replay-frontend-host.js'
import { REPLAY_SCRIPTED_FITTING_JUDGE_PATH } from '../routing/replay-frontend-overlay.js'
import { validateReplayRow } from '../analysis/replay-metrics.js'
import { fixtureMethod } from './replay-fixture-method.js'
import { projectKey, encodeSegment } from '../runner/session-layout.js'

const fixture = new URL('../routing/fixtures/replay-c-label-windows.session.jsonl', import.meta.url)
const method = fixtureMethod()
const repo = join(fileURLToPath(new URL('../..', import.meta.url)))
const ownRoute = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const tasks = { 'task-a': { stratum: 'routine' } }

function trialOf(id, path) {
  return {
    id, taskId: 'task-a', trialIndex: 0, arm: 'C', path,
    trialOwnRoute: ownRoute,
    trial: { resolved: true, verifier: { command: 'node verify.mjs', exitCode: 0 } },
  }
}

async function plant(bytes, label) {
  const header = JSON.parse(bytes.toString('utf8').split('\n')[0])
  const root = await mkdtemp(join(tmpdir(), 'bench-judge-' + label + '-'))
  const dir = join(root, projectKey(header.cwd), encodeSegment(header.id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl')
  await writeFile(path, bytes)
  return { root, path, header }
}

function yamlScript(obj, indent) {
  return JSON.stringify(obj)
}

function fittingOverlay(config) {
  return [
    '- id: bench-replay-scripted-judge',
    '  disabled: true',
    '- insert:',
    '    - id: bench-replay-scripted-fitting-judge',
    '      name: ' + JSON.stringify(REPLAY_SCRIPTED_FITTING_JUDGE_PATH),
    '      config: ' + yamlScript(config),
    '',
  ].join('\n')
}

function routerOverlay(overrides) {
  const config = {
    initialMode: 'on',
    tier: 'fast',
    downgradeThreshold: 0.8,
    downgradeMargin: 0.1,
    candidates: [{ id: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash', description: 'small' }],
    routeFrom: [{ provider: 'anthropic', model: 'claude-opus-5-5', objective: 'quota' }],
    operatingPoints: [{ engine: 'laya', downgradeThreshold: 0.8, downgradeMargin: 0.1 }],
    hold: { minSteps: 20, maxSteps: 40 },
    difficulty: { entryScoreCeiling: 2 },
    reentryCooldownTurns: 2,
    escalateBack: { scoreThreshold: 4 },
    maxRouteErrors: 2,
    onUnavailable: 'fallback',
    judgmentDeadlineMs: 1500,
    judgmentFailures: { holdTolerance: 2, breakerThreshold: 3, breakerOpenTurns: 5 },
    routeInstructions: 'Which route should handle this turn?',
    difficultyInstructions: 'How hard is this turn?',
    ...overrides,
  }
  if (overrides && Object.hasOwn(overrides, 'difficultyInstructions') && overrides.difficultyInstructions === undefined) {
    delete config.difficultyInstructions
  }
  return [
    '- id: model-router',
    '  name: "@shres-code/shres-code-model-router"',
    '  config: ' + JSON.stringify(config),
    '',
  ].join('\n')
}

function deadlineOverlay(ms) {
  return routerOverlay({ judgmentDeadlineMs: ms })
}

function noDifficultyOverlay() {
  return routerOverlay({ hold: { minSteps: 0 }, difficultyInstructions: undefined })
}

function disabledJudgmentOverlay() {
  return [
    '- id: settings',
    '  config:',
    '    judgment:',
    '      enabled: false',
    '      engine: scripted-fitting',
    '',
  ].join('\n')
}

async function hostJudge(label, opts = {}) {
  const bytes = await readFile(fixture)
  const planted = await plant(bytes, label)
  try {
    const hosted = await hostReplayTrial({
      repoRoot: repo,
      trial: trialOf(label, planted.path).trial,
      path: planted.path,
      arm: 'C',
      method,
      trialOwnRoute: ownRoute,
      judge: opts.judge !== false,
      extraOverlay: opts.extraOverlay,
      fittingJudgePath: opts.fittingJudgePath ?? REPLAY_SCRIPTED_FITTING_JUDGE_PATH,
      fittingJudgeConfig: opts.fittingJudgeConfig ?? { defaultScript: { kind: 'answered' } },
      judgmentEnabled: opts.judgmentEnabled,
    })
    return { hosted, planted }
  } catch (error) {
    await rm(planted.root, { recursive: true, force: true })
    throw error
  }
}

test('prepare-only records zero asks and leaves every prepared row unanswered', async () => {
  const bytes = await readFile(fixture)
  const planted = await plant(bytes, 'prepare')
  try {
    const prepared = await hostReplayRun({
      repoRoot: repo, method, tasks,
      trials: [trialOf('good', planted.path)],
    })
    const judged = await hostReplayRun({
      repoRoot: repo, method, tasks,
      trials: [trialOf('good', planted.path)],
      judge: true,
      fittingJudgePath: REPLAY_SCRIPTED_FITTING_JUDGE_PATH,
      fittingJudgeConfig: { defaultScript: { kind: 'answered' } },
    })
    assert.equal((prepared.summaries[0].summary.asks ?? []).length, 0)
    assert.equal((prepared.asks ?? []).length, 0)
    const judgedEligible = judged.rows.filter(row => row.eligible === true)
    assert.equal((judged.summaries[0].summary.asks ?? []).length, judgedEligible.length)
    assert.equal(judgedEligible.length > 0, true)
    for (const row of prepared.rows) {
      validateReplayRow(row, 'prepare-only')
      assert.equal(row.answered, false)
    }
    for (const row of judged.rows) validateReplayRow(row, 'judged')
    const prepCounts = prepared.summaries[0].summary.counts
    const judgedCounts = judged.summaries[0].summary.counts
    assert.deepEqual(prepCounts.byPhase.consult, judgedCounts.byPhase.consult)
    assert.equal(prepCounts.byPhase['s-validation'].prepareCall, 0)
    assert.equal(judgedCounts.byPhase['s-validation'].prepareCall, 0)
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('one ask per eligible row with live-equal inputs and pinned mappings', async () => {
  const { hosted, planted } = await hostJudge('map', { fittingJudgeConfig: {
    defaultScript: {
      kind: 'answered',
      winner: 'flash',
      probabilities: { [KEEP_CURRENT_OPTION_ID]: 0.3, flash: 0.6, vision: 0.1 },
      selectedIndex: 0,
      stateTokens: 80,
      sequenceTokens: [120, 95],
      difficultyScore: 2,
    },
  } })
  try {
    const eligible = hosted.rows.filter(row => row.eligible === true)
    const askConsults = hosted.consults.filter(entry => entry.result.kind === 'ask')
    assert.equal(eligible.length, askConsults.length)
    assert.equal(eligible.length > 0, true)
    assert.equal(hosted.asks.length, eligible.length)
    assert.equal(hosted.asks.length, hosted.rows.filter(row => row.answered === true).length)
    const recorded = hosted.summary.recordedAsks
    assert.equal(recorded.length, eligible.length)
    for (const [index, row] of eligible.entries()) {
      const consult = hosted.consults.find(entry => entry.turn === row.turn && entry.step === row.step)
      assert.equal(consult.result.kind, 'ask')
      const recordedAsk = recorded[index]
      assert.deepEqual(recordedAsk.states, consult.result.states)
      assert.deepEqual(recordedAsk.questions, consult.result.questions)
      assert.equal(recordedAsk.consumer, MODEL_ROUTER_JUDGMENT_CONSUMER)
      assert.deepEqual(recordedAsk.correlation, {
        sessionId: planted.header.id,
        consultKey: 'turn:' + String(row.turn) + '/step:' + String(row.step),
      })
      assert.equal(recordedAsk.tier, hosted.summary.routerConfig.tier)
      assert.equal(recordedAsk.hasSignal, true)
      assert.equal(row.answered, true)
      assert.equal(row.truncated, false)
      assert.equal(row.headTokens, 40)
      assert.equal(row.winner, 'flash')
      assert.equal(row.pCheap, 0.7)
      assert.equal(row.margin, 0.3)
      assert.equal(row.difficultyScore, 2)
    }
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('keep-current winner maps pCheap 0.45 and truncated selectedIndex 2', async () => {
  const { hosted, planted } = await hostJudge('keep', { fittingJudgeConfig: {
    defaultScript: {
      kind: 'answered',
      winner: KEEP_CURRENT_OPTION_ID,
      probabilities: { [KEEP_CURRENT_OPTION_ID]: 0.55, flash: 0.45 },
      selectedIndex: 2,
      stateTokens: 80,
      sequenceTokens: [120, 95],
      difficultyScore: 1,
    },
  } })
  try {
    const eligible = hosted.rows.filter(row => row.eligible === true)
    const answered = hosted.rows.filter(row => row.answered === true)
    assert.equal(hosted.asks.length, eligible.length)
    assert.equal(answered.length, eligible.length)
    assert.equal(eligible.length > 0, true)
    for (const row of answered) {
      assert.equal(row.winner, KEEP_CURRENT_OPTION_ID)
      assert.equal(Number(row.pCheap.toFixed(2)), 0.45)
      assert.equal(row.truncated, true)
      assert.equal(row.headTokens, 40)
    }
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('unfit leaves every eligible row unanswered with one ask each', async () => {
  const { hosted, planted } = await hostJudge('unfit', { fittingJudgeConfig: { defaultScript: { kind: 'unfit', reason: 'state' } } })
  try {
    const eligible = hosted.rows.filter(row => row.eligible === true)
    assert.equal(hosted.asks.length, eligible.length)
    assert.equal(eligible.length > 0, true)
    assert.ok(hosted.asks.every(ask => ask.outcome.startsWith('unfit:')))
    for (const row of hosted.rows) assert.equal(row.answered, false)
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('UNAVAILABLE is unanswered and not retried', async () => {
  const { hosted, planted } = await hostJudge('unavail', { fittingJudgeConfig: { defaultScript: { kind: 'error:UNAVAILABLE' } } })
  try {
    const eligible = hosted.rows.filter(row => row.eligible === true)
    assert.equal(hosted.asks.length, eligible.length)
    assert.equal(hosted.summary.recordedAsks.length, eligible.length)
    assert.ok(hosted.asks.every(ask => ask.outcome === 'error:UNAVAILABLE'))
    for (const row of hosted.rows) assert.equal(row.answered, false)
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('late answer after judgmentDeadlineMs is unanswered deadline', async () => {
  const { hosted, planted } = await hostJudge(
    'late',
    { extraOverlay: deadlineOverlay(20), fittingJudgeConfig: { defaultScript: { kind: 'answered', delayMs: 80 } } },
  )
  try {
    const eligible = hosted.rows.filter(row => row.eligible === true)
    assert.equal(hosted.asks.length, eligible.length)
    assert.ok(hosted.asks.every(ask => ask.outcome === 'deadline'))
    for (const row of hosted.rows) assert.equal(row.answered, false)
  } finally {
    await rm(planted.root, { recursive: true, force: true })
  }
})

test('omit keep-current or difficulty is invalid-answer unanswered', async () => {
  for (const omit of ['keep-current', 'difficulty']) {
    const { hosted, planted } = await hostJudge('omit-' + omit, { fittingJudgeConfig: { defaultScript: { kind: 'answered', omit } } })
    try {
      const eligible = hosted.rows.filter(row => row.eligible === true)
      assert.equal(hosted.asks.length, eligible.length)
      assert.ok(hosted.asks.every(ask => ask.outcome === 'invalid-answer'))
      for (const row of hosted.rows) assert.equal(row.answered, false)
    } finally {
      await rm(planted.root, { recursive: true, force: true })
    }
  }
})

test('disabled judgment refuses with UsageError and no asks', async () => {
  await assert.rejects(
    () => hostJudge('disabled', { judgmentEnabled: false, fittingJudgeConfig: { defaultScript: { kind: 'answered' } } }),
    error => /judgment to be enabled/.test(error.message),
  )
})

test('verbalized calibration without acceptVerbalized refuses with no asks', async () => {
  await assert.rejects(
    () => hostJudge('verbal', { fittingJudgeConfig: { defaultScript: { kind: 'answered' }, calibration: 'verbalized' } }),
    error => /non-refused routing calibration/.test(error.message),
  )
})

test('non-fitting engine refuses with UsageError and no asks', async () => {
  const enginePath = fileURLToPath(new URL('../routing/replay-scripted-nonfitting-judge.mjs', import.meta.url))
  await assert.rejects(
    () => hostJudge('nonfit', {
      fittingJudgePath: enginePath,
      fittingJudgeConfig: {},
    }),
    error => /fitting judgment engine/.test(error.message),
  )
})

test('missing difficultyInstructions refuses with UsageError and no asks', async () => {
  await assert.rejects(
    () => hostJudge('nodiff', { extraOverlay: noDifficultyOverlay(), fittingJudgeConfig: { defaultScript: { kind: 'answered' } } }),
    error => /difficulty question/.test(error.message),
  )
})
