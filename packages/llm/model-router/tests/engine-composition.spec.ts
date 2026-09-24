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
import type { JudgmentEngineStatus, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'
import JudgmentDispatch from '@shres-code/shres-code-judgment-dispatch'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createUserMessage } from '@shres-code/shres-code-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@shres-code/shres-code-llm'
import SessionStore from '@shres-code/shres-code-session'
import type { Session } from '@shres-code/shres-code-session'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import ModelRoutingController from '../src/index.ts'
import { stickyState } from '../src/folds.ts'
import type { ModelRoutingDecision } from '../src/types.ts'

/**
 * REAL Loader composition of the router with `judgment-dispatch` and two
 * registered engines, booted from a test-only `cordis.yml`: a Laya-like engine
 * whose registry status the test drives (starting, then ready but failing), and
 * a second engine that answers. It pins, through the shipped dispatcher and
 * registry, that an engine still becoming ready does not open the breaker and
 * that switching the selected engine lets routing ask again at once.
 *
 * TEST DOUBLES: the two engines and the llm adapter that only describes route
 * capabilities; no request leaves the process.
 */

const STRONG: ModelSelection = { provider: 'strong-route', model: 'strong' }
const CHEAP = { provider: 'cheap-route', model: 'cheap' }

/** Route metadata the capability assessment reads. */
class Routes extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'low' }], defaultEffort: ReasoningEffortId('low') },
    })
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

/** Build one engine plugin module whose handle the test drives. */
function enginePlugin(id: string, initial: JudgmentEngineStatus): { module: unknown; handle: ScriptedEngine } {
  let current = initial
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
    name: `test-engine-${id}`,
    inject: ['judgmentEngines'],
    apply: (ctx: Context) => {
      announce = registerJudgmentEngine(ctx, {
        engine: {
          ask: (input: JudgmentInput): Promise<JudgmentResult> => {
            handle.asks.push(input)
            if (handle.failing) return Promise.reject(new JudgmentError('UNAVAILABLE', `${id} refused the ask`))
            return Promise.resolve({
              answers: input.questions.map(question => question.kind === 'choice'
                ? { kind: 'choice', id: question.id, option: 'cheap', confidence: 0.95, probabilities: { 'keep-current': 0.02, cheap: 0.98 } }
                : { kind: 'score', id: question.id, score: 0, confidence: 1, probabilities: { 0: 1 } }),
              engine: id,
              model: `${id}-1`,
              latencyMs: 5,
            } as JudgmentResult)
          },
        },
        descriptor: { id: judgmentEngineId(id), label: id, egress: 'none', calibration: 'calibrated', supportsFitting: false },
        status: () => current,
      })
    },
  }
  return { module, handle }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition: router, judgment-dispatch, and registered engines', () => {
  it('ignores engine warm-up for the breaker, and asks again at once after an engine switch', { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'shres-model-router-engines-'))
    const laya = enginePlugin('laya', { state: 'starting', detail: 'loading the model' })
    const other = enginePlugin('other', { state: 'ready' })
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
      '    defaultEngine: laya',
      "- name: '@test/laya'",
      "- name: '@test/other'",
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
      '',
    ].join('\n'))
    const modules = new Map<string, unknown>([
      ['@shres-code/shres-code-llm', LlmRuntime],
      ['@test/routes', { name: 'test-routes', inject: ['llm'], apply: (ctx: Context) => { ctx.effect(() => ctx.llm.registerAdapter([STRONG.provider, CHEAP.provider], new Routes())) } }],
      ['@shres-code/shres-code-session', SessionStore],
      ['@shres-code/shres-code-agent', AgentRegistry],
      ['@shres-code/shres-code-settings-file', FileSettingsProvider],
      ['@shres-code/shres-code-judgment-dispatch', JudgmentDispatch],
      ['@test/laya', laya.module],
      ['@test/other', other.module],
      ['@shres-code/shres-code-model-router', ModelRoutingController],
    ])
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await context.loader.await()
    const ctx = context

    const session: Session = ctx.sessions.create()
    const agent = { id: session.id, session, ctx } as unknown as Agent
    ctx.agents.register(agent)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'rename one helper' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const decisions = (): ModelRoutingDecision[] => session.events.flatMap(event => event.type === 'model-routing/decision' ? [event.data] : [])
    const consult = async (turn: number): Promise<ModelSelection | undefined> => {
      if (turn > 1) session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn })
      return ctx.modelRouting.resolveRequest(agent, turn, 1, STRONG, new AbortController().signal, {
        config: STRONG,
        content: { messages: session.deriveMessages(), system: '', tools: [] },
      })
    }

    // Laya is loading: four consults, no call, and no breaker.
    for (const turn of [1, 2, 3, 4]) expect(await consult(turn)).toBeUndefined()
    expect(decisions().map(decision => decision.engineFailure?.engineState)).toEqual(['starting', 'starting', 'starting', 'starting'])
    expect(laya.handle.asks).toHaveLength(0)
    expect(stickyState(session.events)).not.toHaveProperty('judgmentFailures')

    // Ready but refusing: two real failures open the breaker.
    laya.handle.setStatus({ state: 'ready' })
    laya.handle.failing = true
    expect(await consult(5)).toBeUndefined()
    expect(await consult(6)).toBeUndefined()
    expect(await consult(7)).toBeUndefined()
    expect(decisions().slice(4).map(decision => decision.reason)).toEqual(['engine-unavailable', 'engine-unavailable', 'breaker-open'])
    expect(laya.handle.asks).toHaveLength(2)

    // Switching the selected engine asks the new one at once.
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'other' })
    expect(await consult(8)).toEqual(CHEAP)
    expect(decisions().at(-1)).toMatchObject({ reason: 'gate-passed', engineId: 'other', engine: 'other' })
    expect(other.handle.asks).toHaveLength(1)
    expect(other.handle.asks[0]?.consumer).toBe('model-router')
  })
})
