# Typed Judgment

The typed-judgment seam of [shres-judgment](../../packages/llm/judgment) answers typed questions about one state — a choice between named options, a score along an ordered rubric, or a yes/no binary — and returns probabilities with a confidence figure. Consumers own every question string, threshold, and decision; a provider behind `ctx.judgment` owns tier selection, credentials, transport, and the validation of each provider response, so a distilled on-box engine is a composition swap behind the same contract.

Source: [`packages/llm/judgment/src/index.ts`](../../packages/llm/judgment/src/index.ts)

## Questions

A question is discriminated by `kind`, carries a consumer-chosen `id` unique within one ask, and states its `instructions`. A choice names its options, a score names its ordered levels, and a binary may describe what each of its two answers means. Asking several questions in one call is the normal form: the engine evaluates them against the same state.

```ts type-equiv
/** One typed question a judgment engine can answer. */
type JudgmentQuestion = JudgmentBinaryQuestion | JudgmentChoiceQuestion | JudgmentScoreQuestion
```

```ts type-equiv
/**
 * A yes/no question. The answer is the probability that it holds, which every
 * consumer thresholds itself — a provider never applies a cut-off.
 */
interface JudgmentBinaryQuestion {
  /** Discriminant selecting the binary question form. */
  kind: 'binary'
  /** Id the matching answer carries. */
  id: JudgmentQuestionId
  /** What to evaluate. */
  instructions: string
  /** Optional descriptions of the two answers, which sharpen a borderline state. */
  criteria?: JudgmentBinaryCriteria
}
```

```ts type-equiv
/** A question picking exactly one option from a set the consumer defines. */
interface JudgmentChoiceQuestion {
  /** Discriminant selecting the choice question form. */
  kind: 'choice'
  /** Id the matching answer carries. */
  id: JudgmentQuestionId
  /** What to decide. */
  instructions: string
  /** Options to decide among, at least two; each answer entry reports one probability. */
  options: JudgmentChoiceOption[]
}
```

```ts type-equiv
/**
 * A question rating the state along an ordered rubric. The answer is the
 * probability-weighted value across the levels, plus the distribution that
 * produced it.
 */
interface JudgmentScoreQuestion {
  /** Discriminant selecting the score question form. */
  kind: 'score'
  /** Id the matching answer carries. */
  id: JudgmentQuestionId
  /** What to rate. */
  instructions: string
  /** Ordered level descriptions from lowest to highest, at least two. */
  levels: string[]
}
```

`judgmentQuestionId(value)` brands a raw string as a question id, which keeps an id from being confused with an option key or a model id at a call site.

## Answers

Answers come back in the order the questions were asked, each carrying the id of the question it answers and the discriminant of that question's kind. A binary answer is one probability and carries no confidence: a provider derives confidence from a distribution, and a binary answer has none, so a consumer thresholds the probability itself. Choice and score answers carry the full distribution as well as the collapsed `confidence` and the answer's own value — the highest-probability option, or the probability-weighted score.

```ts type-equiv
/** One answer, discriminated by the kind of question it answers. */
type JudgmentAnswer = JudgmentBinaryAnswer | JudgmentChoiceAnswer | JudgmentScoreAnswer
```

```ts type-equiv
/** The probability that a binary question's answer is yes. */
interface JudgmentBinaryAnswer {
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
```

```ts type-equiv
/** The chosen option of a choice question and the distribution behind it. */
interface JudgmentChoiceAnswer {
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
```

```ts type-equiv
/** The weighted value of a score question and the distribution behind it. */
interface JudgmentScoreAnswer {
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
```

## One ask

An ask carries the state, the questions, an optional tier, and the caller's cancellation signal. `tier` is the seam's speed-against-accuracy axis: a provider maps each tier to its own model id, and an omitted tier resolves to `accurate` so silence never weakens a decision. The result reports one answer per question, the engine that served the ask, the exact model that answered — a provider serving tier aliases reports the id the alias resolved to — and the ask's wall-clock duration.

