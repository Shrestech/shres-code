/**
 * Jev bench metrics: the routing/compaction fold over synthetic session logs —
 * including the cases where a missing datum must stay null instead of reading
 * as zero — the root-session cache shares read by the `TokenUsage` presence
 * contract, the trial schema's contract for those fields, and the aggregate
 * flow from trial records to the per-arm report payload.
 *
 * @module bench/tests/jev-metrics.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { foldSessionAccounting, priceAccounting } from '../runner/accounting.js'
import { emptyMetrics, foldSessionLog } from '../runner/metrics.js'
import { validateTrial } from '../schema/trial.js'
import { summarizeArm, summarizeCell } from '../stats/aggregate.js'
import { validateReportData } from '../schema/report-data.js'
import { buildExperiment } from '../report/build.js'

/** Metric fields this change adds, in TrialMetrics order. */
const JEV_FIELDS = [
  'cacheHitShare',
  'cacheUnreportedShare',
  'modelTransitions',
  'downgradedStreaks',
  'downgradedShare',
  'keptStrongShare',
  'routingHintCount',
  'jevCompactionAcceptedBelowThreshold',
  'jevSelectionDegraded',
]

/** The routing/compaction subset: every Jev field except the two usage-derived shares. */
const JEV_EVENT_FIELDS = JEV_FIELDS.filter(field => field !== 'cacheHitShare' && field !== 'cacheUnreportedShare')

/**
 * Render one session-log event line.
 * @param {string} type - session event type.
 * @param {Record<string, unknown>} data - event payload.
 * @param {number} time - epoch ms, distinct per line so durations stay ordered.
 * @returns {string} one JSONL line.
 */
function event(type, data, time) {
  return JSON.stringify({ type, seq: time, time, data })
}

/**
 * Join event lines into a session log.
 * @param {string[]} lines - JSONL lines.
 * @returns {string} the log text.
 */
function log(lines) {
  return lines.join('\n') + '\n'
}

/** @param {Record<string, unknown>} usage @param {number} time */
function usageEvent(usage, time) {
  return event('assistant/message', { turn: 0, step: 0, message: { role: 'assistant' }, usage }, time)
}

/** @param {string} provider @param {string} model @param {number} time */
function headerEvent(provider, model, time) {
  return event('request/header', { header: { config: { provider, model } }, reason: 'change' }, time)
}

/** @param {string} outcome @param {number} time @param {Record<string, unknown>} [extra] */
function decisionEvent(outcome, time, extra = {}) {
  return event('model-routing/decision', {
    outcome,
    reason: 'gate-passed',
    stateHash: 'state-hash',
    stateSeqs: [1],
    sticky: { active: outcome === 'downgraded', stepsElapsed: 0 },
    ...extra,
  }, time)
}

/** @param {string} verdict @param {number} time @param {Record<string, unknown>} [extra] */
function verificationEvent(verdict, time, extra = {}) {
  return event('compaction/verification', {
    compactionId: 'c-1',
    attempt: 1,
    provider: 'deepseek',
    model: 'deepseek-chat',
    questions: [],
    verdict,
    degraded: false,
    ...extra,
  }, time)
}

/** @param {boolean} degraded @param {number} time */
function selectionEvent(degraded, time) {
  return event('compaction/selection', {
    trigger: 'pressure',
    degraded,
    segments: [],
    boundaryAdjustments: [],
  }, time)
}

/**
 * Assert the routing/compaction fields are null — the "never measured" reading
 * a zero would corrupt.
 * @param {object} metrics - folded metrics.
 * @param {string[]} fields - fields expected null.
 */
function assertNull(metrics, fields) {
  for (const field of fields) {
    assert.equal(metrics[field], null, `${field} must be null, not ${JSON.stringify(metrics[field])}`)
  }
}

/** An accounting context that prices nothing: the shares need no prices. */
const UNPRICED = {
  snapshot: { id: '2026-09-24', entries: new Map() },
  config: {
    subscriptionProviders: [], localProviders: [], priceProviders: {},
    judgeEnginePriceProviders: {}, vendorPlanJudgeEngines: [], localJudgeEngines: [],
  },
  configSha256: '',
}

/**
 * Fold usage records into one root session log.
 * @param {Record<string, unknown>[]} usages - one usage record per assistant message.
 * @returns {string} the log text.
 */
function usageLog(usages) {
  return log(usages.map((usage, index) => usageEvent(usage, index + 1)))
}

