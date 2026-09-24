/**
 * Priced, cache-inclusive accounting: the presence rule for cache counts,
 * call folding from usage chunks and messages, off-peak windows, unpriced
 * models, the quota/dollar split, routing-judgment folding, per-step TTFT,
 * pooling, snapshot and config loading, and the dollar budget. Fixture
 * snapshots keep every figure independent of the committed prices.
 *
 * @module bench/tests/accounting.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DEFAULT_ACCOUNTING_CONFIG,
  DEFAULT_PRICES_DIR,
  emptyAccounting,
  exactCost,
  foldSessionAccounting,
  isOffPeak,
  loadAccountingConfig,
  loadPriceSnapshot,
  mergeAccounting,
  percentile,
  priceAccounting,
  resolveAccountingContext,
  summarizeAccounting,
  trialSpend,
} from '../runner/accounting.js'
import { createDollarBudget } from '../runner/dollar-budget.js'
import { emptyMetrics } from '../runner/metrics.js'
import { validateTrial } from '../schema/trial.js'
import { summarizeArm } from '../stats/aggregate.js'
import { FIXTURE_CONFIG, FIXTURE_SNAPSHOT, writeFixturePricing } from './helpers/pricing.js'

/** Epoch ms of a UTC wall time on 2030-01-01. */
const utc = (hours, minutes = 0, seconds = 0, ms = 0) => Date.UTC(2030, 0, 1, hours, minutes, seconds, ms)

