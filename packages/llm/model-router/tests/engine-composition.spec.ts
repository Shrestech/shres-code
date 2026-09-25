import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import AgentRegistry from '@shres-code/shres-code-agent'
import type { Agent, ModelSelection } from '@shres-code/shres-code-agent'
import {
  JUDGMENT_SETTINGS_NAMESPACE,
  JudgmentError,
  judgmentEngineId,
  registerJudgmentEngine,
} from '@shres-code/shres-code-judgment'
import type {
  JudgmentEngineCalibration,
  JudgmentEngineStatus,
  JudgmentInput,
  JudgmentResult,
} from '@shres-code/shres-code-judgment'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createUserMessage } from '@shres-code/shres-code-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import ModelRoutingController, { routingCalibration } from '../src/index.ts'
import { stickyState } from '../src/folds.ts'
import type { ModelRoutingDecision } from '../src/types.ts'

/**
 * REAL Loader composition of the router with `judgment-dispatch` and
 * registered engines, booted from a test-only `cordis.yml`. It pins, through
 * the shipped dispatcher and registry:
 * - an engine still becoming ready does not open the breaker, and switching
 *   the selected engine lets routing ask again at once;
 * - the router decides on the engine the dispatcher asks, even when the
 *   selection or an engine's status changes while candidates are assessed.
 *
 * TEST DOUBLES: the scripted engines and the llm adapter that only describes
 * route capabilities and can run one action while candidates are assessed; no
 * request leaves the process.
 */

const STRONG: ModelSelection = { provider: 'strong-route', model: 'strong' }
const CHEAP = { provider: 'cheap-route', model: 'cheap' }

/** Route metadata the capability assessment reads; runs one pending action inside it. */
class Routes extends LlmAdapter {
  /** Action run once, inside the next capability read. */
  duringAssessment: (() => Promise<void>) | undefined

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const action = this.duringAssessment
    this.duringAssessment = undefined
    if (action !== undefined) await action()
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'low' }], defaultEffort: ReasoningEffortId('low') },
    }
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One scripted engine the composition registers, with its controls. */
interface ScriptedEngine {
  readonly asks: JudgmentInput[]
  failing: boolean
  setStatus(status: JudgmentEngineStatus): void
}

/** The spec of one scripted engine. */
interface EngineSpec {
  readonly id: string
  readonly status?: JudgmentEngineStatus
  readonly calibration?: JudgmentEngineCalibration
}

/** Build one engine plugin module whose handle the test drives. */
function enginePlugin(spec: EngineSpec): { module: unknown; handle: ScriptedEngine } {
  let current = spec.status ?? { state: 'ready' }
  let announce: () => void = () => undefined
  const handle: ScriptedEngine = {
    asks: [],
    failing: false,
    setStatus: (status) => {
      current = status
      announce()
    },
  }
  const module = {
    name: `test-engine-${spec.id}`,
    inject: ['judgmentEngines'],
    apply: (ctx: Context) => {
      announce = registerJudgmentEngine(ctx, {
        engine: {
          ask: (input: JudgmentInput): Promise<JudgmentResult> => {
            handle.asks.push(input)
            if (handle.failing) return Promise.reject(new JudgmentError('UNAVAILABLE', `${spec.id} refused the ask`))
            return Promise.resolve({
              answers: input.questions.map(question => question.kind === 'choice'
                ? { kind: 'choice', id: question.id, option: 'cheap', confidence: 0.95, probabilities: { 'keep-current': 0.02, cheap: 0.98 } }
                : { kind: 'score', id: question.id, score: 0, confidence: 1, probabilities: { 0: 1 } }),
              engine: spec.id,
              model: `${spec.id}-1`,
              latencyMs: 5,
            } as JudgmentResult)
          },
        },
        descriptor: {
          id: judgmentEngineId(spec.id),
          label: spec.id,
          egress: 'none',
          calibration: spec.calibration ?? 'calibrated',
          supportsFitting: false,
        },
        status: () => current,
      })
    },
  }
  return { module, handle }
}

