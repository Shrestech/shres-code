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

An ask carries the state, the questions, an optional tier, the caller's cancellation signal, and an optional consumer id. `tier` is the seam's speed-against-accuracy axis: a provider maps each tier to its own model id, and an omitted tier resolves to `accurate` so silence never weakens a decision. The result reports one answer per question, the engine that served the ask, the exact model that answered — a provider serving tier aliases reports the id the alias resolved to — and the ask's wall-clock duration. A dispatcher routes the ask by its `consumer` id and stamps the result with `engineId`, the registry id of the engine that answered. An engine that answers through a `ctx.llm` route reports that request's `usage`, so a consumer that logs its decision can price the ask.

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
  /**
   * Local correlation facts for engines that key determinism or diagnostics on
   * the consult's session coordinates. Optional: non-session consumers omit
   * it, and an engine that needs it treats its absence as a failed ask rather
   * than falling back to another identity. Never transmitted off-machine.
   */
  correlation?: JudgmentCorrelation
}
```

```ts type-equiv
/**
 * Nominal id a consumer names itself with on each ask, such as
 * `worker-escalation`. The `judgment` settings `overrides` map is keyed by
 * it, so a deployment can route one consumer to a different engine.
 */
type JudgmentConsumerId = Branded<'JudgmentConsumerId'>
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
  /**
   * Registry id of the engine the dispatcher routed the ask to. Present on
   * every dispatched result; absent when a single-engine implementation served
   * `ctx.judgment` directly.
   */
  engineId?: JudgmentEngineId
  /**
   * Token usage of the model request the engine made for this ask, exactly as
   * the route's adapter reported it, so {@link TokenUsage}'s presence contract
   * holds: a cache count is present exactly when the provider reported it.
   * Absent when the engine made no model request through `ctx.llm` or its
   * route reported no usage. A consumer that logs its decision records this
   * value so the ask's own cost can be priced from the session log.
   */
  usage?: TokenUsage
}
```

## The engine contract

Every engine implements `JudgmentEngine`, and so does the service mounted as `ctx.judgment`. The engine providers are [`judgment-typesafe`](../../packages/llm/judgment-typesafe/README.md), which calls a remote engine, [`judgment-shield`](../../packages/llm/judgment-shield/README.md), which calls a deployment-run loopback gateway, and [`judgment-laya`](../../packages/llm/judgment-laya/README.md), which supervises a local laya-mlx gateway on Apple silicon; the last two share one Shield wire client. `ask` is the general consumer-facing contract; providers may also expose `fitting` when they can measure complete candidate states with the same tokenizer and model that will answer. Everything else a provider does — credentials, transport, wire validation — stays behind it.

Every provider meets one contract. It answers every asked question with an answer of its kind and gives a probability to every option of a choice question; an omitted option is `INVALID_ANSWER`. It reports `confidence` as a concentration measure its own documentation defines, so a threshold tuned on one engine's confidence does not transfer to another. It reports the exact model that answered and the ask's `latencyMs`, honours `input.signal` at every await as the cancellation paragraph below requires, consults the redaction hook exactly once per state, and repeats a request only under a retry policy it documents. Its registry descriptor declares `egress`, `calibration`, and `supportsFitting` truthfully: `egress: 'local'` only for an engine whose requests stay on this machine, and `calibration: 'verbalized'` for probabilities a model states as text rather than a calibrated classifier or token log-probabilities produce.

`fitting.ask()` receives complete state alternatives in preference order. The provider redacts each candidate once, measures each complete question-and-state sequence and the padded batch against its verified limits, and judges the first candidate that fits. The returned `JudgmentTokenFit` records the selected text, index, token counts, applied limits, and artifact hash alongside the answers. When no candidate fits, the result is `unfit` and no model inference occurs. Consumers can use `ask()` when they already have one state or use `fitting` when choosing a state and judging it must be one atomic operation.

Both `ask()` and `fitting.ask()` must honour `input.signal` at every await — credential resolution, redaction, retry waits, the request, and the response read — and settle promptly with `ABORTED` once it aborts. A consumer's deadline depends on this: the model router combines the turn's signal with `judgmentDeadlineMs`, and its deadline always bounds the answer it uses, but bounds its wait only when the engine aborts on the combined signal.

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
  | {
    kind: 'unfit'
    engine: string
    model: string
    limits: JudgmentTokenLimits
    reason: JudgmentTokenLimitReason
    /** Registry id of the engine a dispatcher routed the fitted ask to, as on {@link JudgmentResult}. */
    engineId?: JudgmentEngineId
  }
```