/**
 * The root-session cache fields of one log.
 * @param {Record<string, unknown>[]} usages
 * @returns {{ cacheHitShare: number | null, cacheUnreportedShare: number | null }}
 */
function rootShares(usages) {
  const metrics = foldSessionLog(usageLog(usages))
  return { cacheHitShare: metrics.cacheHitShare, cacheUnreportedShare: metrics.cacheUnreportedShare }
}

describe('metrics.foldSessionLog: root-session cache shares, read by presence', () => {
  it('reads cache reads over the prompt tokens of records that reported them', () => {
    assert.deepEqual(rootShares([{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 100 }]), { cacheHitShare: 0.6, cacheUnreportedShare: 0 })
  })

  it('sums reads and prompt tokens across records', () => {
    assert.equal(rootShares([
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 },
      { inputTokens: 200, outputTokens: 20, cacheReadTokens: 160 },
    ]).cacheHitShare, 200 / 500)
  })

  it('is null, not zero, when the log reports no usage', () => {
    const metrics = foldSessionLog(log([
      event('step/end', { turn: 0, step: 0 }, 1),
      event('tool/call', { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' }, 2),
    ]))
    assert.equal(metrics.inputTokens, 0)
    assertNull(metrics, ['cacheHitShare', 'cacheUnreportedShare'])
  })

  it('is null when the reported prompt is zero', () => {
    assert.deepEqual(rootShares([{ inputTokens: 0, outputTokens: 12, cacheReadTokens: 0 }]), { cacheHitShare: null, cacheUnreportedShare: null })
  })

  it('never reads an absent cache count as a miss', () => {
    // The provider did not report cache counts, so the input may include cached
    // tokens: the share is not measured, and the unreported share says how much.
    assert.deepEqual(rootShares([{ inputTokens: 500, outputTokens: 20 }]), { cacheHitShare: null, cacheUnreportedShare: 1 })
  })

  it('keeps a reported zero as a measured miss', () => {
    assert.deepEqual(rootShares([{ inputTokens: 500, outputTokens: 20, cacheReadTokens: 0 }]), { cacheHitShare: 0, cacheUnreportedShare: 0 })
  })

  it('excludes unreported records from the denominator and reports their share', () => {
    assert.deepEqual(rootShares([
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 100 },
      { inputTokens: 300, outputTokens: 10 },
    ]), { cacheHitShare: 0.5, cacheUnreportedShare: 300 / 500 })
  })

  it('counts a write on a record without a reported read as unreported prompt', () => {
    assert.deepEqual(rootShares([
      { inputTokens: 100, outputTokens: 1, cacheWriteTokens: 100 },
      { inputTokens: 100, outputTokens: 1, cacheReadTokens: 100 },
    ]), { cacheHitShare: 0.5, cacheUnreportedShare: 0.5 })
  })

  it('agrees with the closure accounting on a single-session log', () => {
    const usages = [
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 100 },
      { inputTokens: 250, outputTokens: 10, cacheWriteTokens: 50 },
      { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0 },
    ]
    const accounting = priceAccounting([foldSessionAccounting(usageLog(usages))], UNPRICED)
    assert.deepEqual(rootShares(usages), { cacheHitShare: accounting.cacheHitShare, cacheUnreportedShare: accounting.unreportedShare })
  })
})

