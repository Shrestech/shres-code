/**
 * Scripted `ctx.judgment` double for real-composition tests.
 *
 * The judgment engine is an external service to this package, so the
 * composition tests substitute a deterministic engine that answers every ask
 * from one script: the route question names one allowlisted candidate with a
 * concentrated distribution, and the difficulty question rates every turn easy.
 * A test may replace that route answer once with {@link FakeJudgment.scriptRoute}
 * to drive a later turn through a failing gate. No clock, no randomness, and no
 * network reach the answers.
 *
 * @module @shres-code/shres-code-model-router/tests/fake-judgment-provider
 */

import { JudgmentService } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'

/** The candidate id the default scripted route answer names. */
export const SCRIPTED_CANDIDATE = 'flash'

/** The other allowlisted candidate id, reachable through {@link FakeJudgment.scriptRoute}. */
export const SCRIPTED_OTHER_CANDIDATE = 'vision'

/** Confidence the scripted route answer reports; above any gate the tests configure. */
const SCRIPTED_ROUTE_CONFIDENCE = 0.9

/** Probability-weighted difficulty the scripted score answer reports; below the entry ceiling. */
const SCRIPTED_DIFFICULTY_SCORE = 1

/** Engine name the scripted answers report. */
export const SCRIPTED_ENGINE = 'fake-judgment'

/**
 * A judgment engine that answers every ask from one fixed script.
 *
 * Every ask is retained in {@link asks}, so a test can assert what the router
 * actually asked (question ids, tier, state text) instead of trusting the
 * decisions alone.
 */
export class FakeJudgment extends JudgmentService {
  /** Every ask this engine received, in order. */
  readonly asks: JudgmentInput[] = []

  /** Option the route answer currently names. */
  private route = SCRIPTED_CANDIDATE
  /** Confidence the route answer currently reports. */
  private confidence = SCRIPTED_ROUTE_CONFIDENCE

  /**
   * Replace the route answer every later ask reports, so a turn can be driven
   * through a failing gate without changing the composed tree.
   * @param option - allowlist option id the route answer names.
   * @param confidence - confidence that answer reports, from 0 through 1.
   */
  scriptRoute(option: string, confidence: number): void {
    this.route = option
    this.confidence = confidence
  }

  /**
   * Answer one ask from the current script: the route question names the
   * scripted option with the scripted confidence, and any score question reports
   * {@link SCRIPTED_DIFFICULTY_SCORE}.
   * @param input - the state and questions the router asked.
   * @returns one scripted answer per question, in ask order.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    const route = this.route
    const confidence = this.confidence
    const answers: JudgmentAnswer[] = input.questions.map((question): JudgmentAnswer => {
      if (question.kind !== 'choice') {
        return {
          kind: 'score',
          id: question.id,
          score: SCRIPTED_DIFFICULTY_SCORE,
          probabilities: { '2': 1 },
          confidence: 1,
        }
      }
      const others = question.options.filter(option => option.option !== route)
      const remainder = (1 - confidence) / Math.max(1, others.length)
      return {
        kind: 'choice',
        id: question.id,
        option: route,
        probabilities: Object.fromEntries(question.options.map(option => [
          option.option,
          option.option === route ? confidence : remainder,
        ])),
        confidence,
      }
    })
    return Promise.resolve({
      answers,
      engine: SCRIPTED_ENGINE,
      model: 'fake-judgment-v1',
      latencyMs: 0,
    })
  }
}