```ts type-equiv
/** Optional provider capability that measures and judges with one pinned tokenizer and model. */
interface JudgmentFittingEngine {
  /**
   * Redact each alternative once, select the first fitting state, and judge it.
   * Honours `input.signal` as {@link JudgmentInput.signal} requires.
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
 *
 * A provider's `ask` answers every asked question with an answer of its
 * kind and gives a probability to every option of a choice question; an
 * omitted option is `INVALID_ANSWER`. It reports `confidence` as a
 * concentration measure its own documentation defines, the exact answering
 * `model`, and the ask's `latencyMs`. It honours `input.signal` at every
 * await as {@link JudgmentInput.signal} requires, consults
 * `ctx.judgmentRedactor` exactly once per state, and repeats a request only
 * under a retry policy it documents. Its registry descriptor declares
 * `egress`, `calibration`, and `supportsFitting` truthfully.
 */
interface JudgmentEngine {
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
```

## Engines and dispatch

A deployment mounts [judgment-dispatch](../../packages/llm/judgment-dispatch) as `ctx.judgment`. The dispatcher provides `ctx.judgmentEngines`, a registry where each engine provider registers one engine under a stable id — `typesafe`, `shield`, `laya`, and `llm:<provider>/<model>` for [judgment-llm](../../packages/llm/judgment-llm) — through `registerJudgmentEngine`, which ties the registration to the provider's fiber. The registry selects nothing; its subscribers are notified after every registration, removal, and announced status change, and a failing subscriber is logged without reaching the caller.

Every ask goes to exactly one engine: the `judgment.overrides` entry for the ask's `consumer` when that consumer has declared its id, else `judgment.engine`, whose composition default is the dispatcher's required `defaultEngine`. The dispatcher never answers with a different engine. A selection no provider registered fails `UNCONFIGURED`, and a registered engine whose status is not `ready` fails `UNAVAILABLE` with the status detail, so each consumer takes its own engine-unavailable path instead of reading an answer made under another engine's calibration. `fitting` is present while the deployment-wide selection supports it, and a fitted ask whose consumer override selects an engine without fitting fails `UNAVAILABLE`. A consumer reads the engine it would be routed to with `ctx.judgment.selectedEngine(consumer)` and its fitting capability with `ctx.judgment.fittingFor(consumer)`; a single-engine implementation selects nothing and answers every consumer with its own `fitting`.

A consumer declares the id its asks carry with `declareJudgmentConsumer(ctx, id)`, which registers the id in `ctx.judgmentEngines` for the consumer's lifetime; `worker-escalation`, `compaction-jev`, and `judgment-guardrails` declare themselves, and the model router declares `model-router` once its asks carry that id. An override is valid only for a declared consumer, so an override that would silently leave a consumer's asks on the default engine is refused instead.