/** @returns {Promise<import('../runner/accounting.js').AccountingContext>} */
async function fixtureContext() {
  const { dir, pricesDir, configPath } = await writeFixturePricing()
  try {
    return await resolveAccountingContext({ pricesDir, configPath, snapshotId: undefined })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Serialize events as a session log. @param {object[]} events @returns {string} */
const log = events => events.map(event => JSON.stringify(event)).join('\n') + '\n'

let seq = 0
/** One session event with a fresh seq. */
const event = (type, time, data) => ({ type, seq: (seq += 1), time, data })

/**
 * One finalized step: step/start, a usage chunk, and the assistant message repeating it.
 * @param {{ turn?: number, step: number, time: number, provider: string, model: string, usage: object }} spec
 */
function pricedStep({ turn = 1, step, time, provider, model, usage }) {
  return [
    event('step/start', time, { turn, step }),
    event('assistant/chunk', time + 100, { turn, step, chunk: { type: 'usage', usage } }),
    event('assistant/message', time + 100, {
      turn, step, message: { role: 'assistant', source: { kind: 'model', provider, model } }, usage,
    }),
  ]
}

/** A minimal success trial around the given price fields. @param {object} priced */
const trialWith = priced => ({
  taskId: 't', trialIndex: 0, arm: 'off', status: 'success', resolved: true, failureMode: null,
  verifier: { command: 'v', exitCode: 0 }, metrics: emptyMetrics(), sessionFile: null, startedAt: 'a', endedAt: 'b', ...priced,
})

/** Assert two dollar figures agree to floating-point noise. */
const assertDollars = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

describe('accounting.foldSessionAccounting', () => {
  it('counts each usage chunk as a call and lets the message name the route without double counting', () => {
    const facts = foldSessionAccounting(log([
      event('request/context', 10, { provider: 'acme-route', model: 'm1' }),
      event('step/start', 1000, { turn: 1, step: 1 }),
      // A failed attempt that still reported usage, then the retry.
      event('assistant/chunk', 1100, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } }),
      event('step/start', 1200, { turn: 1, step: 1 }),
      event('assistant/chunk', 1300, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 } } }),
      event('assistant/message', 1300, {
        turn: 1, step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'sub-route', model: 'big' } },
        usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
      }),
      // A message-only step (no chunks logged) is one call on the current route.
      event('step/start', 2000, { turn: 1, step: 2 }),
      event('assistant/message', 2100, { turn: 1, step: 2, message: { role: 'assistant' }, usage: { inputTokens: 11, outputTokens: 4 } }),
    ]))
    assert.deepEqual(facts.calls, [
      { provider: 'acme-route', model: 'm1', time: 1000, usage: { inputTokens: 5, outputTokens: 1 } },
      { provider: 'sub-route', model: 'big', time: 1200, usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 } },
      { provider: 'acme-route', model: 'm1', time: 2000, usage: { inputTokens: 11, outputTokens: 4 } },
    ])
  })

  it('keeps a reported zero and reads an absent or invalid cache count as unreported', () => {
    const facts = foldSessionAccounting(log([
      event('assistant/message', 1, { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
      event('assistant/message', 2, { turn: 1, step: 2, usage: { inputTokens: 1, outputTokens: 1 } }),
      event('assistant/message', 3, { turn: 1, step: 3, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: -1 } }),
      event('assistant/message', 4, { turn: 1, step: 4, usage: { inputTokens: 'x', outputTokens: 1 } }),
    ]))
    assert.deepEqual(facts.calls.map(call => call.usage), [
      { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 1, outputTokens: 1 },
      { inputTokens: 1, outputTokens: 1 },
    ])
  })

  it('samples TTFT per step from the first token-bearing chunk, including packed rows', () => {
    const facts = foldSessionAccounting(log([
      event('step/start', 1000, { turn: 1, step: 1 }),
      event('assistant/chunk', 1100, { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      event('assistant/chunk', 1150, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } }),
      event('assistant/chunk', 1400, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } }),
      event('assistant/chunk', 1500, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'more' } }),
      event('step/start', 2000, { turn: 1, step: 2 }),
      { type: 'reasoning-chunks', seq0: 90, time0: 2100, data: { turn: 1, step: 2, index: 0, dt: [50, 50], texts: ['', 'x', 'y'] } },
      event('step/start', 3000, { turn: 1, step: 3 }),
      event('assistant/chunk', 3050, { turn: 1, step: 3, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '' } }),
      event('step/start', 4000, { turn: 1, step: 4 }), // no token: no sample
    ]))
    assert.deepEqual(facts.ttftMs, [400, 150, 50])
  })

  it('folds every routing judgment kind with its awaited default', () => {
    const facts = foldSessionAccounting(log([
      event('model-routing/decision', 10, { outcome: 'kept-strong', engine: 'typesafe', model: 't', latencyMs: 40, eligibilityMs: 3 }),
      event('model-routing/child-decision', 20, { outcome: 'downgraded', engine: 'llm-judge', model: 'j1', latencyMs: 50 }),
      event('model-routing/shadow-decision', 30, { outcome: 'kept-strong', engine: 'llm-judge', model: 'j1', latencyMs: 60 }),
      event('model-routing/shadow-decision', 40, { outcome: 'kept-strong', engine: 'llm-judge', model: 'j1', latencyMs: 70, awaited: true }),
    ]))
    assert.deepEqual(facts.judgments.map(j => [j.kind, j.awaited, j.latencyMs, j.eligibilityMs]), [
      ['decision', true, 40, 3],
      ['child-decision', true, 50, null],
      ['shadow-decision', false, 60, null],
      ['shadow-decision', true, 70, null],
    ])
  })

  it('skips a torn final line and rejects a corrupt interior line', () => {
    const good = JSON.stringify(event('assistant/message', 1, { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } }))
    assert.equal(foldSessionAccounting(good + '\n{"type":"assistant/mes').calls.length, 1)
    assert.throws(() => foldSessionAccounting('not json\n' + good + '\n'), /line 1 is not valid JSON/)
  })
})