/** A booted composition and its controls. */
interface Booted {
  readonly ctx: Context
  readonly routes: Routes
  readonly engines: Record<string, ScriptedEngine>
  readonly session: Session
  readonly consult: (turn: number) => Promise<ModelSelection | undefined>
  readonly decisions: () => ModelRoutingDecision[]
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the router, the dispatcher, and the given engines through the Loader.
 * @param engines - the engines to register, in order.
 * @param defaultEngine - the dispatcher's `defaultEngine`.
 * @param routerLines - extra router config lines, indented under `config`.
 * @returns the booted composition.
 */
async function boot(engines: readonly EngineSpec[], defaultEngine: string, routerLines: readonly string[] = []): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'shres-model-router-engines-'))
  const plugins = engines.map(spec => ({ spec, ...enginePlugin(spec) }))
  const routes = new Routes()
  await writeFile(join(root, 'cordis.yml'), [
    "- name: '@shres-code/shres-code-llm'",
    "- name: '@test/routes'",
    "- name: '@shres-code/shres-code-session'",
    "- name: '@shres-code/shres-code-agent'",
    "- name: '@shres-code/shres-code-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(join(root, 'settings.yaml'))}`,
    '    watch: false',
    "- name: '@shres-code/shres-code-judgment-dispatch'",
    '  config:',
    `    defaultEngine: ${defaultEngine}`,
    ...plugins.map(({ spec }) => `- name: '@test/${spec.id}'`),
    "- name: '@shres-code/shres-code-model-router'",
    '  config:',
    '    initialMode: on',
    '    candidates:',
    `      - { id: cheap, provider: ${CHEAP.provider}, model: ${CHEAP.model}, description: a small change }`,
    '    routeFrom:',
    `      - { provider: ${STRONG.provider}, model: ${STRONG.model}, objective: dollars }`,
    '    downgradeThreshold: 0.8',
    '    downgradeMargin: 0.1',
    '    hold: { minSteps: 0 }',
    '    judgmentFailures: { holdTolerance: 0, breakerThreshold: 2, breakerOpenTurns: 5 }',
    '    routeInstructions: Pick the cheapest route that can finish this turn.',
    '    difficultyInstructions: Rate how hard this turn is.',
    ...routerLines,
    '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-llm', LlmRuntime],
    ['@test/routes', { name: 'test-routes', inject: ['llm'], apply: (ctx: Context) => { ctx.effect(() => ctx.llm.registerAdapter([STRONG.provider, CHEAP.provider], routes)) } }],
    ['@shres-code/shres-code-session', SessionStore],
    ['@shres-code/shres-code-agent', AgentRegistry],
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-judgment-dispatch', JudgmentDispatch],
    ...plugins.map(({ spec, module }) => [`@test/${spec.id}`, module] as const),
    ['@shres-code/shres-code-model-router', ModelRoutingController],
  ])
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()

  const session: Session = ctx.sessions.create()
  const agent = { id: session.id, session, ctx } as unknown as Agent
  ctx.agents.register(agent)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'rename one helper' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return {
    ctx,
    routes,
    engines: Object.fromEntries(plugins.map(({ spec, handle }) => [spec.id, handle])),
    session,
    decisions: () => session.events.flatMap(event => event.type === 'model-routing/decision' ? [event.data] : []),
    consult: async (turn) => {
      if (turn > 1) session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn })
      return ctx.modelRouting.resolveRequest(agent, turn, 1, STRONG, new AbortController().signal, {
        config: STRONG,
        content: { messages: session.deriveMessages(), system: '', tools: [] },
      })
    },
  }
}

