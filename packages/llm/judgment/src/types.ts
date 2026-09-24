/**
 * Vocabulary of the typed-judgment seam: typed questions in, probabilistic answers
 * out. Types only — no runtime code, no provider vocabulary, no transport, and
 * no session or conversation concept, so both a remote classifier provider and
 * an on-box distilled engine implement the same {@link JudgmentEngine} contract.
 *
 * @module @shres-code/shres-code-judgment/types
 */

import type { Branded } from '@shres-code/shres-code-brand'

/** Nominal id correlating one question with the answer it produced inside a single ask. */
export type JudgmentQuestionId = Branded<'JudgmentQuestionId'>

/**
 * Model tier an ask runs on. A provider maps each tier to its own model id, so a
 * consumer chooses speed against accuracy without naming a model.
 */
export type JudgmentTier = 'fast' | 'accurate'

/** Descriptions of what a binary question's two answers mean. */
export interface JudgmentBinaryCriteria {
  /** What a yes (probability near 1) means. */
  yes?: string
  /** What a no (probability near 0) means. */
  no?: string
}

/**
 * A yes/no question. The answer is the probability that it holds, which every
 * consumer thresholds itself — a provider never applies a cut-off.
 */
export interface JudgmentBinaryQuestion {
  /** Discriminant selecting the binary question form. */
  kind: 'binary'
  /** Id the matching answer carries. */
  id: JudgmentQuestionId
  /** What to evaluate. */
  instructions: string
  /** Optional descriptions of the two answers, which sharpen a borderline state. */
  criteria?: JudgmentBinaryCriteria
}

/** One selectable option of a choice question. */
export interface JudgmentChoiceOption {
  /** Option key; the answer's distribution is keyed by it. */
  option: string
  /** Rubric description of when this option applies. */
  description?: string
}

/** A question picking exactly one option from a set the consumer defines. */
export interface JudgmentChoiceQuestion {
  /** Discriminant selecting the choice question form. */
  kind: 'choice'
  /** Id the matching answer carries. */
  id: JudgmentQuestionId
  /** What to decide. */
  instructions: string
  /** Options to decide among, at least two; each answer entry reports one probability. */
  options: JudgmentChoiceOption[]
}

/**
 * A question rating the state along an ordered rubric. The answer is the
 * probability-weighted value across the levels, plus the distribution that
 * produced it.
 */
export interface JudgmentScoreQuestion {
  /** Discriminant selecting the score question form. */
  kind: 'score'
  /** Id the matching answer carries. */
  id: JudgmentQuestionId
  /** What to rate. */
  instructions: string
  /** Ordered level descriptions from lowest to highest, at least two. */
  levels: string[]
}

/** One typed question a judgment engine can answer. */
export type JudgmentQuestion = JudgmentBinaryQuestion | JudgmentChoiceQuestion | JudgmentScoreQuestion

/** The probability that a binary question's answer is yes. */
export interface JudgmentBinaryAnswer {
  /** Discriminant matching the question's. */
  kind: 'binary'
  /** Id of the question this answers. */
  id: JudgmentQuestionId
  /**
   * Probability from 0 (no) to 1 (yes). No confidence accompanies it: a
   * provider derives confidence from a distribution, and a binary answer has
   * none.
   */
  probability: number
}

/** The chosen option of a choice question and the distribution behind it. */
export interface JudgmentChoiceAnswer {
  /** Discriminant matching the question's. */
  kind: 'choice'
  /** Id of the question this answers. */
  id: JudgmentQuestionId
  /** Highest-probability option key. */
  option: string
  /** Probability per option key from the question's `options`. */
  probabilities: Readonly<Record<string, number>>
  /** How concentrated the distribution is, from 0 to 1. */
  confidence: number
}

/** The weighted value of a score question and the distribution behind it. */
export interface JudgmentScoreAnswer {
  /** Discriminant matching the question's. */
  kind: 'score'
  /** Id of the question this answers. */
  id: JudgmentQuestionId
  /** Probability-weighted value across the question's `levels`; can land between levels. */
  score: number
  /** Probability per level, keyed by the level's zero-based index as a decimal string. */
  probabilities: Readonly<Record<string, number>>
  /** How concentrated the distribution is, from 0 to 1. */
  confidence: number
}

/** One answer, discriminated by the kind of question it answers. */
export type JudgmentAnswer = JudgmentBinaryAnswer | JudgmentChoiceAnswer | JudgmentScoreAnswer

/** One ask: the state every question is evaluated against, and the questions. */
export interface JudgmentInput {
  /**
   * Text every question in this ask is evaluated against. A consumer with
   * structured state serializes it itself, so what leaves the process is the
   * exact text the redactor and any state cap inspected.
   */
  state: string
  /** Questions to answer in this one ask, each with an id unique within it. */
  questions: readonly JudgmentQuestion[]
  /** Model tier; omission resolves to `accurate`. */
  tier?: JudgmentTier
  /**
   * Cancellation signal. Every engine must honour it at every await, including
   * credential resolution, redaction, retry waits, and response reads: once it
   * aborts, the ask settles promptly with {@link JudgmentErrorCode} `ABORTED`.
   * A consumer that combines it with a deadline bounds how long it waits only
   * through this obligation.
   */
  signal?: AbortSignal
}

