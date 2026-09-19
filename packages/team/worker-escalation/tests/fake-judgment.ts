/**
 * Scripted `ctx.judgment` double for the ladder's consult suites, plus the
 * optional egress hook a deployment mounts when state text must be rewritten
 * before it leaves the process.
 *
 * The judgment engine is an external service to this package, so the suites
 * substitute a deterministic one: every ask is retained, and each test scripts
 * the answer, the answer's kind, or a failure. No clock, randomness, or network
 * reaches an answer. The redactor double marks every state it is given, so a
 * test can show that what the engine received is what the hook returned.
 *
 * @module @shres-code/shres-code-worker-escalation/tests/fake-judgment
 */

import { Service } from '@shres-code/cordis'
import type { Context } from '@shres-code/cordis'
import { JudgmentService } from '@shres-code/shres-code-judgment'
import type { JudgmentChoiceAnswer, JudgmentInput, JudgmentResult } from '@shres-code/shres-code-judgment'

/** The state prefix the redactor double writes, so its output is recognizable. */
export const REDACTION_MARK = '[redacted]'

/** One scripted choice answer. */
interface ScriptedAnswer {
  /** Option the answer names. */
  readonly option: string
  /** Probability per option, keyed as the question keys them. */
  readonly probabilities: Record<string, number>
  /** Confidence the answer reports. */
  readonly confidence: number
}

/** The concentrated answer every test starts from: continue, with a wide margin. */
const DEFAULT_ANSWER: ScriptedAnswer = {
  option: 'continue',
  probabilities: { continue: 0.9, 'needs-help': 0.1 },
  confidence: 0.9,
}

/** A judgment engine that answers every ask from one script. */
export class FakeJudgment extends JudgmentService {
  /** Every ask this engine received, in order. */
  readonly asks: JudgmentInput[] = []

  /** The answer every later ask reports. */
  private current: ScriptedAnswer = DEFAULT_ANSWER

  /** The failure every later ask rejects with, when one is scripted. */
  private failure: Error | undefined

  /** Whether answers keep the choice question's own kind. */
  private answerAsChoice = true

  /**
   * Replace the choice answer every later ask reports.
   * @param answer - fields to replace on the scripted answer.
   */
  script(answer: Partial<ScriptedAnswer> = {}): void {
    this.failure = undefined
    this.answerAsChoice = true
    this.current = { ...DEFAULT_ANSWER, ...answer }
  }

  /**
   * Answer with a score answer instead of the choice kind the question asked,
   * which is one malformed-answer class.
   */
  scriptForeignKind(): void {
    this.failure = undefined
    this.answerAsChoice = false
  }

  /**
   * Reject every later ask with one failure.
   * @param error - the failure to reject with, as a provider would.
   */
  scriptFailure(error: Error): void {
    this.failure = error
  }

  /** Answer one ask from the current script. */
  override ask(input: JudgmentInput): Promise<JudgmentResult> {
    this.asks.push(input)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const answers = this.answerAsChoice
      ? input.questions.map((question): JudgmentChoiceAnswer => ({
        kind: 'choice',
        id: question.id,
        option: this.current.option,
        probabilities: this.current.probabilities,
        confidence: this.current.confidence,
      }))
      : input.questions.map(question => ({
        kind: 'score' as const,
        id: question.id,
        score: 1,
        probabilities: { '1': 1 },
        confidence: 1,
      }))
    return Promise.resolve({ answers, engine: 'fake-judgment', model: 'fake-judgment-v1', latencyMs: 0 })
  }
}

/** Egress-hook double: marks every state it is given and retains it for inspection. */
export class StubRedactor extends Service {
  /** Every state this hook was consulted about, in order. */
  readonly states: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'judgmentRedactor')
  }

  /**
   * Replace one state the engine is about to receive.
   * @param state - the state an ask is about to send.
   * @returns the state behind the redaction mark.
   */
  redactState(state: string): string {
    this.states.push(state)
    return REDACTION_MARK + '\n' + state
  }
}
