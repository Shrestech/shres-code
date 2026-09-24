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

/** Nominal id of one engine registered in `ctx.judgmentEngines`, such as `typesafe` or `shield`. */
export type JudgmentEngineId = Branded<'JudgmentEngineId'>

/**
 * Nominal id a consumer names itself with on each ask, such as
 * `worker-escalation`. The `judgment` settings `overrides` map is keyed by
 * it, so a deployment can route one consumer to a different engine.
 */
export type JudgmentConsumerId = Branded<'JudgmentConsumerId'>

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
  /**
   * The asking consumer. A dispatcher answers the ask with the engine the
   * settings `overrides` map names for this id, and with the deployment-wide
   * engine when the id is absent or has no override. Single-engine
   * implementations ignore it.
   */
  consumer?: JudgmentConsumerId
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
  /**
   * Registry id of the engine the dispatcher routed the ask to. Present on
   * every dispatched result; absent when a single-engine implementation served
   * `ctx.judgment` directly.
   */
  engineId?: JudgmentEngineId
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
  | {
    kind: 'unfit'
    engine: string
    model: string
    limits: JudgmentTokenLimits
    reason: JudgmentTokenLimitReason
    /** Registry id of the engine a dispatcher routed the fitted ask to, as on {@link JudgmentResult}. */
    engineId?: JudgmentEngineId
  }

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
  /**
   * Registry id of the engine that answers every ask without an override.
   * `judgment-dispatch` always supplies it from its required `defaultEngine`;
   * it is absent only when a single-engine implementation serves
   * `ctx.judgment` directly and there is nothing to select.
   */
  engine?: string
  /**
   * Engine per consumer, keyed by {@link JudgmentConsumerId}, overriding
   * {@link engine} for that consumer's asks. A key no consumer names has no
   * effect. Omitted, or `null` from a valueless YAML key, means no overrides.
   */
  overrides?: Readonly<Record<string, string>> | null
}

/** Stable failure classes of one judgment ask. */
export type JudgmentErrorCode = 'UNCONFIGURED' | 'UNAVAILABLE' | 'INPUT_TOO_LARGE' | 'INVALID_ANSWER' | 'ABORTED'

/**
 * Where an engine sends the state it judges: `none` keeps it within the
 * harness process and processes the engine's provider supervises on this host,
 * `local` sends it to a service on this host that the deployment runs, and
 * `remote` sends it off the host to a third party.
 */
export type JudgmentEngineEgress = 'none' | 'local' | 'remote'

/**
 * How an engine produces its probabilities: `calibrated` from a classifier
 * trained to output them, `logprob` from a generative model's token
 * log-probabilities, and `verbalized` from numbers a generative model writes out.
 * Thresholds do not transfer between engines of different calibration.
 */
export type JudgmentEngineCalibration = 'calibrated' | 'logprob' | 'verbalized'

/** Host an engine can run on: one platform-architecture pair, or `any`. */
export type JudgmentEngineHost = 'darwin-arm64' | 'any'

/** Static facts about one registered engine, which a configuration surface shows before selection. */
export interface JudgmentEngineDescriptor {
  /** Registry id; equals the id the engine registers under. */
  readonly id: JudgmentEngineId
  /** Human-readable name. */
  readonly label: string
  /** Where the engine sends the state it judges. */
  readonly egress: JudgmentEngineEgress
  /** How the engine produces its probabilities. */
  readonly calibration: JudgmentEngineCalibration
  /** Whether the engine exposes {@link JudgmentEngine.fitting}; must agree with it. */
  readonly supportsFitting: boolean
  /** Host the engine requires; omission means `any`. */
  readonly host?: JudgmentEngineHost
  /** URL of the terms that govern a remote engine's use. */
  readonly terms?: string
}

/**
 * Lifecycle state of one registered engine. Only `ready` answers asks; every
 * other state makes a dispatched ask fail `UNAVAILABLE` with the state's detail.
 */
export type JudgmentEngineState = 'ready' | 'starting' | 'unavailable' | 'unconfigured' | 'not-installed' | 'unsupported-host'

/** Current state of one registered engine. */
export interface JudgmentEngineStatus {
  /** Lifecycle state. */
  readonly state: JudgmentEngineState
  /** Diagnostic explaining a state other than `ready`. */
  readonly detail?: string
}

/** One engine as its provider registers it. */
export interface JudgmentEngineEntry {
  /** The engine that answers asks routed to this id. */
  readonly engine: JudgmentEngine
  /** Static facts about the engine. */
  readonly descriptor: JudgmentEngineDescriptor
  /**
   * Read the engine's current state. The provider calls
   * {@link JudgmentEngineRegistration.statusChanged} whenever the value changes.
   * @returns the current state and its detail.
   */
  status(): JudgmentEngineStatus
}

/** Disposer of one engine registration, carrying its status-change announcement. */
export interface JudgmentEngineRegistration {
  /** Remove the engine from the registry; repeated calls do nothing. */
  (): void
  /** Notify registry subscribers that {@link JudgmentEngineEntry.status} changed; does nothing once disposed. */
  statusChanged(): void
}
