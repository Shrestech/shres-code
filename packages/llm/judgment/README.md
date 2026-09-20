# @shres-code/shres-code-judgment

Service Definition for the typed-judgment capability seam: typed questions in, calibrated answers out. A consumer asks about one state — a choice between named options, a score along an ordered rubric, or a yes/no binary — and reads back probabilities with a confidence figure. Consumers own every question string, threshold, and decision; providers own transport, credential resolution, and wire validation. Nothing here is vendor-specific: no HTTP, no session event, no prompt text.

## Service API

One provider registers per context as `ctx.judgment` by subclassing the default export. Consumers reach it as `ctx.judgment.ask(input)`.

```ts
interface JudgmentInput {
  state: string
  questions: readonly JudgmentQuestion[]
  tier?: 'fast' | 'accurate'
  signal?: AbortSignal
}

interface JudgmentResult {
  answers: readonly JudgmentAnswer[]
  engine: string
  model: string
  latencyMs: number
}
```

Answers come back in the order the questions were asked, each carrying its question's `id`. An omitted `tier` resolves to `accurate`: the cheap tier is an explicit optimization, so silence must not weaken a decision. `engine` names the provider that served the ask and `model` the exact model that answered — a provider serving tier aliases reports the model id the alias resolved to, which is what makes an answer reproducible from a log.

Every failure is one `JudgmentError` whose `code` a consumer branches on: `UNCONFIGURED` (no usable credential, thrown before any request), `UNAVAILABLE` (the engine could not be reached or refused the request), `INVALID_ANSWER` (the response did not match the question kind or was malformed), and `ABORTED` (the ask was cancelled through `input.signal`).

## Settings

Mounting an engine installs the Definition-owned `judgment` settings namespace with the composition default `{ enabled: true }`; the toggle exists only where an engine does, so the section appears and disappears with it. A configuration surface writes it through the settings seam like any other section — the schema is `{ enabled: boolean }`.

```ts
interface JudgmentSettings {
  enabled: boolean
}
```

Consumers read the section live and treat `enabled: false` exactly as an absent engine:

```ts
if (!judgmentEnabled(ctx.judgment.settings)) return { kind: 'engine-absent' }
```

`ctx.judgment.settings` is the live source thunk — the resolved user layer while a settings service is attached, the composition default otherwise — and `judgmentEnabled(source)` reads `enabled` from it. Nothing is cached and nothing re-registers on a change, so a committed edit reaches the next decision.

The engine itself never consults the toggle: an ask answers whenever the engine is mounted. Turning judgment off is the consumers' documented off-position, which is what keeps the switch from introducing a third behavior mode next to the consumers' existing engine-absent and engine-erroring paths.

## Question vocabulary

A question is one of three kinds, discriminated by `kind`, each with an `instructions` string and a consumer-chosen `id`:

- `binary` — a yes/no question, with optional `criteria.yes` and `criteria.no` descriptions that sharpen a borderline state.
- `choice` — a decision among named `options`, at least two, each with an optional rubric `description`.
- `score` — a rating along ordered `levels`, at least two descriptions from lowest to highest.

`judgmentQuestionId(value)` brands a raw string as a question id, which keeps an id from being confused with an option key or a model id at a call site.

## Answers

`binary` answers carry `probability` (0 is no, 1 is yes) and no confidence: a provider derives confidence from a distribution, and a binary answer has none — threshold the probability itself. `choice` answers carry the highest-probability `option`, the full `probabilities` map keyed by option, and `confidence`. `score` answers carry the probability-weighted `score`, the `probabilities` map keyed by each level's zero-based index as a decimal string, and `confidence`.

No threshold lives here. Probabilities can be borderline and are not deterministic across identical asks, so every consumer sets its own margin — and a threshold tuned on one question kind does not transfer to another.

## Redaction hook

`ctx.judgmentRedactor` is optional and interface-typed: a deployment mounts one service implementing `JudgmentRedactor` when state text must be rewritten before it leaves the process. The hook has one home, the provider. Every provider consults it exactly once per ask, before the state is serialized, and sends what it returns. A consumer passes its composed state to `ctx.judgment.ask()` unredacted and does not consult the hook, so a composed redactor runs exactly once per ask however many consumers a deployment composes.

```ts
interface JudgmentRedactor {
  redactState(state: string): string | Promise<string>
}
```

## Providers

A provider is one package per engine, mounted as `ctx.judgment` in composition:

```yaml
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

## Known Limitations and Deferred Work

- **The toggle gates consumers, not the engine** — `ctx.judgment.ask` answers while the engine is mounted regardless of `judgment.enabled`; a consumer reads the toggle itself and takes its own engine-absent path. A deployment that wants the engine physically out of the composition withdraws the plugin instead.
- **Consumer decisions are out of scope** — the seam reports probabilities and confidence and applies no threshold, margin, or fallback. A consumer that acts on an answer owns the band it treats as safe, and thresholds do not transfer between question kinds.
- **State is text** — `JudgmentInput.state` is a string, so a consumer with structured state serializes it itself. Sending the engine a JSON object or an array of text values directly is deferred until a consumer needs it.
- **The redaction hook covers state only** — question instructions, criteria, options, and levels are consumer-authored and pass through unchanged, and nothing here caps their size. A deployment that must bound egress caps the state it builds.
- **No session event** — an ask is a model request a consumer made, not a session-log record: nothing in this package emits, replays, or persists. A consumer that must reconstruct why it asked logs its own decision.
- **Confidence is the provider's statistic** — the seam carries the provider's `confidence` value as-is and defines no own measure. Providers differ in how they derive it, so a consumer tuning a threshold does so against one provider.
