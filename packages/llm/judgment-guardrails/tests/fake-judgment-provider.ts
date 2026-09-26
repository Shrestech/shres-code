/**
 * Scripted `ctx.judgment` double for the observer's suites and its snapshot
 * arm.
 *
 * The judgment engine is an external service to this package, so the suites
 * substitute a deterministic engine that answers every ask from one script: the
 * binary question reports a scripted injection probability and the score
 * question a scripted severity. Every ask is retained in {@link asks}, so a test
 * asserts what the observer actually asked — question ids, criteria, levels,
 * tier, and state text — instead of trusting the decisions alone. No clock, no
 * randomness, and no network reach an answer.
 *
 * @module @shres-code/shres-code-judgment-guardrails/tests/fake-judgment-provider
 */

import { JudgmentService } from '@shres-code/shres-code-judgment'
import type { JudgmentAnswer, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'

/** Injection probability the default script reports. */
export const SCRIPTED_INJECTION_PROBABILITY = 0.12

/** Severity score the default script reports. */
export const SCRIPTED_SEVERITY_SCORE = 2

/** Confidence the default script reports for the score answer. */
export const SCRIPTED_SEVERITY_CONFIDENCE = 0.87

/** Engine name every scripted answer reports. */
export const SCRIPTED_ENGINE = 'fake-judgment'

/** How the double answers the next ask. */
type Script =
  | { readonly kind: 'answers' }
  /** Answer with only some of the asked questions, which is an unusable answer. */
  | { readonly kind: 'missing' }
  /** Answer every question with a kind the question did not ask for. */
  | { readonly kind: 'foreign-kind' }
  /** Refuse the ask with one failure. */
  | { readonly kind: 'failure'; readonly error: Error }

/** A judgment engine that answers every ask from one fixed script. */
export class FakeJudgment extends JudgmentService {
  /** Every ask this engine received, in order. */
  readonly asks: JudgmentInput[] = []

  private probability = SCRIPTED_INJECTION_PROBABILITY
  private score = SCRIPTED_SEVERITY_SCORE
  private confidence = SCRIPTED_SEVERITY_CONFIDENCE
  private script: Script = { kind: 'answers' }

  /**
   * Replace the answers every later ask reports.
   * @param answer - fields to replace on the scripted answers.
   */
  scriptAnswer(answer: { probability?: number; score?: number; confidence?: number } = {}): void {
    this.script = { kind: 'answers' }
    this.probability = answer.probability ?? SCRIPTED_INJECTION_PROBABILITY
    this.score = answer.score ?? SCRIPTED_SEVERITY_SCORE
    this.confidence = answer.confidence ?? SCRIPTED_SEVERITY_CONFIDENCE
  }

  /** Answer with only the severity question, so the check reads an unusable answer. */
  scriptMissingAnswer(): void {
    this.script = { kind: 'missing' }
  }

  /** Answer with a kind neither question asked for, so the check reads an unusable answer. */
  scriptForeignKind(): void {
    this.script = { kind: 'foreign-kind' }
  }

  /**
   * Refuse every later ask with one failure.
   * @param error - the failure to reject with, as a provider would.
   */
  scriptFailure(error: Error): void {
    this.script = { kind: 'failure', error }
  }

  /**
   * Answer one ask from the current script.
   * @param input - the state and questions the observer asked.
   * @returns one scripted answer per question, in ask order.
   * @throws the scripted failure when the script refuses.
   */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    const script = this.script
    if (script.kind === 'failure') return Promise.reject(script.error)
    const asked = script.kind === 'missing'
      ? input.questions.filter(question => question.kind !== 'binary')
      : input.questions
    const answers = asked.map((question): JudgmentAnswer => {
      if (script.kind === 'foreign-kind') {
        return { kind: 'choice', id: question.id, option: 'other', probabilities: { other: 1 }, confidence: 1 }
      }
      return question.kind === 'binary'
        ? { kind: 'binary', id: question.id, probability: this.probability }
        : { kind: 'score', id: question.id, score: this.score, probabilities: { '2': 1 }, confidence: this.confidence }
    })
    return Promise.resolve({
      answers,
      engine: SCRIPTED_ENGINE,
      model: 'fake-judgment-v1',
      latencyMs: 0,
    })
  }
}