describe('real Loader composition: router, judgment-dispatch, and registered engines', () => {
  it('ignores engine warm-up for the breaker, and asks again at once after an engine switch', { timeout: 30_000 }, async () => {
    const booted = await boot([{ id: 'laya', status: { state: 'starting', detail: 'loading the model' } }, { id: 'other' }], 'laya')
    const { consult, decisions, engines, session, ctx } = booted
    const laya = engines['laya']!
    const other = engines['other']!

    // Laya is loading: four consults, no call, and no breaker.
    for (const turn of [1, 2, 3, 4]) expect(await consult(turn)).toBeUndefined()
    expect(decisions().map(decision => decision.engineFailure?.engineState)).toEqual(['starting', 'starting', 'starting', 'starting'])
    expect(laya.asks).toHaveLength(0)
    expect(stickyState(session.events)).not.toHaveProperty('judgmentFailures')

    // Ready but refusing: two real failures open the breaker.
    laya.setStatus({ state: 'ready' })
    laya.failing = true
    expect(await consult(5)).toBeUndefined()
    expect(await consult(6)).toBeUndefined()
    expect(await consult(7)).toBeUndefined()
    expect(decisions().slice(4).map(decision => decision.reason)).toEqual(['engine-unavailable', 'engine-unavailable', 'breaker-open'])
    expect(laya.asks).toHaveLength(2)

    // Switching the selected engine asks the new one at once.
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'other' })
    expect(await consult(8)).toEqual(CHEAP)
    expect(decisions().at(-1)).toMatchObject({ reason: 'gate-passed', engineId: 'other', engine: 'other' })
    expect(other.asks).toHaveLength(1)
    expect(other.asks[0]?.consumer).toBe('model-router')
  })

  it('classifies an engine by its declared calibration and operating point', () => {
    const point = { engine: 'x', downgradeThreshold: 0.7, downgradeMargin: 0.1, acceptVerbalized: false }
    expect(routingCalibration('verbalized', undefined)).toEqual({ kind: 'refused' })
    expect(routingCalibration('verbalized', point)).toEqual({ kind: 'refused' })
    expect(routingCalibration('verbalized', { ...point, acceptVerbalized: true })).toEqual({ kind: 'point' })
    expect(routingCalibration('logprob', undefined)).toEqual({ kind: 'global' })
    expect(routingCalibration(undefined, { ...point, calibratedBy: 'prereg-x' })).toEqual({ kind: 'calibrated', by: 'prereg-x' })
  })

  it('reports in gate() how it gates every registered engine, by the rule its consults apply', { timeout: 30_000 }, async () => {
    const { ctx, consult, decisions, engines } = await boot(
      [{ id: 'cal' }, { id: 'pt' }, { id: 'verb', calibration: 'verbalized' }, { id: 'ok', calibration: 'verbalized' }],
      'verb',
      [
        '    operatingPoints:',
        '      - { engine: pt, downgradeThreshold: 0.9, downgradeMargin: 0.5, calibratedBy: prereg-pt }',
        '      - { engine: ok, downgradeThreshold: 0.7, downgradeMargin: 0.2, acceptVerbalized: true }',
      ],
    )
    expect(ctx.modelRouting.gateView().engines).toEqual([
      { engine: 'cal', calibration: { kind: 'global' } },
      { engine: 'pt', calibration: { kind: 'calibrated', by: 'prereg-pt' } },
      { engine: 'verb', calibration: { kind: 'refused' } },
      { engine: 'ok', calibration: { kind: 'point' } },
    ])
    // The engine gate() reports refused is the one the consult refuses.
    await consult(1)
    expect(decisions()[0]).toMatchObject({ reason: 'engine-uncalibrated', engineId: 'verb' })
    expect(engines['verb']!.asks).toHaveLength(0)
  })

  it('refuses a verbalized engine selected while candidates are assessed, and asks nothing', { timeout: 30_000 }, async () => {
    const { ctx, routes, consult, decisions, engines } = await boot(
      [{ id: 'cal' }, { id: 'verb', calibration: 'verbalized' }],
      'cal',
    )
    routes.duringAssessment = () => ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'verb' })
    expect(await consult(1)).toBeUndefined()
    expect(decisions()).toHaveLength(1)
    expect(decisions()[0]).toMatchObject({ outcome: 'kept-strong', reason: 'engine-uncalibrated', engineId: 'verb' })
    expect(decisions()[0]).not.toHaveProperty('route')
    expect(decisions()[0]).not.toHaveProperty('thresholds')
    expect(engines['verb']!.asks).toHaveLength(0)
    expect(engines['cal']!.asks).toHaveLength(0)
  })

  it('records the thresholds of the engine that answers when the selection changes while candidates are assessed', { timeout: 30_000 }, async () => {
    const { ctx, routes, consult, decisions, engines } = await boot([{ id: 'cal' }, { id: 'pt' }], 'cal', [
      '    operatingPoints:',
      '      - { engine: pt, downgradeThreshold: 0.9, downgradeMargin: 0.5, calibratedBy: prereg-pt }',
    ])
    routes.duringAssessment = () => ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'pt' })
    expect(await consult(1)).toEqual(CHEAP)
    expect(engines['pt']!.asks).toHaveLength(1)
    expect(engines['cal']!.asks).toHaveLength(0)
    expect(decisions()[0]).toMatchObject({ reason: 'gate-passed', engine: 'pt', engineId: 'pt' })
    expect(decisions()[0]?.thresholds).toEqual({
      downgradeThreshold: 0.9,
      downgradeMargin: 0.5,
      entryScoreCeiling: 2,
      escalateBackScoreThreshold: 3,
      source: 'operating-point',
      calibratedBy: 'prereg-pt',
    })
  })

  it('treats an engine that starts warming while candidates are assessed as warm-up, not failure', { timeout: 30_000 }, async () => {
    // A switch to an engine that is still starting.
    const switched = await boot([{ id: 'cal' }, { id: 'warm', status: { state: 'starting' } }], 'cal')
    switched.routes.duringAssessment = () => switched.ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'warm' })
    expect(await switched.consult(1)).toBeUndefined()
    expect(switched.decisions()[0]).toMatchObject({
      reason: 'engine-unavailable',
      engineId: 'warm',
      engineFailure: { code: 'UNAVAILABLE', engineState: 'starting' },
    })
    expect(switched.engines['warm']!.asks).toHaveLength(0)
    expect(stickyState(switched.session.events)).not.toHaveProperty('judgmentFailures')
    await context?.fiber.dispose()
    context = undefined
    await rm(root!, { recursive: true, force: true })

    // The selected engine's own status flips, as a restart or an install does.
    const restarted = await boot([{ id: 'laya' }], 'laya')
    restarted.routes.duringAssessment = () => {
      restarted.engines['laya']!.setStatus({ state: 'not-installed', detail: 'run the install action' })
      return Promise.resolve()
    }
    expect(await restarted.consult(1)).toBeUndefined()
    expect(restarted.decisions()[0]).toMatchObject({
      reason: 'engine-unavailable',
      engineId: 'laya',
      engineFailure: { code: 'UNAVAILABLE', engineState: 'not-installed' },
    })
    expect(restarted.engines['laya']!.asks).toHaveLength(0)
    expect(stickyState(restarted.session.events)).not.toHaveProperty('judgmentFailures')
  })
})