```ts type-equiv
/** One ask: the state every question is evaluated against, and the questions. */
interface JudgmentInput {
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
  /** Cancellation signal; an aborted ask fails with {@link JudgmentErrorCode} `ABORTED`. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** One ask's answers and the identity of what produced them. */
interface JudgmentResult {
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
```

## The engine contract

One provider registers per context as `ctx.judgment`. `ask` is the general consumer-facing contract; providers may also expose `fitting` when they can measure complete candidate states with the same tokenizer and model that will answer. Everything else a provider does — credentials, transport, wire validation — stays behind it.

`fitting.ask()` receives complete state alternatives in preference order. The provider redacts each candidate once, measures each complete question-and-state sequence and the padded batch against its verified limits, and judges the first candidate that fits. The returned `JudgmentTokenFit` records the selected text, index, token counts, applied limits, and artifact hash alongside the answers. When no candidate fits, the result is `unfit` and no model inference occurs. Consumers can use `ask()` when they already have one state or use `fitting` when choosing a state and judging it must be one atomic operation.

```ts type-equiv
/** Ordered complete state alternatives for one atomic capacity check and judgment. */
interface JudgmentFittingInput extends Omit<JudgmentInput, 'state'> {
  /** Most preferred first; providers select the first fitting state without truncation. */
  states: readonly string[]
}
```

```ts type-equiv
/** Effective tokenizer limits and the verified artifact that supplies them. */
interface JudgmentTokenLimits {
  /** Maximum tokens in each complete question and state sequence. */
  maxSequenceTokens: number
  /** Maximum tokens reserved for a question and its options. */
  maxHeadTokens: number
  /** Maximum padded tokens across the whole question batch. */
  maxBatchTokens: number
  /** SHA-256 of the verified model, tokenizer, and configuration manifest. */
  manifestSha256: string
}
```

```ts type-equiv
/** Exact input selected and measured before the corresponding inference. */
interface JudgmentTokenFit {
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
```

```ts type-equiv
/** Capacity that prevented all offered states from being judged. */
type JudgmentTokenLimitReason = 'state' | 'head' | 'option' | 'batch'
```

```ts type-equiv
/** One fitted judgment, or an explicit capacity rejection without inference. */
type JudgmentFittingResult =
  | { kind: 'answered'; fit: JudgmentTokenFit; result: JudgmentResult }
  | { kind: 'unfit'; engine: string; model: string; limits: JudgmentTokenLimits; reason: JudgmentTokenLimitReason }
```

```ts type-equiv
/** Optional provider capability that measures and judges with one pinned tokenizer and model. */
interface JudgmentFittingEngine {
  /**
   * Redact each alternative once, select the first fitting state, and judge it.
   * @param input - complete ordered states, common questions, tier, and cancellation signal.
   * @returns measured input and answers, or a capacity rejection without inference.
   * @throws JudgmentError with the same failure classes as {@link JudgmentEngine.ask}.
   */
  ask(input: JudgmentFittingInput): Promise<JudgmentFittingResult>
}
```

```ts type-equiv
/**
 * The judgment capability every provider implements. Implementations own
 * transport, credential resolution, and wire validation; consumers own every
 * question string, threshold, and decision made from an answer.
 */
interface JudgmentEngine {
  /** Exact tokenizer fitting when supported; absence leaves input sizing to the consumer. */
  readonly fitting?: JudgmentFittingEngine
  /**
   * Answer one set of typed questions about one state.
   * @param input - the state, the questions, the optional tier, and the cancellation signal.
   * @returns the answers with the engine and model identity and the ask's duration.
   * @throws JudgmentError for an unconfigured credential (`UNCONFIGURED`), an
   * unreachable or refusing provider (`UNAVAILABLE`), oversized serialized
   * input (`INPUT_TOO_LARGE`), an unusable provider
   * response (`INVALID_ANSWER`), or a cancelled ask (`ABORTED`).
   */
  ask(input: JudgmentInput): Promise<JudgmentResult>
}
```