/** One ask's answers and the identity of what produced them. */
export interface JudgmentResult {
  /** One answer per question, in the order the questions were asked. */
  answers: readonly JudgmentAnswer[]
  /** Engine that produced the answers, named by the provider that served the ask. */
  engine: string
  /**
   * Exact model that answered, as the engine reports it. A provider serving
   * tier aliases reports the model id the alias resolved to, so a log records
   * which model actually produced an answer.
   */
  model: string
  /** Wall-clock duration of this ask in milliseconds. */
  latencyMs: number
}

/** Ordered complete state alternatives for one atomic capacity check and judgment. */
export interface JudgmentFittingInput extends Omit<JudgmentInput, 'state'> {
  /** Most preferred first; providers select the first fitting state without truncation. */
  states: readonly string[]
}

/** Effective tokenizer limits and the verified artifact that supplies them. */
export interface JudgmentTokenLimits {
  /** Maximum tokens in each complete question and state sequence. */
  maxSequenceTokens: number
  /** Maximum tokens reserved for a question and its options. */
  maxHeadTokens: number
  /** Maximum padded tokens across the whole question batch. */
  maxBatchTokens: number
  /** SHA-256 of the verified model, tokenizer, and configuration manifest. */
  manifestSha256: string
}

/** Exact input selected and measured before the corresponding inference. */
export interface JudgmentTokenFit {
  /** Index in the caller's ordered state alternatives. */
  selectedIndex: number
  /** Complete selected text after the provider's one redaction per candidate. */
  state: string
  /** Tokens in the selected state. */
  stateTokens: number
  /** Complete token count for each question, in question order. */
  sequenceTokens: readonly number[]
  /** Longest sequence length multiplied by the question count. */
  paddedTokens: number
  /** Limits applied to this inference. */
  limits: JudgmentTokenLimits
}

/** Capacity that prevented all offered states from being judged. */
export type JudgmentTokenLimitReason = 'state' | 'head' | 'option' | 'batch'

/** One fitted judgment, or an explicit capacity rejection without inference. */
export type JudgmentFittingResult =
  | { kind: 'answered'; fit: JudgmentTokenFit; result: JudgmentResult }
  | { kind: 'unfit'; engine: string; model: string; limits: JudgmentTokenLimits; reason: JudgmentTokenLimitReason }

/** Optional provider capability that measures and judges with one pinned tokenizer and model. */
export interface JudgmentFittingEngine {
  /**
   * Redact each alternative once, select the first fitting state, and judge it.
   * Honours `input.signal` as {@link JudgmentInput.signal} requires.
   * @param input - complete ordered states, common questions, tier, and cancellation signal.
   * @returns measured input and answers, or a capacity rejection without inference.
   * @throws JudgmentError with the same failure classes as {@link JudgmentEngine.ask}.
   */
  ask(input: JudgmentFittingInput): Promise<JudgmentFittingResult>
}

/**
 * The judgment capability every provider implements. Implementations own
 * transport, credential resolution, and wire validation; consumers own every
 * question string, threshold, and decision made from an answer.
 */
export interface JudgmentEngine {
  /** Exact tokenizer fitting when supported; absence leaves input sizing to the consumer. */
  readonly fitting?: JudgmentFittingEngine
  /**
   * Answer one set of typed questions about one state. Honours `input.signal`
   * as {@link JudgmentInput.signal} requires.
   * @param input - the state, the questions, the optional tier, and the cancellation signal.
   * @returns the answers with the engine and model identity and the ask's duration.
   * @throws JudgmentError for an unconfigured credential (`UNCONFIGURED`), an
   * unreachable or refusing provider (`UNAVAILABLE`), oversized serialized
   * input (`INPUT_TOO_LARGE`), an unusable provider
   * response (`INVALID_ANSWER`), or a cancelled ask (`ABORTED`).
   */
  ask(input: JudgmentInput): Promise<JudgmentResult>
}

/**
 * Optional egress hook with one home, the provider. A deployment that must not
 * send identifiable text to a judgment engine mounts one; every provider
 * consults it exactly once per state candidate, before serialization, and sends
 * what it returns. A consumer passes its state to `ctx.judgment.ask()`
 * unredacted and never consults the hook.
 */
export interface JudgmentRedactor {
  /**
   * Replace the state one ask is about to send.
   * @param state - the state text an engine is about to receive.
   * @returns the text to send instead; return the input unchanged when nothing
   *   needs redaction.
   */
  redactState(state: string): string | Promise<string>
}

/**
 * Deployment-level judgment settings, owned by the Definition's `judgment`
 * settings namespace. Consumers read the section live and treat
 * `enabled: false` exactly as an absent engine, so the toggle reuses their
 * existing degradation path instead of adding a second one.
 */
export interface JudgmentSettings {
  /** Whether judgment is available to consumers in this deployment. */
  enabled: boolean
}

/** Stable failure classes of one judgment ask. */
export type JudgmentErrorCode = 'UNCONFIGURED' | 'UNAVAILABLE' | 'INPUT_TOO_LARGE' | 'INVALID_ANSWER' | 'ABORTED'