describe('metrics.foldSessionLog: routing', () => {
  it('counts provider/model transitions across request headers', () => {
    const metrics = foldSessionLog(log([
      headerEvent('deepseek', 'deepseek-chat', 1),
      headerEvent('deepseek', 'deepseek-chat', 2),
      headerEvent('ollama-cloud', 'deepseek-v4-flash', 3),
      headerEvent('deepseek', 'deepseek-chat', 4),
    ]))
    assert.equal(metrics.modelTransitions, 2)
  })

  it('is null when the log carries no header', () => {
    const metrics = foldSessionLog(log([usageEvent({ inputTokens: 10, outputTokens: 1 }, 1)]))
    assert.equal(metrics.modelTransitions, null)
  })

  it('runs consecutive downgrades into streak lengths', () => {
    const outcomes = ['downgraded', 'kept-strong', 'kept-strong', 'downgraded', 'downgraded', 'downgraded', 'kept-strong', 'downgraded', 'downgraded']
    const metrics = foldSessionLog(log(outcomes.map((outcome, index) => decisionEvent(outcome, index + 1))))
    assert.deepEqual(metrics.downgradedStreaks, [1, 3, 2])
    assert.equal(metrics.downgradedShare, 6 / 9)
    assert.equal(metrics.keptStrongShare, 3 / 9)
  })

  it('runs a trailing downgrade to the end of the log', () => {
    const metrics = foldSessionLog(log([
      decisionEvent('kept-strong', 1),
      decisionEvent('downgraded', 2),
      decisionEvent('downgraded', 3),
    ]))
    assert.deepEqual(metrics.downgradedStreaks, [2])
  })

  it('treats skipped decisions as neither downgraded nor kept-strong', () => {
    const metrics = foldSessionLog(log([
      decisionEvent('skipped', 1, { reason: 'mode-off' }),
      decisionEvent('error', 2, { reason: 'judgment-error' }),
      decisionEvent('downgraded', 3),
    ]))
    assert.deepEqual(metrics.downgradedStreaks, [1])
    assert.equal(metrics.downgradedShare, 1 / 3)
    assert.equal(metrics.keptStrongShare, 0)
  })

  it('counts the advisory routing hint the router logs', () => {
    const metrics = foldSessionLog(log([
      decisionEvent('kept-strong', 1, { hint: 'consider-stronger' }),
      decisionEvent('kept-strong', 2),
      decisionEvent('kept-strong', 3, { hint: 'consider-stronger' }),
    ]))
    assert.equal(metrics.routingHintCount, 2)
  })

  it('keeps an empty streak list for a judged trial that never downgraded', () => {
    const metrics = foldSessionLog(log([decisionEvent('kept-strong', 1)]))
    assert.deepEqual(metrics.downgradedStreaks, [])
    assert.equal(metrics.downgradedShare, 0)
    assert.equal(metrics.routingHintCount, 0)
  })

  it('keeps every routing metric null, not zero, when no decision was logged', () => {
    const metrics = foldSessionLog(log([headerEvent('deepseek', 'deepseek-chat', 1), usageEvent({ inputTokens: 10, outputTokens: 1 }, 2)]))
    assertNull(metrics, ['downgradedStreaks', 'downgradedShare', 'keptStrongShare', 'routingHintCount'])
    assert.equal(metrics.modelTransitions, 0)
  })
})

describe('metrics.foldSessionLog: compaction-jev', () => {
  it('counts below-threshold acceptances and degraded selections', () => {
    const metrics = foldSessionLog(log([
      verificationEvent('accepted', 1),
      verificationEvent('accepted-below-threshold', 2),
      verificationEvent('escalated', 3),
      verificationEvent('accepted-below-threshold', 4),
      verificationEvent('accepted', 5, { degraded: true, reason: 'engine-absent' }),
      selectionEvent(false, 6),
      selectionEvent(true, 7),
      selectionEvent(true, 8),
    ]))
    assert.equal(metrics.jevCompactionAcceptedBelowThreshold, 2)
    assert.equal(metrics.jevSelectionDegraded, 2)
  })

  it('counts a degraded verification as an event, not as a below-threshold acceptance', () => {
    const metrics = foldSessionLog(log([verificationEvent('accepted', 1, { degraded: true, reason: 'engine-unavailable' })]))
    assert.equal(metrics.jevCompactionAcceptedBelowThreshold, 0)
  })

  it('keeps both null, not zero, for a non-JEV compaction backend', () => {
    const metrics = foldSessionLog(log([
      event('compaction/start', { compactionId: 'c-1', turn: 1 }, 1),
      event('compaction/end', { compactionId: 'c-1', turn: 1 }, 2),
    ]))
    assert.equal(metrics.compactionCount, 1)
    assert.equal(metrics.pressureFired, true)
    assertNull(metrics, ['jevCompactionAcceptedBelowThreshold', 'jevSelectionDegraded'])
  })
})