## Redaction hook

`ctx.judgmentRedactor` is optional and interface-typed, and it has one home: the provider. When a deployment mounts one, every provider consults it exactly once per state candidate, before serialization, and sends what it returns; a consumer passes its composed state to `ctx.judgment.ask()` unredacted and does not consult the hook. A regular ask has one candidate; a fitting ask applies the same hook once to each offered candidate, so it remains the seam's single egress control over state text.

```ts type-equiv
/**
 * Optional egress hook with one home, the provider. A deployment that must not
 * send identifiable text to a judgment engine mounts one; every provider
 * consults it exactly once per state candidate, before serialization, and sends
 * what it returns. A consumer passes its state to `ctx.judgment.ask()`
 * unredacted and never consults the hook.
 */
interface JudgmentRedactor {
  /**
   * Replace the state one ask is about to send.
   * @param state - the state text an engine is about to receive.
   * @returns the text to send instead; return the input unchanged when nothing
   *   needs redaction.
   */
  redactState(state: string): string | Promise<string>
}
```

## Deployment settings

Mounting an engine installs the Definition-owned `judgment` settings namespace with the composition default `{ enabled: true }`; the toggle exists only where an engine does, and a configuration surface writes it through the settings seam. Consumers read it through the live source thunk the service exposes and treat `enabled: false` exactly as an absent engine, which reuses each consumer's own engine-absent path rather than adding a behavior mode. `judgmentEnabled(source)` reads `enabled` from that thunk. The engine itself never consults the toggle.

```ts type-equiv
/**
 * Deployment-level judgment settings, owned by the Definition's `judgment`
 * settings namespace. Consumers read the section live and treat
 * `enabled: false` exactly as an absent engine, so the toggle reuses their
 * existing degradation path instead of adding a second one.
 */
interface JudgmentSettings {
  /** Whether judgment is available to consumers in this deployment. */
  enabled: boolean
}
```

## Failure classes

A provider reports every failure as one `JudgmentError` whose `code` a consumer branches on: `UNCONFIGURED` for a credential that is missing or unresolvable, raised before any request; `UNAVAILABLE` for an engine that could not be reached, timed out, or refused the request; `INVALID_ANSWER` for a response that does not match the question kind or is malformed; and `ABORTED` for an ask the caller cancelled. No threshold, margin, or fallback lives in the seam.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjudgment--judgmentservice-abstract-seam"></a>

### `ctx.judgment` — `JudgmentService` (abstract seam)

Abstract judgment service. Load one implementation per context as `ctx.judgment`; it owns tier selection, credentials, transport, and the validation of every provider response it reads, and registers no session event, prompt, or tool of its own.

Mounting an engine installs the Definition-owned JUDGMENT_SETTINGS_NAMESPACE section, because the toggle exists only where an engine does. settings reads it live.

```ts cordis-catalog
/**
 * Answer one set of typed questions about one state. Answers come back in
 * the order the questions were asked, each carrying its question's id.
 * @param input - the state, the questions, the optional tier, and the cancellation signal.
 * @returns the answers with the engine and model identity and the ask's duration.
 * @throws {@link JudgmentError} for an unconfigured credential
 *   (`UNCONFIGURED`), an unreachable or refusing provider (`UNAVAILABLE`),
 *   oversized serialized input (`INPUT_TOO_LARGE`),
 *   an unusable provider response (`INVALID_ANSWER`), or a cancelled ask
 *   (`ABORTED`).
 */
abstract ask(input: JudgmentInput): Promise<JudgmentResult>
```

Source: [`packages/llm/judgment/src/index.ts:114`](../../packages/llm/judgment/src/index.ts)
<!-- END GENERATED cordis-surface -->
