/**
 * Snapshot-only composition for the keyless model-routing fixtures: a scripted
 * `ctx.judgment` engine plus the model-selection wiring the headless example's
 * spine leaves to its app runner.
 *
 * The judgment engine is an external service to the router, so the fixture
 * answers every ask from one fixed script: the route question names the `flash`
 * candidate with a concentrated distribution and the difficulty question rates
 * the turn easy. The selection wiring mirrors what the product CLI runner
 * installs in its agent setup — the spine's pre-created root agent has no
 * selection ref until one is installed, and the router is only reachable from
 * the `agent/request` waterfall that installation registers.
 */

import type { Context } from '@shres-code/cordis'
import { JudgmentService } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'

/** Candidate id the scripted route answer names. */
const CANDIDATE = 'flash'

/** Confidence the scripted route answer reports. */
const ROUTE_CONFIDENCE = 0.9

/** Probability-weighted difficulty the scripted score answer reports. */
const DIFFICULTY_SCORE = 2

/** A judgment engine answering every ask from one fixed script. */
class SnapshotJudgment extends JudgmentService {
  /**
   * Answer one ask from the fixed script.
   * @param input - the state and questions the router asked.
   * @returns one scripted answer per question, in ask order.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    const answers: JudgmentAnswer[] = input.questions.map((question): JudgmentAnswer => {
      if (question.kind !== 'choice') {
        return { kind: 'score', id: question.id, score: DIFFICULTY_SCORE, probabilities: { '1': 1 }, confidence: 1 }
      }
      const others = question.options.filter(option => option.option !== CANDIDATE)
      const remainder = (1 - ROUTE_CONFIDENCE) / Math.max(1, others.length)
      return {
        kind: 'choice',
        id: question.id,
        option: CANDIDATE,
        probabilities: Object.fromEntries(question.options.map(option => [
          option.option,
          option.option === CANDIDATE ? ROUTE_CONFIDENCE : remainder,
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
export const inject = ['agentDefaultModel']

/**
 * Register the scripted engine and install the root agent's model selection.
 * @param ctx - the fixture's context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SnapshotJudgment)
  ctx.on('agent/pre-step', ({ agent }, next) => {
    ctx.get('agentDefaultModel')?.selectionFor(agent)
    return next()
  })
}
