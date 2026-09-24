/**
 * Bench accounting fed by REAL router output: the built model-router, the
 * built judgment dispatcher, and a registered judge write routing decisions
 * into a real session, and `bench/runner/accounting.js` folds and prices that
 * log. This pins the producer and the reader together, so a decision field the
 * router renames or stops writing fails here, not in a trial report.
 *
 * TEST DOUBLES: the judge engine answers from a script (usage and latency it
 * reports, or a classified failure), and the llm adapter only describes the
 * two routes' capabilities; no request leaves the process.
 *
 * Requires the built `lib/` (`pnpm run build:lib`), like every bench test that
 * loads workspace packages.
 */

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Context } from '../../vendor/cordis/lib/index.js'
import AgentRegistry from '../../packages/core/agent/lib/index.js'
import SessionStore from '../../packages/core/session/lib/index.js'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createUserMessage } from '../../packages/llm/llm/lib/index.js'
import { JudgmentError, judgmentEngineId, registerJudgmentEngine } from '../../packages/llm/judgment/lib/index.js'
import JudgmentDispatch from '../../packages/llm/judgment-dispatch/lib/index.js'
import ModelRoutingController from '../../packages/llm/model-router/lib/index.js'
import { foldSessionAccounting, priceAccounting, resolveAccountingContext } from '../runner/accounting.js'
import { writeFixturePricing } from './helpers/pricing.js'

const STRONG = { provider: 'strong-route', model: 'strong' }
const CHEAP = { provider: 'cheap-route', model: 'cheap' }
/** The registry id the judge registers under; the fixture prices its usage through it. */
const JUDGE = 'llm-judge'

/** TEST DOUBLE: route metadata the router's capability assessment reads. */
class Routes extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'low' }], defaultEffort: ReasoningEffortId('low') },
    })
  }

  async * stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** TEST DOUBLE: a registered judge that answers with usage, or fails when told to. */
class Judge {
  static inject = ['judgmentEngines']

  constructor(ctx) {
    this.failing = false
    registerJudgmentEngine(ctx, {
      engine: this,
      descriptor: { id: judgmentEngineId(JUDGE), label: 'Judge', egress: 'local', calibration: 'calibrated', supportsFitting: false },
      status: () => ({ state: 'ready' }),
    })
  }

  ask(input) {
    if (this.failing) return Promise.reject(new JudgmentError('UNAVAILABLE', 'the judge is restarting'))
    return Promise.resolve({
      answers: input.questions.map(question => question.kind === 'choice'
        ? { kind: 'choice', id: question.id, option: 'cheap', confidence: 0.95, probabilities: { 'keep-current': 0.02, cheap: 0.98 } }
        : { kind: 'score', id: question.id, score: 0, confidence: 1, probabilities: { 0: 1 } }),
      engine: JUDGE,
      model: 'j1',
      latencyMs: 30,
      usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 },
    })
  }
}

describe('bench accounting of real router decisions', () => {
  it('folds answered and failed judgment calls, their critical path, and the judge usage', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter([STRONG.provider, CHEAP.provider], new Routes())
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JudgmentDispatch, { defaultEngine: JUDGE })
    let judge
    await ctx.plugin({ name: 'judge', inject: ['judgmentEngines'], apply: (inner) => { judge = new Judge(inner) } })
    await ctx.plugin(ModelRoutingController, {
      initialMode: 'on',
      candidates: [{ id: 'cheap', provider: CHEAP.provider, model: CHEAP.model, description: 'a small change' }],
      routeFrom: [{ provider: STRONG.provider, model: STRONG.model, objective: 'dollars' }],
      downgradeThreshold: 0.8,
      downgradeMargin: 0.1,
      hold: { minSteps: 0 },
      routeInstructions: 'Pick the cheapest route that can finish this turn.',
      difficultyInstructions: 'Rate how hard this turn is.',
    })
    try {
      const session = ctx.sessions.create()
      const agent = { id: session.id, session, ctx }
      ctx.agents.register(agent)
      const consult = (turn) => ctx.modelRouting.resolveRequest(agent, turn, 1, STRONG, new AbortController().signal, {
        config: STRONG,
        content: { messages: session.deriveMessages(), system: '', tools: [] },
      })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'rename one helper' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      assert.deepEqual(await consult(1), CHEAP)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 2 })
      judge.failing = true
      // The held streak tolerates one failed call and keeps its candidate.
      assert.deepEqual(await consult(2), CHEAP)
      assert.deepEqual(session.events.filter(event => event.type === 'model-routing/decision').map(event => event.data.reason),
        ['gate-passed', 'judgment-failure-held'])

      const text = session.events.map(event => JSON.stringify(event)).join('\n') + '\n'
      const facts = foldSessionAccounting(text)
      assert.equal(facts.judgments.length, 2)
      const [answered, failed] = facts.judgments
      assert.equal(answered.engine, JUDGE)
      assert.equal(answered.engineId, JUDGE)
      assert.equal(answered.latencyMs, 30)
      assert.ok(answered.eligibilityMs !== null && answered.eligibilityMs >= 0)
      assert.deepEqual(answered.usage, { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 })
      // The failed call carries the router's wall-clock latency and the id it was routed to.
      assert.equal(failed.engine, JUDGE)
      assert.equal(failed.engineId, JUDGE)
      assert.ok(failed.latencyMs !== null && failed.latencyMs >= 0)
      assert.ok(failed.eligibilityMs !== null)
      assert.equal(failed.usage, null)

      const { dir, pricesDir, configPath } = await writeFixturePricing()
      try {
        const context = await resolveAccountingContext({ pricesDir, configPath, snapshotId: undefined })
        const accounting = priceAccounting([facts], context)
        assert.equal(accounting.judge.calls, 2)
        assert.equal(accounting.judge.callsByKind.decision, 2)
        assert.equal(accounting.judge.criticalPathMs,
          answered.latencyMs + answered.eligibilityMs + failed.latencyMs + failed.eligibilityMs)
        assert.equal(accounting.judge.pricedCalls, 1)
        // judgeco j1: 1000 input at $1/M plus 10 output at $2/M, with a reported cache-read count.
        assert.ok(Math.abs(accounting.judge.dollars - (1000 * 1 + 10 * 2) / 1e6) < 1e-12)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
