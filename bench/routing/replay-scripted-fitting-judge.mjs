/**
 * Test-only fitting judgment engine. Registers through public
 * registerJudgmentEngine (fiber effect). Does not mount ctx.judgment.
 * @module
 */
import { JudgmentError, judgmentEngineId, registerJudgmentEngine } from '../../packages/llm/judgment/lib/index.js'
import {
  DIFFICULTY_QUESTION_ID,
  KEEP_CURRENT_OPTION_ID,
  ROUTE_QUESTION_ID,
} from '../../packages/llm/model-router/lib/index.js'

export const name = 'bench-replay-scripted-fitting-judge'
export const inject = ['judgmentEngines']
export const internals = { asks: [] }

const ENGINE_ID = judgmentEngineId('scripted-fitting')
const LIMITS = {
  maxSequenceTokens: 4096,
  maxHeadTokens: 512,
  maxBatchTokens: 8192,
  manifestSha256: '0'.repeat(64),
}

function choiceAnswer(option, probabilities, omit) {
  const probs = { ...probabilities }
  if (omit === 'keep-current') delete probs[KEEP_CURRENT_OPTION_ID]
  return {
    kind: 'choice',
    id: ROUTE_QUESTION_ID,
    option,
    confidence: Math.max(...Object.values(probs)),
    probabilities: probs,
  }
}

export class ScriptedFittingEngine {
  static inject = ['judgmentEngines']

  constructor(ctx, config = {}) {
    this.pluginConfig = config
    internals.asks = []
    this.recordedAsks = internals.asks
    this.fitting = { ask: (input) => this.askFitted(input) }
    this.descriptor = {
      id: ENGINE_ID,
      label: 'scripted-fitting',
      egress: 'none',
      calibration: config.calibration ?? 'calibrated',
      supportsFitting: true,
    }
    registerJudgmentEngine(ctx, {
      engine: this,
      descriptor: this.descriptor,
      status: () => ({ state: 'ready' }),
    })
  }

  ask() {
    return Promise.resolve({ answers: [], engine: 'scripted-fitting', model: 'scripted-fitting-v1', latencyMs: 0 })
  }

  async askFitted(input) {
    const key = input.correlation?.consultKey ?? ''
    const script = this.pluginConfig.scripts?.[key] ?? this.pluginConfig.defaultScript ?? { kind: 'answered' }
    this.recordedAsks.push({
      consumer: input.consumer,
      correlation: input.correlation,
      tier: input.tier,
      states: input.states,
      questions: input.questions,
      hasSignal: input.signal !== undefined,
    })
    if (input.signal?.aborted) throw new JudgmentError('ABORTED', 'scripted-fitting aborted')
    if (script.delayMs) await new Promise(resolve => setTimeout(resolve, script.delayMs))
    if (script.kind === 'unfit') {
      return {
        kind: 'unfit',
        engine: 'scripted-fitting',
        model: 'scripted-fitting-v1',
        limits: LIMITS,
        reason: script.reason ?? 'state',
      }
    }
    if (typeof script.kind === 'string' && script.kind.startsWith('error:')) {
      const code = script.kind.slice('error:'.length)
      throw new JudgmentError(code, script.kind)
    }
    const omit = script.omit
    const answers = []
    if (omit !== 'route') {
      answers.push(choiceAnswer(
        script.winner ?? 'flash',
        script.probabilities ?? { [KEEP_CURRENT_OPTION_ID]: 0.3, flash: 0.6, vision: 0.1 },
        omit,
      ))
    }
    if (omit !== 'difficulty') {
      answers.push({
        kind: 'score',
        id: DIFFICULTY_QUESTION_ID,
        score: script.difficultyScore ?? 2,
        confidence: 1,
        probabilities: { '2': 1 },
      })
    }
    const selectedIndex = script.selectedIndex ?? 0
    const stateTokens = script.stateTokens ?? 80
    const sequenceTokens = script.sequenceTokens ?? [120, 95]
    return {
      kind: 'answered',
      fit: {
        selectedIndex,
        state: input.states[selectedIndex] ?? input.states[0],
        stateTokens,
        sequenceTokens,
        paddedTokens: Math.max(...sequenceTokens) * sequenceTokens.length,
        limits: LIMITS,
      },
      result: {
        answers,
        engine: 'scripted-fitting',
        model: 'scripted-fitting-v1',
        latencyMs: script.delayMs ?? 0,
      },
    }
  }
}

export function apply(ctx, config = {}) {
  ctx.plugin(ScriptedFittingEngine, config)
}