describe('accounting.priceAccounting', () => {
  it('prices a reported zero as a measured miss and leaves an absent count to the upper bound', async () => {
    const context = await fixtureContext()
    const reportedMiss = priceAccounting([foldSessionAccounting(log(pricedStep({
      step: 1, time: utc(9), provider: 'acme-route', model: 'm1',
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
    })))], context)
    assert.equal(reportedMiss.unreportedCalls, 0)
    assert.equal(reportedMiss.cacheHitShare, 0)
    assert.equal(reportedMiss.unreportedShare, 0)
    assertDollars(reportedMiss.dollars, (1000 * 2 + 100 * 10) / 1e6)
    assertDollars(reportedMiss.dollarsUpperBound, reportedMiss.dollars)
    assertDollars(/** @type {number} */ (exactCost(reportedMiss)), reportedMiss.dollars)

    const unreported = priceAccounting([foldSessionAccounting(log(pricedStep({
      step: 1, time: utc(9), provider: 'acme-route', model: 'm1',
      usage: { inputTokens: 1000, outputTokens: 100 },
    })))], context)
    assert.equal(unreported.unreportedCalls, 1)
    assert.equal(unreported.cacheHitShare, null)
    assert.equal(unreported.unreportedShare, 1)
    assert.deepEqual(unreported.tokens, { uncachedInput: 0, unreportedInput: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })
    assert.equal(unreported.dollars, 0)
    // The upper bound prices the whole input, cached or not, at the uncached rate.
    assertDollars(unreported.dollarsUpperBound, (1000 * 2 + 100 * 10) / 1e6)
    assert.equal(exactCost(unreported), null)
  })

  it('computes the cache-hit share over reported calls only and reports the unreported share', async () => {
    const context = await fixtureContext()
    const accounting = priceAccounting([foldSessionAccounting(log([
      ...pricedStep({ step: 1, time: utc(9), provider: 'acme-route', model: 'm1', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 300, cacheWriteTokens: 100 } }),
      ...pricedStep({ step: 2, time: utc(9), provider: 'acme-route', model: 'm1', usage: { inputTokens: 500, outputTokens: 1 } }),
    ]))], context)
    assert.equal(accounting.cacheHitShare, 300 / 500)
    assert.equal(accounting.unreportedShare, 500 / 1000)
    assertDollars(accounting.dollars, (100 * 2 + 1 * 10 + 300 * 0.2 + 100 * 2.5) / 1e6)
    assertDollars(accounting.dollarsUpperBound, accounting.dollars + (500 * 2 + 1 * 10) / 1e6)
  })

  it('switches to off-peak rates exactly at a window boundary, by request timestamp in UTC', async () => {
    const context = await fixtureContext()
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 }
    const price = time => priceAccounting([foldSessionAccounting(log(pricedStep({ step: 1, time, provider: 'acme-route', model: 'm1', usage })))], context)
    const peak = (1000 * 2 + 100 * 10 + 500 * 0.2 + 200 * 2.5) / 1e6
    // Off-peak publishes no write rate, so writes bill at the off-peak input rate.
    const offPeak = (1000 * 1 + 100 * 5 + 500 * 0.1 + 200 * 1) / 1e6
    assertDollars(price(utc(9, 59, 59, 999)).dollars, peak)
    assertDollars(price(utc(10)).dollars, offPeak)
    assert.equal(price(utc(10)).offPeakCalls, 1)
    assert.equal(price(utc(9, 59, 59, 999)).offPeakCalls, 0)
    assertDollars(price(utc(0, 59, 59, 999)).dollars, offPeak)
    assertDollars(price(utc(1)).dollars, peak)
    assertDollars(price(utc(23, 59, 59, 999)).dollars, offPeak)
  })

  it('reads a window that spans midnight', () => {
    const entry = /** @type {any} */ (FIXTURE_SNAPSHOT.models[1])
    assert.equal(isOffPeak(entry, utc(21, 59)), false)
    assert.equal(isOffPeak(entry, utc(22)), true)
    assert.equal(isOffPeak(entry, utc(1, 59)), true)
    assert.equal(isOffPeak(entry, utc(2)), false)
    assert.equal(isOffPeak(entry, null), false)
  })

  it('reports an unverified model and an unmapped route as unpriced, never as $0', async () => {
    const context = await fixtureContext()
    const accounting = priceAccounting([foldSessionAccounting(log([
      ...pricedStep({ step: 1, time: utc(9), provider: 'acme-route', model: 'unverified', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }),
      ...pricedStep({ step: 2, time: utc(9), provider: 'mystery-route', model: 'm1', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }),
      event('step/start', utc(9), { turn: 1, step: 3 }),
      event('assistant/message', utc(9), { turn: 1, step: 3, message: { role: 'assistant' }, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]))], context)
    assert.equal(accounting.calls, 3)
    assert.equal(accounting.unpricedCalls, 3)
    assert.deepEqual(accounting.unpricedModels, ['(unknown)/(unknown)', 'acme-route/unverified', 'mystery-route/m1'])
    assert.equal(accounting.dollars, 0)
    assert.equal(accounting.dollarsUpperBound, 0)
    assert.equal(exactCost(accounting), null)
    assert.deepEqual(accounting.tokens, { uncachedInput: 200, unreportedInput: 1, output: 21, cacheRead: 0, cacheWrite: 0 })
  })

  it('counts subscription calls as input-equivalent quota tokens, apart from dollars', async () => {
    const context = await fixtureContext()
    const accounting = priceAccounting([foldSessionAccounting(log([
      ...pricedStep({ step: 1, time: utc(9), provider: 'sub-route', model: 'big', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000 } }),
      ...pricedStep({ step: 2, time: utc(9), provider: 'sub-route', model: 'not-in-snapshot', usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 7 } }),
      ...pricedStep({ step: 3, time: utc(9), provider: 'acme-route', model: 'm1', usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 } }),
    ]))], context)
    assert.equal(accounting.quotaCalls, 2)
    // (1000 × 4 + 100 × 20 + 1000 × 0.4) / 4: tokens weighted by price relative to input.
    assert.ok(Math.abs(accounting.quotaTokens - 1600) < 1e-9)
    assert.equal(accounting.quotaUnpricedTokens, 30 + 5 + 7)
    assert.equal(accounting.unpricedCalls, 0)
    assertDollars(accounting.dollars, 1000 * 2 / 1e6)
    // Quota calls still count as raw tokens and in the cache-hit share.
    assert.equal(accounting.tokens.cacheRead, 1007)
  })

  it('folds judgment calls: counts, latency, critical path, vendor plans, and priced LLM judges', async () => {
    const context = await fixtureContext()
    const accounting = priceAccounting([foldSessionAccounting(log([
      event('model-routing/decision', utc(9), { engine: 'llm-judge', model: 'j1', latencyMs: 120, eligibilityMs: 5, usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 } }),
      event('model-routing/child-decision', utc(9), { engine: 'typesafe', model: 'ts-1', latencyMs: 40 }),
      event('model-routing/shadow-decision', utc(9), { engine: 'llm-judge', model: 'j1', latencyMs: 300, usage: { inputTokens: 500, outputTokens: 5 } }),
      event('model-routing/decision', utc(9), { engine: 'mystery', model: 'x', latencyMs: 10, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }),
      // No judgment call made: not a judge call, but its eligibility time is awaited.
      event('model-routing/decision', utc(9), { outcome: 'skipped', reason: 'mode-off', eligibilityMs: 2 }),
    ]))], context)
    const { judge } = accounting
    assert.equal(judge.calls, 4)
    assert.deepEqual(judge.callsByKind, { 'decision': 2, 'child-decision': 1, 'shadow-decision': 1 })
    assert.deepEqual(judge.byEngine, { 'llm-judge/j1': 2, 'typesafe/ts-1': 1, 'mystery/x': 1 })
    assert.equal(judge.latencyMs, 470)
    assert.deepEqual(judge.latencySamplesMs, [120, 40, 300, 10])
    assert.equal(judge.criticalPathMs, 120 + 5 + 40 + 10 + 2)
    assert.equal(judge.vendorPlanCalls, 1)
    assert.equal(judge.pricedCalls, 2)
    assert.equal(judge.unpricedCalls, 1)
    assertDollars(judge.dollars, (1000 * 1 + 10 * 2) / 1e6)
    assertDollars(judge.dollarsUpperBound, judge.dollars + (500 * 1 + 5 * 2) / 1e6)
    assertDollars(trialSpend(accounting), judge.dollarsUpperBound)
    assert.equal(exactCost(accounting), null)
  })
})

