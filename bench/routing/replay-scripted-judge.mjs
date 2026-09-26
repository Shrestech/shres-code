/**
 * Test-only JudgmentService. Answers the router questions locally. No HTTP.
 * @module
 */
import { JudgmentService } from '../../packages/llm/judgment/lib/index.js'
import { KEEP_CURRENT_OPTION_ID } from '../../packages/llm/model-router/lib/index.js'

export const name = 'bench-replay-scripted-judge'

export class ScriptedReplayJudge extends JudgmentService {
  constructor(ctx) {
    super(ctx, 'judgment')
  }

  ask(input) {
    const answers = []
    for (const question of input.questions ?? []) {
      if (question.kind === 'choice') {
        const option = (question.options ?? []).some(entry => entry.option === 'flash')
          ? 'flash'
          : KEEP_CURRENT_OPTION_ID
        answers.push({
          kind: 'choice',
          id: question.id,
          option,
          confidence: 0.9,
          probabilities: { [option]: 0.9 },
        })
      }
      if (question.kind === 'score') {
        answers.push({
          kind: 'score',
          id: question.id,
          score: 1,
          confidence: 1,
          probabilities: { '0': 1 },
        })
      }
    }
    return Promise.resolve({
      answers,
      engine: 'scripted-replay',
      model: 'scripted-replay-v1',
      latencyMs: 0,
    })
  }
}

export function apply(ctx) {
  ctx.plugin(ScriptedReplayJudge)
}
