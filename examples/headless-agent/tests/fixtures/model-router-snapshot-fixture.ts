/**
 * Snapshot-only composition for the keyless model-routing fixtures: a scripted
 * `ctx.judgment` engine plus the model-selection wiring the headless example's
 * spine leaves to its app runner.
 *
 * The judgment engine is an external service to the router, so the fixture
 * answers every ask from one configured script: the route question names either
 * the `flash` candidate or the current model, and the difficulty question
 * returns a configured zero-based score. The selection wiring mirrors what the
 * product CLI runner installs in its agent setup — the spine's pre-created root
 * agent has no selection ref until one is installed, and the router is only
 * reachable from the `agent/request` waterfall that installation registers.
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { JudgmentService } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentFittingEngine, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'
import { createUserMessage } from '@shres-code/shres-code-llm'
import { KEEP_CURRENT_OPTION_ID, MODEL_ROUTER_SETTINGS_NAMESPACE } from '@shres-code/shres-code-model-router'

/** Candidate id the scripted route answer names. */
const CANDIDATE = 'flash'

/** Confidence the scripted route answer reports. */
const ROUTE_CONFIDENCE = 0.9

/** Probability-weighted difficulty the scripted score answer reports. */
const DIFFICULTY_SCORE = 2

/** Fixture configuration selecting the scripted route and difficulty. */
export interface Config {
  /** Route the choice answer selects. */
  route?: 'candidate' | 'current'
  /** Zero-based score the difficulty answer reports. */
  difficultyScore?: number
  /** Evidence text that makes the next step hard when it appears in the judged state. */
  hardEvidence?: string
  /** Scripted capacity selection; zero disables the fitting capability. */
  fitStateMaxChars?: number
  /** Plugin context appended after accepted user input. */
  trailingContext?: string
  /** Deployment mode written to the real settings file before each turn. */
  deploymentModes?: ('on' | 'off')[]
  /** Turn on which the fixture records an explicit manual `on` choice. */
  manualModeTurn?: number
}

/** Schemastery configuration for the scripted judgment engine. */
export const Config: z<Config> = z.object({
  route: z.union(['candidate', 'current'] as const).default('candidate'),
  difficultyScore: z.number().step(1).min(0).default(DIFFICULTY_SCORE),
  hardEvidence: z.string().default(''),
  fitStateMaxChars: z.number().step(1).min(0).default(0),
  trailingContext: z.string().default(''),
  deploymentModes: z.array(z.union(['on', 'off'] as const)).default([]),
  manualModeTurn: z.number().step(1).min(0).default(0),
})

/** A judgment engine answering every ask from the configured script. */
class SnapshotJudgment extends JudgmentService {
  static Config: z<Config> = Config

  declare readonly fitting?: JudgmentFittingEngine

  private readonly config: Required<Config>

  /**
   * Create the scripted engine.
   * @param ctx - the context the engine registers on.
   * @param config - the route and difficulty answers to emit.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = {
      route: config.route ?? 'candidate',
      difficultyScore: config.difficultyScore ?? DIFFICULTY_SCORE,
      hardEvidence: config.hardEvidence ?? '',
      fitStateMaxChars: config.fitStateMaxChars ?? 0,
      trailingContext: config.trailingContext ?? '',
      deploymentModes: config.deploymentModes ?? [],
      manualModeTurn: config.manualModeTurn ?? 0,
    }
    if (this.config.fitStateMaxChars > 0) {
      this.fitting = { ask: async (input) => {
        const limits = {
          maxSequenceTokens: 1024, maxHeadTokens: 256, maxBatchTokens: 4096, manifestSha256: 'a'.repeat(64),
        }
        // This fixture's tokenizer counts one character per token.
        const selectedIndex = input.states.findIndex(state => state.length <= this.config.fitStateMaxChars)
        if (selectedIndex < 0) {
          return { kind: 'unfit', engine: 'snapshot-judgment', model: 'snapshot-judgment-v1', limits, reason: 'state' }
        }
        const state = input.states[selectedIndex]!
        const sequenceTokens = input.questions.map(() => state.length + 64)
        return {
          kind: 'answered',
          fit: {
            selectedIndex, state, stateTokens: state.length, sequenceTokens,
            paddedTokens: (state.length + 64) * input.questions.length, limits,
          },
          result: await this.ask({ ...input, state }),
        }
      } }
    }
  }

  /**
   * Answer one ask from the fixed script.
   * @param input - the state and questions the router asked.
   * @returns one scripted answer per question, in ask order.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    const answers: JudgmentAnswer[] = input.questions.map((question): JudgmentAnswer => {
      if (question.kind !== 'choice') {
        const score = this.config.hardEvidence !== '' && input.state.includes(this.config.hardEvidence)
          ? 4
          : this.config.difficultyScore
        return { kind: 'score', id: question.id, score, probabilities: { [String(score)]: 1 }, confidence: 1 }
      }
      const choice = this.config.route === 'current' ? KEEP_CURRENT_OPTION_ID : CANDIDATE
      const others = question.options.filter(option => option.option !== choice)
      const remainder = Number(((1 - ROUTE_CONFIDENCE) / Math.max(1, others.length)).toFixed(12))
      return {
        kind: 'choice',
        id: question.id,
        option: choice,
        probabilities: Object.fromEntries(question.options.map(option => [
          option.option,
          option.option === choice ? ROUTE_CONFIDENCE : remainder,
        ])),
        confidence: ROUTE_CONFIDENCE,
      }
    })
    return Promise.resolve({ answers, engine: 'snapshot-judgment', model: 'snapshot-judgment-v1', latencyMs: 0 })
  }
}

/** Cordis plugin name. */
export const name = 'model-router-snapshot-fixture'

/** Required default-model service the selection wiring installs through. */
export const inject = ['agentDefaultModel', 'settings']

/**
 * Register the scripted engine and install the root agent's model selection.
 * @param ctx - the fixture's context.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(SnapshotJudgment, config)
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    if (config.manualModeTurn === turn) {
      const routing = ctx.get('modelRouting')
      if (routing === undefined) throw new Error('model-router-snapshot-fixture: manualModeTurn requires modelRouting')
      routing.set(agent, true)
    }
    const deploymentMode = config.deploymentModes?.[turn - 1]
    if (deploymentMode !== undefined) {
      await ctx.settings.update(MODEL_ROUTER_SETTINGS_NAMESPACE, { initialMode: deploymentMode })
    }
    ctx.get('agentDefaultModel')?.selectionFor(agent)
    const decision = await next()
    if (decision.kind === 'reject' || !config.trailingContext) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: config.trailingContext }],
        source: { kind: 'plugin', plugin: 'model-router-snapshot-fixture' },
      })],
    }
  })
}