describe('accounting pooling', () => {
  it('merges phases and pools an arm with percentiles over every step and judgment call', async () => {
    const context = await fixtureContext()
    const phase = ttft => priceAccounting([foldSessionAccounting(log([
      ...pricedStep({ step: 1, time: utc(9), provider: 'acme-route', model: 'm1', usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 100 } }),
      event('assistant/chunk', utc(9) + ttft, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }),
      event('model-routing/decision', utc(9), { engine: 'typesafe', model: 't', latencyMs: ttft }),
    ]))], context)
    const merged = mergeAccounting(phase(100), phase(300))
    assert.equal(merged.calls, 2)
    assert.equal(merged.cacheHitShare, 0.5)
    assert.deepEqual(merged.ttftSamplesMs, [100, 300])
    assert.deepEqual(merged.judge.byEngine, { 'typesafe/t': 2 })
    validateTrial(trialWith({ priceSnapshot: '2030-01-01', accounting: merged }))

    const summary = summarizeAccounting([
      { priceSnapshot: '2030-01-01', accounting: phase(100) },
      { priceSnapshot: '2030-01-01', accounting: merged },
      {},
    ])
    assert.ok(summary !== null)
    assert.equal(summary.trials, 2)
    assert.deepEqual(summary.priceSnapshots, ['2030-01-01'])
    assert.equal(summary.totals.calls, 3)
    assert.equal(summary.ttftSteps, 3)
    assert.equal(summary.ttftP50Ms, 100)
    assert.equal(summary.ttftP90Ms, 300)
    assert.equal(summary.judge.latencyP50Ms, 100)
    assert.equal(summary.judge.latencyP90Ms, 300)
    assert.ok(!('ttftSamplesMs' in summary.totals))
    assert.equal(summarizeAccounting([{}]), null)

    // Arm summaries pool success trials only; an arm recorded before pricing reports null.
    const priced = trialWith({ priceSnapshot: '2030-01-01', accounting: merged })
    const errored = { ...priced, status: 'error', resolved: false, failureMode: 'HARNESS_ERROR' }
    assert.equal(summarizeArm('off', [priced, errored]).accounting?.totals.calls, 2)
    assert.equal(summarizeArm('off', [trialWith({})]).accounting, null)
  })

  it('takes nearest-rank percentiles', () => {
    assert.equal(percentile([], 0.5), null)
    assert.equal(percentile([5], 0.9), 5)
    assert.equal(percentile([40, 10, 30, 20], 0.5), 20)
    assert.equal(percentile([40, 10, 30, 20], 0.9), 40)
  })

  it('rejects a trial that records accounting without its snapshot, or a malformed record', () => {
    assert.throws(() => validateTrial(trialWith({ accounting: emptyAccounting() })), /recorded together/)
    assert.throws(
      () => validateTrial(trialWith({ priceSnapshot: '2030-01-01', accounting: { ...emptyAccounting(), cacheHitShare: 2 } })),
      /cacheHitShare must be in \[0, 1\]/,
    )
  })
})

