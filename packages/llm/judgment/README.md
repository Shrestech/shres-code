# @shres-code/shres-code-judgment

Service Definition for the typed-judgment capability seam: typed questions in, probabilistic answers out. A consumer asks about one state — a choice between named options, a score along an ordered rubric, or a yes/no binary — and reads back probabilities with a confidence figure. Consumers own every question string, threshold, and decision; providers own transport, credential resolution, and wire validation. Nothing here is vendor-specific: no HTTP, no session event, no prompt text.

## Service API

One service registers per context as `ctx.judgment`. In a deployment that service is [judgment-dispatch](../judgment-dispatch/README.md), which routes each ask to one engine registered in `ctx.judgmentEngines` (see [Engines](#engines)); a test can mount a single-engine subclass of the default export directly. Consumers reach it as `ctx.judgment.ask(input)`.

```ts
import type {
  JudgmentAnswer,
  JudgmentConsumerId,
  JudgmentEngineId,
  JudgmentQuestion,
} from '@shres-code/shres-code-judgment'
import type { TokenUsage } from '@shres-code/shres-code-llm'

interface JudgmentInput {
  state: string
  questions: readonly JudgmentQuestion[]
  tier?: 'fast' | 'accurate'
  signal?: AbortSignal
  consumer?: JudgmentConsumerId
}

interface JudgmentResult {
  answers: readonly JudgmentAnswer[]
  engine: string
  model: string
  latencyMs: number
  engineId?: JudgmentEngineId
  usage?: TokenUsage
}
```

Answers come back in the order the questions were asked, each carrying its question's `id`. An omitted `tier` resolves to `accurate`: the cheap tier is an explicit optimization, so silence must not weaken a decision. `engine` names the provider that served the ask and `model` the exact model that answered — a provider serving tier aliases reports the model id the alias resolved to, which is what makes an answer reproducible from a log. `consumer` names the asking consumer (`judgmentConsumerId(value)` brands it) so a dispatcher can apply a per-consumer engine override, and `engineId` is the registry id of the engine a dispatcher routed the ask to. `usage` is the token usage of the model request an engine made through `ctx.llm` for the ask, exactly as that route's adapter reported it, so `TokenUsage`'s presence contract holds: a cache count is present exactly when the provider reported it, and consumers read it through `cacheCount`. An engine that made no such request, or whose route reported no usage, omits it.

Every failure is one `JudgmentError` whose `code` a consumer branches on: `UNCONFIGURED` (no usable credential, thrown before any request, or a selected engine no provider registered), `UNAVAILABLE` (the engine could not be reached, refused the request, or is not `ready`), `INPUT_TOO_LARGE` (the complete serialized input exceeds a provider limit before transport), `INVALID_ANSWER` (the response did not match the question kind or was malformed), and `ABORTED` (the ask was cancelled through `input.signal`). A failure the dispatcher routed carries `engineId`, the registry id of the engine the ask went to, as an answer does, and a failure the dispatcher raised itself before dispatching the ask carries `refusedBeforeDispatch: true`.

## Atomic fitting

Some providers expose `ctx.judgment.fitting`. Its `ask()` method accepts `states`, an ordered list of complete alternatives, with the preferred state first. The provider redacts each candidate exactly once, measures the complete question-and-state sequences and padded batch with one pinned tokenizer, and judges the first candidate that satisfies its verified sequence, head, option, and batch limits. It does not truncate a candidate or run inference for a candidate that fails a limit.

An answered result reports the selected index and exact redacted state, state and sequence token counts, padded-token count, applied limits, and the model result. The limits include the SHA-256 of the verified model, tokenizer, and configuration manifest, so the selected input can be tied to the artifact that measured it. If no candidate fits, the result is `unfit` with the engine, model, limits, and capacity reason; it is an explicit capacity outcome rather than a judgment answer or a `JudgmentError`.

The capability is optional. Consumers that require atomic state selection check `ctx.judgment.fitting` and handle `unfit` explicitly; a provider that only implements `ask()` leaves input sizing to the consumer. Both methods share the same questions, tier, cancellation, answer ordering, and provider failure classes.

## Correlation

An ask may carry `correlation` — the consult's `sessionId` and a consumer-defined `consultKey` that is unique per consult within the session (the model router sends `turn:<n>/step:<n>`; the 13b child listener sends `child:<routeRequestId>`). The field is informational: an engine may use it for local determinism — a stateless per-consult draw that replays from the log — or diagnostics, and must never transmit it in any request, credentialed call, or log sent off-machine; it is not part of any serialized model input. It is optional: non-session consumers omit it, and an engine that requires it treats its absence as a failed ask rather than falling back to another identity.

## Engines

`ctx.judgmentEngines` is a `JudgmentEngineRegistry` that [judgment-dispatch](../judgment-dispatch/README.md) provides. An engine provider injects `judgmentEngines` and registers one engine from its constructor with `registerJudgmentEngine(ctx, entry)`; the registration is released with the provider's fiber, and the returned function announces a status change to the registry's subscribers. An engine honours `input.signal` at every await: `throwIfJudgmentAborted(signal, message)` is the check before each step, and `abortableJudgmentStep(operation, signal, message)` races same-process work that cannot be cancelled, such as a credential lookup or the redaction hook, so the ask fails `ABORTED` at once.

```ts
import type {
  JudgmentEngine,
  JudgmentEngineDescriptor,
  JudgmentEngineStatus,
} from '@shres-code/shres-code-judgment'

interface JudgmentEngineEntry {
  engine: JudgmentEngine
  descriptor: JudgmentEngineDescriptor // id, label, egress, calibration, supportsFitting, host?, terms?
  status(): JudgmentEngineStatus // ready | starting | unavailable | unconfigured | not-installed | unsupported-host
}
```

`judgmentEngineId(value)` brands a registry id. The registry rejects a descriptor whose `id` differs from the registered id, a `supportsFitting` flag that disagrees with the engine's `fitting`, and a second registration of one id. The shipped registry ids are `typesafe` ([judgment-typesafe](../judgment-typesafe/README.md), remote), `shield` ([judgment-shield](../judgment-shield/README.md), a deployment-run local gateway), and `laya` ([judgment-laya](../judgment-laya/README.md), a supervised laya-mlx gateway on Apple silicon).

A consumer that names itself on its asks calls `declareJudgmentConsumer(ctx, id)` once; the id is declared in `ctx.judgmentEngines` while both the consumer and the registry are mounted, and the dispatcher accepts a `judgment.overrides` key only for a declared id. The registry reports declarations through `hasConsumer(id)` and `consumers()`, and notifies its subscribers when an id becomes declared or stops being declared.

## Settings

The service mounted as `ctx.judgment` installs the Definition-owned `judgment` settings namespace, so the section appears and disappears with it. Under `judgment-dispatch` its composition layer is `{ enabled: true, engine: <defaultEngine> }`; a single-engine subclass mounted directly installs `{ enabled: true }`. A configuration surface writes it through the settings seam like any other section.

```ts
interface JudgmentSettings {
  enabled: boolean
  engine?: string
  overrides?: Readonly<Record<string, string>> | null
}
```

`engine` selects the engine for every ask and `overrides` selects one per consumer id. An empty engine id, or an id key written without a value, fails the write by field name; the dispatcher additionally rejects an engine no provider registered.

Consumers read the section live and treat `enabled: false` exactly as an absent engine:

```ts
import { judgmentEnabled } from '@shres-code/shres-code-judgment'
import type { Context } from '@shres-code/cordis'

function judgmentAvailability(ctx: Context): 'available' | 'engine-absent' {
  const engine = ctx.get('judgment')
  return engine !== undefined && judgmentEnabled(engine.settings) ? 'available' : 'engine-absent'
}
```

`ctx.judgment.settings` is the live source thunk — the resolved user layer while a settings service is attached, the composition default otherwise — and `judgmentEnabled(source)` reads `enabled` from it. Nothing is cached and nothing re-registers on a change, so a committed edit reaches the next decision.

No engine consults the toggle: an ask answers whenever the service is mounted. Turning judgment off is the consumers' documented off-position, which is what keeps the switch from introducing a third behavior mode next to the consumers' existing engine-absent and engine-erroring paths.

## Question vocabulary

A question is one of three kinds, discriminated by `kind`, each with an `instructions` string and a consumer-chosen `id`:

- `binary` — a yes/no question, with optional `criteria.yes` and `criteria.no` descriptions that sharpen a borderline state.
- `choice` — a decision among named `options`, at least two, each with an optional rubric `description`.
- `score` — a rating along ordered `levels`, at least two descriptions from lowest to highest.

`judgmentQuestionId(value)` brands a raw string as a question id, which keeps an id from being confused with an option key or a model id at a call site.

## Answers

`binary` answers carry `probability` (0 is no, 1 is yes) and no confidence: a provider derives confidence from a distribution, and a binary answer has none — threshold the probability itself. `choice` answers carry the highest-probability `option`, the full `probabilities` map keyed by option, and `confidence`. `score` answers carry the probability-weighted `score`, the `probabilities` map keyed by each level's zero-based index as a decimal string, and `confidence`.

Probability calibration is specific to the model, question, and task distribution; the service does not guarantee it. No threshold lives here. Probabilities can be borderline and are not deterministic across identical asks, so every consumer sets its own margin — and a threshold tuned on one question kind does not transfer to another.

## Redaction hook

`ctx.judgmentRedactor` is optional and interface-typed: a deployment mounts one service implementing `JudgmentRedactor` when state text must be rewritten before it leaves the process. The hook has one home, the provider. Every provider consults it exactly once per state candidate, before serialization, and sends what it returns. A regular ask has one candidate; an atomic fitting ask applies the same hook once to each offered candidate. A consumer passes its composed state to `ctx.judgment.ask()` unredacted and does not consult the hook.

```ts
interface JudgmentRedactor {
  redactState(state: string): string | Promise<string>
}
```

## Providers

A provider is one package per engine, registered in `ctx.judgmentEngines`; a composition mounts the dispatcher and names the default engine:

```yaml
- name: '@shres-code/shres-code-judgment-dispatch'
  config:
    defaultEngine: typesafe
- name: '@shres-code/shres-code-judgment-typesafe'
  config:
    apiKeyRef: TYPESAFE_API_KEY
```

The engine model is a deployment choice, so it is validated `Config` on the provider rather than a constant here; the question text is a consumer choice, so it lives in the consuming package. That split is what makes a distilled on-box engine a composition swap behind an unchanged contract.

## Model Experience

### Judgment ask

#### What the model sees

The judgment model receives `state` and the typed questions the consumer supplied — each question's `instructions` and its criteria, options, or levels — in one request. This package adds no prompt prose: every model-visible string is consumer-owned, and the question id stays transport metadata that the engine never sends as text.

#### Token effect

The state plus the question text is the ask's input, charged at the engine's input rate; a longer state costs more without changing the answers' meaning. Answers are the engine's output tokens. This package adds no text of its own.

#### KV Cache effect

Independent model request: the ask neither reads nor extends a conversation prefix, and nothing here appends to a later model request. Repeating an identical state and question set may reuse the engine's own prefix cache, which is a property of the engine and its provider, not of this package.

### Redacted state

#### What the model sees

When a deployment mounts `ctx.judgmentRedactor`, the state the engine receives is what that hook returned from the provider's one consult, not what the consumer passed. Question text is not passed through the hook.

#### Token effect

The redacted text is what the engine tokenizes, so a shorter replacement lowers the ask's input tokens. A hook that returns the input unchanged has no effect.

#### KV Cache effect

Redaction rewrites text inside one independent ask. It can change the engine's own prefix reuse for that ask and does not touch any conversation prefix.

### Fitted state

#### What the model sees

An atomic fitting ask sends only the first complete candidate that satisfies the provider's pinned limits. The model sees the redacted selected state and the consumer's questions; if every candidate exceeds capacity, no model request is made.

#### Token effect

The provider measures each candidate before inference and returns the selected state and counts. A candidate rejected for capacity contributes no output tokens, and the `unfit` result tells the consumer why no state was judged.

#### KV Cache effect

Fitting measures alternatives within one independent judgment operation. It does not append a conversation prefix or promise cache reuse between candidates.

## Known Limitations and Deferred Work

- **The toggle gates consumers, not the engine** — `ctx.judgment.ask` answers while the service is mounted regardless of `judgment.enabled`; a consumer reads the toggle itself and takes its own engine-absent path. A deployment that wants the engine physically out of the composition withdraws the plugin instead.
- **Consumer decisions are out of scope** — the seam reports probabilities and confidence and applies no threshold, margin, or fallback. A consumer that acts on an answer owns the band it treats as safe, and thresholds do not transfer between question kinds.
- **State is text** — `JudgmentInput.state` is a string, so a consumer with structured state serializes it itself. Sending the engine a JSON object or an array of text values directly is deferred until a consumer needs it.
- **Engine status is provider-reported** — `typesafe` reports whether its credential reference resolves but not whether the vendor endpoint answers, `shield` reports whether its gateway accepts a TCP connection, `laya` reports its supervised gateway's lifecycle through `status()`, and the `llm:<provider>/<model>` engine reports whether its `ctx.llm` route resolves.
- **Fitting is provider-optional** — `JudgmentEngine.fitting` is absent when a provider cannot measure and judge atomically. Consumers that need ordered candidate selection must handle an absent capability and the explicit `unfit` capacity result.
- **The redaction hook covers state only** — question instructions, criteria, options, and levels are consumer-authored and pass through unchanged, and nothing here caps their size. A deployment that must bound egress caps the state it builds.
- **No session event** — an ask is a model request a consumer made, not a session-log record: nothing in this package emits, replays, or persists. A consumer that must reconstruct why it asked logs its own decision.
- **Confidence is the provider's statistic** — the seam carries the provider's `confidence` value as-is and defines no own measure. Providers differ in how they derive it, so a consumer tuning a threshold does so against one provider.
