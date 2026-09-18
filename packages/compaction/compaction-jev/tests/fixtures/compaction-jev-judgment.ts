/**
 * Test-only judgment plugin for the Loader-composed snapshot arms.
 *
 * A composition row mounts THIS module instead of a remote provider, so the
 * scripted transcript is deterministic with no server, no credential, and no
 * network. It answers every question the selection and the verification battery
 * ask: a boundary hazard reads safe, a battery check reads verified, and a score
 * question reads the top of its rubric — the same shape the loopback stub in
 * ./composition.spec.ts serves over HTTP.
 *
 * @module @shres-code/shres-code-compaction-jev/tests/fixtures/compaction-jev-judgment
 */

import JudgmentService from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'

/** Engine name every answer reports, so a transcript names what produced it. */
const ENGINE = 'scripted-judgment'
/** Model name every answer reports. */
const MODEL = 'scripted-1'

/**
 * Deterministic judgment engine: one answer per asked question, no state.
 *
 * Registered as \`ctx.judgment\` by {@link JudgmentService}, exactly as a real
 * provider is, so the consumer's degradation and verdict paths are the shipping
 * ones.
 */
export default class ScriptedSnapshotJudgment extends JudgmentService {
  /**
   * Answer one ask from the fixed script this fixture owns.
   * @param input - the state, the questions, the optional tier, and the signal.
   * @returns one answer per question, in ask order.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    const answers: JudgmentAnswer[] = []
    for (const question of input.questions) {
      if (question.kind === 'binary') {
        answers.push({
          kind: 'binary',
          id: question.id,
          probability: question.id.startsWith('boundary:') ? 0 : 0.95,
        })
      } else if (question.kind === 'score') {
        answers.push({
          kind: 'score',
          id: question.id,
          score: 5,
          probabilities: { '4': 1 },
          confidence: 0.9,
        })
      }
      // A choice question is never asked by this backend, so none is answered.
    }
    return Promise.resolve({ answers, engine: ENGINE, model: MODEL, latencyMs: 0 })
  }
}
