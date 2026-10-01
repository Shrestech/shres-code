/**
 * Test-only non-fitting engine. Registers through registerJudgmentEngine.
 * @module
 */
import { judgmentEngineId, registerJudgmentEngine } from '../../packages/llm/judgment/lib/index.js'

export const name = 'bench-replay-scripted-nonfitting-judge'
export const inject = ['judgmentEngines']
const ENGINE_ID = judgmentEngineId('scripted-nonfitting')

export class ScriptedNonfittingEngine {
  static inject = ['judgmentEngines']
  constructor(ctx) {
    registerJudgmentEngine(ctx, {
      engine: this,
      descriptor: {
        id: ENGINE_ID,
        label: 'scripted-nonfitting',
        egress: 'none',
        calibration: 'calibrated',
        supportsFitting: false,
      },
      status: () => ({ state: 'ready' }),
    })
  }
  ask() {
    return Promise.resolve({ answers: [], engine: 'scripted-nonfitting', model: 'none', latencyMs: 0 })
  }
}

export function apply(ctx) {
  ctx.plugin(ScriptedNonfittingEngine)
}