describe('metrics.foldSessionLog: a log with no routing or compaction events', () => {
  it('nulls every event-derived Jev field and leaves the existing fold untouched', () => {
    const metrics = foldSessionLog(log([
      event('step/start', { turn: 0, step: 0 }, 1000),
      usageEvent({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 100 }, 2000),
      event('tool/call', { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' }, 2100),
      event('step/end', { turn: 0, step: 0 }, 3000),
    ]))
    assertNull(metrics, JEV_EVENT_FIELDS)
    assert.equal(metrics.cacheHitShare, 0.5)
    assert.equal(metrics.cacheUnreportedShare, 0)
    assert.equal(metrics.inputTokens, 100)
    assert.equal(metrics.turns, 1)
    assert.equal(metrics.toolCalls, 1)
    assert.equal(metrics.compactionCount, 0)
    assert.equal(metrics.pressureFired, false)
  })
})

/**
 * A complete schema-valid metrics record: the runner's own empty record plus
 * per-test overrides. Deriving from `emptyMetrics()` keeps the fixture from
 * drifting from `TrialMetrics` — a hand-listed field set silently stops
 * satisfying the schema the moment another metric is added, which would make
 * every assertion in this file fail for an unrelated reason.
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../schema/trial.js').TrialMetrics}
 */
function metricsRecord(overrides = {}) {
  return { ...emptyMetrics(), ...overrides }
}

/**
 * A complete schema-valid trial record.
 * @param {{ arm?: string, taskId?: string, trialIndex?: number, status?: string,
 *   metrics?: Record<string, unknown> }} [overrides]
 * @returns {import('../schema/trial.js').Trial}
 */
function trialRecord(overrides = {}) {
  const { metrics, ...rest } = overrides
  return {
    taskId: 'jev-task',
    trialIndex: 0,
    arm: 'route-on',
    status: 'success',
    resolved: true,
    failureMode: null,
    verifier: { command: 'node verify.mjs', exitCode: 0 },
    metrics: metricsRecord(metrics ?? {}),
    sessionFile: null,
    startedAt: '2026-09-17T00:00:00.000Z',
    endedAt: '2026-09-17T00:01:00.000Z',
    ...rest,
  }
}

describe('schema: Jev metric fields', () => {
  it('accepts an all-null record and an empty streak list', () => {
    validateTrial(trialRecord())
    validateTrial(trialRecord({ metrics: { downgradedStreaks: [] } }))
    validateTrial(trialRecord({ metrics: { cacheHitShare: 0, cacheUnreportedShare: 0, downgradedStreaks: [3, 1] } }))
  })

  it('keeps the runner empty record schema-valid and explicitly null, not absent', () => {
    // The runner's own empty record is the base of every hand-built fixture in
    // the suite, so a required metric missing from it fails every fixture for an
    // unrelated reason. Pinning the agreement here names the real cause.
    validateTrial(trialRecord())
    const empty = emptyMetrics()
    assert.deepEqual(Object.entries(empty).filter(([, value]) => value === undefined), [])
    for (const field of JEV_FIELDS) {
      assert.equal(empty[field], null, `emptyMetrics().${field} must be an explicit null`)
    }
  })

  it('rejects a missing Jev field so a missing datum is recorded as null', () => {
    for (const field of JEV_FIELDS) {
      const broken = trialRecord()
      delete (/** @type {Record<string, unknown>} */ (broken.metrics))[field]
      assert.throws(
        () => validateTrial(broken),
        error => /** @type {Error} */ (error).message.includes(`trial.metrics.${field} must be`),
      )
    }
  })

  it('rejects a wrong-typed share, transition count, or hint count', () => {
    assert.throws(() => validateTrial(trialRecord({ metrics: { cacheHitShare: '0.5' } })), /cacheHitShare must be a finite number or null/)
    assert.throws(() => validateTrial(trialRecord({ metrics: { cacheUnreportedShare: '1' } })), /cacheUnreportedShare must be a finite number or null/)
    assert.throws(() => validateTrial(trialRecord({ metrics: { modelTransitions: Number.POSITIVE_INFINITY } })), /modelTransitions must be a finite number or null/)
    assert.throws(() => validateTrial(trialRecord({ metrics: { routingHintCount: '2' } })), /routingHintCount must be a finite number or null/)
  })

  it('rejects a streak list that is not positive run lengths', () => {
    assert.throws(() => validateTrial(trialRecord({ metrics: { downgradedStreaks: [0] } })), /downgradedStreaks must be an array of positive integers or null/)
    assert.throws(() => validateTrial(trialRecord({ metrics: { downgradedStreaks: [1.5] } })), /downgradedStreaks must be an array of positive integers or null/)
    assert.throws(() => validateTrial(trialRecord({ metrics: { downgradedStreaks: [1, -2] } })), /downgradedStreaks must be an array of positive integers or null/)
    assert.throws(() => validateTrial(trialRecord({ metrics: { downgradedStreaks: { 1: 2 } } })), /downgradedStreaks must be an array of positive integers or null/)
  })
})

describe('aggregate: Jev fields over trials', () => {
  const measured = trialRecord({
    trialIndex: 0,
    metrics: {
      cacheHitShare: 0.5,
      cacheUnreportedShare: 0.2,
      modelTransitions: 2,
      downgradedStreaks: [2, 1],
      downgradedShare: 0.75,
      keptStrongShare: 0.25,
      routingHintCount: 1,
      jevCompactionAcceptedBelowThreshold: 3,
      jevSelectionDegraded: 2,
    },
  })
  // A judged trial that never downgraded: measured zeros, not nulls.
  const judged = trialRecord({
    trialIndex: 1,
    // Usage with no reported cache-read count: no share, and all of its input unreported.
    metrics: { cacheHitShare: null, cacheUnreportedShare: 1, modelTransitions: 1, downgradedStreaks: [], downgradedShare: 0, keptStrongShare: 1, routingHintCount: 0 },
  })
  // The route-off arm composes no router: every routing datum is absent.
  const absent = trialRecord({ trialIndex: 2, arm: 'route-off' })

  it('means the measured values and counts the nulls the screens depend on', () => {
    const summary = summarizeArm('route-on', [measured, judged, absent])
    assert.equal(summary.meanCacheHitShare, 0.5)
    assert.equal(summary.cacheHitShareNullTrials, 2)
    // The unreported input stays visible beside the share instead of reading as a miss.
    assert.equal(summary.meanCacheUnreportedShare, 0.6)
    assert.equal(summary.meanModelTransitions, 1.5)
    assert.equal(summary.routingDecisionTrials, 2)
    assert.equal(summary.meanDowngradedShare, 0.375)
    assert.equal(summary.meanKeptStrongShare, 0.625)
    assert.equal(summary.meanDowngradedStreakLongest, 1)
    assert.equal(summary.totalDowngradedRuns, 2)
    assert.equal(summary.totalRoutingHintCount, 1)
    assert.equal(summary.compactionVerificationTrials, 1)
    assert.equal(summary.totalJevCompactionAcceptedBelowThreshold, 3)
    assert.equal(summary.totalJevSelectionDegraded, 2)
  })

  it('reports a cell with the same fields as the arm summary', () => {
    const cell = summarizeCell('jev-task', 'route-on', [measured, judged, absent])
    assert.equal(cell.meanCacheHitShare, 0.5)
    assert.equal(cell.cacheHitShareNullTrials, 2)
    assert.equal(cell.routingDecisionTrials, 2)
    assert.equal(cell.meanDowngradedStreakLongest, 1)
    assert.equal(cell.compactionVerificationTrials, 1)
    assert.equal(cell.totalJevCompactionAcceptedBelowThreshold, 3)
  })

  it('excludes infrastructure-error trials from every Jev aggregate', () => {
    const errored = trialRecord({ trialIndex: 3, status: 'error', resolved: false, failureMode: 'PROVIDER_ERROR', metrics: { cacheHitShare: 1, downgradedShare: 1 } })
    const summary = summarizeArm('route-on', [measured, errored])
    assert.equal(summary.trials, 1)
    assert.equal(summary.meanCacheHitShare, 0.5)
    assert.equal(summary.meanDowngradedShare, 0.75)
  })

  it('keeps every mean and total null for an arm that never composed the surfaces', () => {
    const summary = summarizeArm('route-off', [absent, trialRecord({ trialIndex: 1, arm: 'route-off' })])
    assertNull(summary, ['meanCacheHitShare', 'meanCacheUnreportedShare', 'meanModelTransitions', 'meanDowngradedShare', 'meanKeptStrongShare', 'meanDowngradedStreakLongest', 'totalRoutingHintCount', 'totalJevCompactionAcceptedBelowThreshold', 'totalJevSelectionDegraded'])
    assert.equal(summary.cacheHitShareNullTrials, 2)
    assert.equal(summary.routingDecisionTrials, 0)
    assert.equal(summary.compactionVerificationTrials, 0)
    assert.equal(summary.totalDowngradedRuns, 0)
  })
})

/**
 * Write one arm directory: run.json plus trials.jsonl.
 * @param {string} experimentDir - experiment root.
 * @param {string} arm - arm name.
 * @param {import('../schema/trial.js').Trial[]} trials - trials to append.
 * @returns {Promise<string>} the arm directory.
 */
async function writeArm(experimentDir, arm, trials) {
  const dir = join(experimentDir, arm)
  await mkdir(dir, { recursive: true })
  const experiment = experimentDir.split(/[/\\]/).pop()
  const manifest = {
    version: 1,
    experiment,
    arm,
    armConfig: {},
    model: 'deepseek-chat',
    baseUrl: null,
    temperature: 0,
    repeats: 1,
    taskIds: ['jev-task'],
    gitCommit: 'deadbeef',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    tierPatches: [],
    maxTotalTokens: null,
    startedAt: '2026-09-17T00:00:00.000Z',
    endedAt: '2026-09-17T01:00:00.000Z',
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify(manifest) + '\n')
  await writeFile(join(dir, 'trials.jsonl'), trials.map(t => JSON.stringify(t)).join('\n') + '\n')
  return dir
}

describe('report: Jev aggregates reach the per-arm payload', () => {
  it('carries the routing and compaction aggregates for every arm of the Jev ladder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-jev-report-'))
    try {
      const dir = join(root, 'jev-pair')
      await writeArm(dir, 'route-off', [
        trialRecord({ arm: 'route-off', metrics: { inputTokens: 4000, cacheHitShare: 0.4, cacheUnreportedShare: 0 } }),
      ])
      await writeArm(dir, 'route-on', [
        trialRecord({
          metrics: {
            inputTokens: 3000,
            cacheHitShare: 0.3,
            cacheUnreportedShare: 0.25,
            modelTransitions: 3,
            downgradedStreaks: [4],
            downgradedShare: 0.5,
            keptStrongShare: 0.5,
            routingHintCount: 2,
          },
        }),
      ])
      await writeArm(dir, 'compact-basic', [trialRecord({ arm: 'compact-basic' })])
      await writeArm(dir, 'compact-jev', [
        trialRecord({
          arm: 'compact-jev',
          metrics: { jevCompactionAcceptedBelowThreshold: 1, jevSelectionDegraded: 2 },
        }),
      ])

      const uiDataPath = join(root, 'ui', 'data.js')
      const report = await buildExperiment(dir, { uiDataPath, generatedAt: '2026-09-17T00:00:00.000Z' })
      validateReportData(report)
      // No arm is named `off`, so the ladder sorts alphabetically.
      assert.deepEqual(report.arms.map(a => a.arm), ['compact-basic', 'compact-jev', 'route-off', 'route-on'])

      const routeOn = report.arms.find(a => a.arm === 'route-on')
      assert.equal(routeOn.meanCacheHitShare, 0.3)
      assert.equal(routeOn.cacheHitShareNullTrials, 0)
      assert.equal(routeOn.meanCacheUnreportedShare, 0.25)
      assert.equal(routeOn.routingDecisionTrials, 1)
      assert.equal(routeOn.meanModelTransitions, 3)
      assert.equal(routeOn.meanDowngradedStreakLongest, 4)
      assert.equal(routeOn.totalDowngradedRuns, 1)
      assert.equal(routeOn.totalRoutingHintCount, 2)

      const routeOff = report.arms.find(a => a.arm === 'route-off')
      assert.equal(routeOff.meanCacheHitShare, 0.4)
      assertNull(routeOff, ['meanDowngradedShare', 'totalRoutingHintCount', 'meanModelTransitions'])
      assert.equal(routeOff.routingDecisionTrials, 0)

      const compactJev = report.arms.find(a => a.arm === 'compact-jev')
      assert.equal(compactJev.compactionVerificationTrials, 1)
      assert.equal(compactJev.totalJevCompactionAcceptedBelowThreshold, 1)
      assert.equal(compactJev.totalJevSelectionDegraded, 2)
      assertNull(report.arms.find(a => a.arm === 'compact-basic'), ['totalJevCompactionAcceptedBelowThreshold', 'totalJevSelectionDegraded'])

      // The per-arm results.json on disk carries the same aggregates.
      const results = JSON.parse(await readFile(join(dir, 'route-on', 'results.json'), 'utf8'))
      assert.equal(results.summary.meanCacheHitShare, 0.3)
      assert.equal(results.summary.routingDecisionTrials, 1)
      const uiData = await readFile(uiDataPath, 'utf8')
      assert.ok(uiData.startsWith('globalThis.BENCH_REPORT = '))
      assert.match(uiData, /"routingDecisionTrials":1/)
      assert.match(uiData, /"totalJevSelectionDegraded":2/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