Configuration surfaces read the registry through the dispatcher's `judgmentEngines` Remote: `snapshot()` lists every engine with its descriptor facts and current status, the resolved selection, and the declared consumer ids, and the `judgment/engines-updated` event announces each change that would alter the snapshot. The engine selector in Settings › Model routing and the Routing view's engine status line both read it; see the [dispatcher README](../../packages/llm/judgment-dispatch/README.md#configuration-surfaces).

Live-service checks apply only to what a configuration write changes: a write that changes `engine`, or adds or changes an override, is rejected naming that field when it names an unregistered engine, an engine whose descriptor names another host, or an undeclared consumer; entries the write leaves unchanged are not re-judged. A document the settings file loads or reloads is applied as written, because rejecting a file edit for the state of live services would leave the previous engine answering with no visible sign. An unregistered selection then fails its asks with `UNCONFIGURED`, with no fallback, and an undeclared consumer's override is ignored. Once the Loader settles, the dispatcher logs each such condition once at error level, again whenever a later change introduces one, and at info level when it resolves.

```ts type-equiv
/** Nominal id of one engine registered in `ctx.judgmentEngines`, such as `typesafe` or `shield`. */
type JudgmentEngineId = Branded<'JudgmentEngineId'>
```

```ts type-equiv
/** Static facts about one registered engine, which a configuration surface shows before selection. */
interface JudgmentEngineDescriptor {
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
  /**
   * Model or pinned artifact id that answers each tier, for configuration
   * surfaces; omission means the provider does not name one before an ask.
   */
  readonly models?: Readonly<Record<JudgmentTier, string>>
  /**
   * Host (and port) the engine sends state to, for configuration surfaces'
   * egress notices; omission means the provider does not name one, and an
   * engine with egress `none` names none.
   */
  readonly destination?: string
}
```

```ts type-equiv
/**
 * Where an engine sends the state it judges: `none` keeps it within the
 * harness process and processes the engine's provider supervises on this
 * machine, `local` sends it to a service on this machine that the deployment
 * runs, and `remote` sends it off this machine — to a third party or to any
 * other host, including one on the local network.
 */
type JudgmentEngineEgress = 'none' | 'local' | 'remote'
```

```ts type-equiv
/**
 * How an engine produces its probabilities: `calibrated` from a classifier
 * trained to output them, `logprob` from a generative model's token
 * log-probabilities, and `verbalized` from numbers a generative model writes out.
 * Thresholds do not transfer between engines of different calibration.
 */
type JudgmentEngineCalibration = 'calibrated' | 'logprob' | 'verbalized'
```

```ts type-equiv
/** Host an engine can run on: one platform-architecture pair, or `any`. */
type JudgmentEngineHost = 'darwin-arm64' | 'any'
```

```ts type-equiv
/** Current state of one registered engine. */
interface JudgmentEngineStatus {
  /** Lifecycle state. */
  readonly state: JudgmentEngineState
  /** Diagnostic explaining a state other than `ready`. */
  readonly detail?: string
}
```

```ts type-equiv
/**
 * Lifecycle state of one registered engine. Only `ready` answers asks; every
 * other state makes a dispatched ask fail `UNAVAILABLE` with the state's detail.
 */
type JudgmentEngineState = 'ready' | 'starting' | 'unavailable' | 'unconfigured' | 'not-installed' | 'unsupported-host'
```

```ts type-equiv
/** One engine as its provider registers it. */
interface JudgmentEngineEntry {
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
```

```ts type-equiv
/** Disposer of one engine registration, carrying its status-change announcement. */
interface JudgmentEngineRegistration {
  /** Remove the engine from the registry; repeated calls do nothing. */
  (): void
  /** Notify registry subscribers that {@link JudgmentEngineEntry.status} changed; does nothing once disposed. */
  statusChanged(): void
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

The service mounted as `ctx.judgment` installs the Definition-owned `judgment` settings namespace, and a configuration surface writes it through the settings seam. Under `judgment-dispatch` its composition layer is `{ enabled: true, engine: <defaultEngine> }`; a single-engine implementation mounted directly installs `{ enabled: true }`. Consumers read the section through the live source thunk the service exposes and treat `enabled: false` exactly as an absent engine, which reuses each consumer's own engine-absent path rather than adding a behavior mode. `judgmentEnabled(source)` reads `enabled` from that thunk, and no engine consults the toggle.

`engine` selects the deployment-wide engine and `overrides` maps a consumer id to the engine for that consumer's asks. An empty id, or an id key written without a value, is rejected by field name; a valueless `overrides` key means no overrides. The consumers that name themselves are `worker-escalation`, `compaction-jev`, and `judgment-guardrails`. A configuration write is additionally checked against live services for the fields it changes, and a loaded or reloaded file is not; see [Engines and dispatch](#engines-and-dispatch).

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
```

## Failure classes

An engine reports every failure as one `JudgmentError` whose `code` a consumer branches on: `UNCONFIGURED` for a credential that is missing or unresolvable, raised before any request, and for a selected engine no provider registered; `UNAVAILABLE` for an engine that could not be reached, timed out, refused the request, or is not `ready`; `INPUT_TOO_LARGE` for serialized input over the engine's request limit; `INVALID_ANSWER` for a response that does not match the question kind or is malformed; and `ABORTED` for an ask the caller cancelled. A dispatched failure also carries `engineId`, the registry id of the engine the ask was routed to, and a dispatcher's own refusal before dispatch carries `refusedBeforeDispatch: true`: nothing left the process. No threshold, margin, or fallback lives in the seam.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjudgment--judgmentservice-abstract-seam"></a>

### `ctx.judgment` — `JudgmentService` (abstract seam)

Abstract judgment service. Load one implementation per context as `ctx.judgment`. A deployment loads `judgment-dispatch`, which routes each ask to a registered engine; a test can load a single-engine implementation directly. The service registers no session event, prompt, or tool of its own.

The service installs the Definition-owned JUDGMENT_SETTINGS_NAMESPACE section, because the toggle and the engine selection exist only where `ctx.judgment` does. settings reads it live.

```ts cordis-catalog
/**
 * The fitting capability that answers one consumer's fitted asks. A
 * dispatcher answers with the engine it selects for `consumer`, so a consumer
 * that names itself reads its fitting here rather than from {@link fitting},
 * which follows the deployment-wide selection. A single-engine
 * implementation answers every consumer with {@link fitting}.
 * @param _consumer - the asking consumer; omission reads the deployment-wide selection.
 * @returns the fitting capability, or `undefined` when the engine answering this consumer has none.
 */
fittingFor(_consumer?: JudgmentConsumerId): JudgmentFittingEngine | undefined

/**
 * The registry id of the engine that answers one consumer's asks, read
 * before an ask so a consumer can attribute its own state to an engine. A
 * single-engine implementation selects nothing and returns `undefined`.
 * @param _consumer - the asking consumer; omission reads the deployment-wide selection.
 * @returns the selected registry id, or `undefined` when this service does not select engines.
 */
selectedEngine(_consumer?: JudgmentConsumerId): JudgmentEngineId | undefined

/**
 * Answer one set of typed questions about one state. Answers come back in
 * the order the questions were asked, each carrying its question's id. An
 * implementation must honour `input.signal` at every await, settling
 * promptly with `ABORTED` once it aborts: a consumer's deadline bounds the
 * answer it uses, but bounds its wait only when the engine aborts.
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

Source: [`packages/llm/judgment/src/index.ts:281`](../../packages/llm/judgment/src/index.ts)

<a id="ctxjudgmentengines--judgmentengineregistry"></a>

### `ctx.judgmentEngines` — `JudgmentEngineRegistry`

Engines a deployment composes, keyed by id, and the consumer ids that name themselves on their asks. Registration is all-or-nothing and synchronous; subscribers are notified after every engine registration, removal, and announced status change, and when a consumer id becomes declared or stops being declared, and re-read list, consumers, and each entry's `status()` themselves.

```ts cordis-catalog
/**
 * Register one engine. Call it inside the provider's `ctx.effect` so the
 * returned disposer runs with the provider's fiber.
 * @param id - the engine's registry id.
 * @param entry - the engine, its descriptor, and its status read.
 * @returns the disposer, carrying the status-change announcement.
 * @throws Error when the descriptor names another id, when
 *   `supportsFitting` disagrees with the engine's `fitting` capability, or
 *   when the id is already registered.
 */
register(id: JudgmentEngineId, entry: JudgmentEngineEntry): JudgmentEngineRegistration

/**
 * Describe every registered engine.
 * @returns the descriptors, in registration order.
 */
list(): readonly JudgmentEngineDescriptor[]

/**
 * Read every registered engine with its status reader.
 * @returns the entries, in registration order.
 */
entryList(): readonly JudgmentEngineEntry[]

/**
 * Look up one registered engine.
 * @param id - the registry id.
 * @returns the entry, or `undefined` when no provider registered the id.
 */
get(id: JudgmentEngineId): JudgmentEngineEntry | undefined

/**
 * Declare that a consumer names itself with `id` on its asks, so a
 * per-consumer override for it has an effect. Call it inside the consumer's
 * `ctx.effect` so the returned disposer runs with the consumer's fiber;
 * {@link declareJudgmentConsumer} does that. Several live declarations of one
 * id are allowed, and the id stays declared until every one is disposed.
 * @param id - the consumer id the consumer's asks carry.
 * @returns the disposer ending this declaration; repeated calls do nothing.
 */
declareConsumer(id: JudgmentConsumerId): () => void

/**
 * Whether a consumer currently names itself with `id` on its asks.
 * @param id - the consumer id.
 * @returns true while at least one declaration of the id is live.
 */
hasConsumer(id: string): boolean

/**
 * List the declared consumer ids.
 * @returns the ids, in first-declaration order.
 */
consumers(): readonly JudgmentConsumerId[]

/**
 * Observe registrations, removals, and announced status changes.
 * @param listener - called after each change; what it throws or rejects
 *   with is reported and does not reach the caller that caused the change.
 * @returns the disposer ending this subscription.
 */
subscribe(listener: () => unknown): () => void
```

Source: [`packages/llm/judgment/src/registry.ts:35`](../../packages/llm/judgment/src/registry.ts)

<a id="judgment-events"></a>

### `judgment/*` events

<a id="judgmentengines-updated--emit"></a>

#### `judgment/engines-updated` — emit

The judgment engine view changed: an engine registered, unregistered, or announced a status change, a consumer id became declared or stopped being declared, or the `judgment` settings selection committed a new value. This payload-free notification comes from the service mounted as `ctx.judgment`; listeners re-read the engine list and selection.

```ts cordis-catalog
/**
 * The judgment engine view changed: an engine registered, unregistered,
 * or announced a status change, a consumer id became declared or stopped
 * being declared, or the `judgment` settings selection committed a new
 * value. This payload-free notification comes from the service mounted as
 * `ctx.judgment`; listeners re-read the engine list and selection.
 * @mode emit
 */
'judgment/engines-updated'(): void
```

Source: [`packages/llm/judgment/src/types.ts:24`](../../packages/llm/judgment/src/types.ts)
<!-- END GENERATED cordis-surface -->