describe('accounting inputs', () => {
  it('resolves the newest committed snapshot and the committed config', async () => {
    const context = await resolveAccountingContext({ pricesDir: DEFAULT_PRICES_DIR, configPath: DEFAULT_ACCOUNTING_CONFIG, snapshotId: undefined })
    assert.match(context.snapshot.id, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(context.snapshot.entries.size > 0)
    assert.match(context.configSha256, /^[0-9a-f]{64}$/)
    // Every configured price provider names a provider the snapshot prices.
    const providers = new Set([...context.snapshot.entries.values()].map(entry => entry.provider))
    for (const provider of Object.values(context.config.priceProviders)) assert.ok(providers.has(provider), provider)
  })

  it('fails loud on a malformed snapshot or config', async () => {
    const { dir, pricesDir } = await writeFixturePricing()
    try {
      await assert.rejects(() => loadPriceSnapshot(pricesDir, '2031-01-01'), /not found/)
      await assert.rejects(() => loadPriceSnapshot(pricesDir, 'latest'), /YYYY-MM-DD/)
      await writeFile(join(dir, '2030-01-02.json'), JSON.stringify({ ...FIXTURE_SNAPSHOT }))
      await assert.rejects(() => loadPriceSnapshot(pricesDir, '2030-01-02'), /snapshotDate is 2030-01-01/)
      const badWindow = { ...FIXTURE_SNAPSHOT, snapshotDate: '2030-01-03', models: [{ ...FIXTURE_SNAPSHOT.models[0], offPeakWindowsUtc: ['10:00-10:00'] }] }
      await writeFile(join(dir, '2030-01-03.json'), JSON.stringify(badWindow))
      await assert.rejects(() => loadPriceSnapshot(pricesDir, '2030-01-03'), /non-empty span/)
      const negative = { ...FIXTURE_SNAPSHOT, snapshotDate: '2030-01-04', models: [{ ...FIXTURE_SNAPSHOT.models[0], input: -1 }] }
      await writeFile(join(dir, '2030-01-04.json'), JSON.stringify(negative))
      await assert.rejects(() => loadPriceSnapshot(pricesDir, '2030-01-04'), /input must be a non-negative number or null/)

      await writeFile(join(dir, 'typo.json'), JSON.stringify({ ...FIXTURE_CONFIG, subscriptionProvider: [] }))
      await assert.rejects(() => loadAccountingConfig(join(dir, 'typo.json')), /unknown key "subscriptionProvider"/)
      await writeFile(join(dir, 'missing.json'), JSON.stringify({ ...FIXTURE_CONFIG, vendorPlanJudgeEngines: undefined }))
      await assert.rejects(() => loadAccountingConfig(join(dir, 'missing.json')), /vendorPlanJudgeEngines must be an array/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('dollar-budget.createDollarBudget', () => {
  it('refuses the launch that would exceed the cap, projecting in-flight trials at the largest settled spend', () => {
    const budget = createDollarBudget(1)
    const spend = dollars => ({ ...emptyAccounting(), dollarsUpperBound: dollars })
    assert.equal(budget.admits(3), true) // nothing settled: nothing to project
    budget.settle(spend(0.4))
    assert.equal(budget.admits(0), true) // 0.4 + 1 × 0.4
    assert.equal(budget.admits(1), false) // 0.4 + 2 × 0.4 > 1
    assert.deepEqual(budget.stop(), {
      reason: 'max-dollars', maxDollars: 1, spentDollars: 0.4, projectedTrialDollars: 0.4, inFlight: 1, notLaunched: 0, unpricedCalls: 0,
    })
    assert.equal(budget.admits(0), false) // a stop is final
  })

  it('stops once settled spend reaches the cap and counts calls it could not price', () => {
    const budget = createDollarBudget(0.5)
    budget.settle({ ...emptyAccounting(), dollarsUpperBound: 0.5, unpricedCalls: 2 })
    assert.equal(budget.unpricedCalls(), 2)
    assert.equal(budget.admits(0), false)
    assert.equal(budget.stop()?.spentDollars, 0.5)
  })
})
