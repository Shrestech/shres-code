# @shres-code/shres-code-judgment-typesafe

TypeSafe AI "System One" judgment provider for the typed-judgment seam (`ctx.judgment`). One ask posts the state and the typed questions to the vendor's `/v1/systemone` endpoint over raw `fetch`, and the vendor answers with probabilities instead of text: a `noul` probability for a binary question, an option distribution for a choice question, and a weighted score for a score question.

The engine owns transport, credential resolution, tier-to-model mapping, and the validation of the one untyped input it reads — the response body. It adds no prompt prose, no session event, and no tool: every question string, threshold, and decision belongs to the consuming package. The request path, headers, and body follow the vendor's documented API.

There is no retry, no backoff, and no streaming in this provider. A 429 or 529 response arrives as `UNAVAILABLE`, and the caller owns any retry policy.

## Config

Every field is validated at plugin load, and unrecognized keys fail load by name.

| Key | Default | Effect |
|---|---|---|
| `apiKeyRef` | required | Credential reference (environment-variable name) holding the API key. There is no default: which reference holds the key is the deployment's decision. It is resolved through `ctx.credentials` on **every** ask and cached nowhere, so a rotated key reaches the next ask without a restart. |
| `endpoint` | `https://api.typesafe.ai` | Vendor endpoint base; a trailing slash is dropped. Requests go to `{endpoint}/v1/systemone`. |
| `models.fast` | `jev-preview` | Model id serving the `fast` tier. |
| `models.accurate` | `jev-latest` | Model id serving the `accurate` tier, and every ask that omits a tier. |
| `timeoutMs` | `30000` | Deadline for one vendor request, in milliseconds. An ask that outlives it fails with `UNAVAILABLE` naming the figure. Must be a positive finite number no greater than `MAX_TIMER_DELAY_MS` (2147483647). |

The deadline is armed when the vendor request starts, so credential resolution and redaction are not counted against it.

## Composition

```yaml
- name: '@shres-code/shres-code-judgment-typesafe'
  config:
    apiKeyRef: TYPESAFE_API_KEY
```

The key itself is never in configuration: the credentials seam (`ctx.credentials`, provided by `@shres-code/shres-code-credentials-local` for a file or environment source) resolves the reference. Without that service mounted, every ask fails with `UNCONFIGURED` and no request leaves the process.

## Ask behaviour

One ask resolves the credential reference, consults the optional egress hook `ctx.judgmentRedactor` exactly once — the provider is the hook's one home, so a consumer's state arrives unredacted and leaves as what the hook returned — resolves the tier to a model id, and posts one request. The result carries `answers` in the order the questions were asked (each with its question id), `engine: 'typesafe'`, the model id the response reported, and `latencyMs`, measured around the whole ask and rounded to a whole millisecond. The vendor reports the versioned id an alias resolved to, so a log records what answered rather than what was requested.

Failures are one `JudgmentError` each, and a consumer branches on `code`:

| Code | Raised when |
|---|---|
| `UNCONFIGURED` | No credentials service is mounted, or the reference holds no value. Thrown before any request is sent. |
| `UNAVAILABLE` | The request failed, the vendor answered non-2xx (401, 422, 429, 529 and any other status), or the request outlived `timeoutMs`. A non-2xx message carries the HTTP status and the provider's own message when its error body is JSON. |
| `INVALID_ANSWER` | The response body is not an object, carries no model id or answers, or answers a question with a missing entry, another kind's discriminant, an option the question never offered, or a non-finite number. |
| `ABORTED` | The caller's own `AbortSignal` ended the ask. Caller cancellation is classified before the deadline, so a cancelled ask is never reported as a timeout. |

## Wire mapping

One request is `POST {endpoint}/v1/systemone` with `authorization: Bearer <key>` and `content-type: application/json`. Its body carries the state, the resolved model id, and one question per asked id, and the questions are translated into the vendor's vocabulary:

| Seam question | Vendor question | Notes |
|---|---|---|
| `binary` | `noul` | `criteria.yes` maps to `criteria.true` and `criteria.no` to `criteria.false`; `criteria` is omitted when neither side is set. |
| `choice` | `choice` | One `criteria` entry per option; a missing `description` is sent as `null`. |
| `score` | `score` | `criteria` is the ordered `levels` array. |

Answers are translated back, and the discriminant must match the question kind:

| Vendor answer | Seam answer | Notes |
|---|---|---|
| `{ type: 'noul', noul }` | `{ kind: 'binary', id, probability }` | The vendor reports no confidence for this kind, and the seam's binary answer has none either. |
| `{ type: 'choice', choice, probabilities, confidence }` | `{ kind: 'choice', id, option, probabilities, confidence }` | `choice` must name one of the asked options. |
| `{ type: 'score', score, probabilities, confidence }` | `{ kind: 'score', id, score, probabilities, confidence }` | Probabilities keep the vendor's level-index keys, and the `legend` it may accompany them with is dropped. |

`usage` is carried by the vendor and not consumed, so its absence never fails an ask, and no token figure reaches the result.

## Privacy posture

TypeSafe retains Input. There is no zero-retention option on the standard plan — zero data retention is an enterprise arrangement, on request — and the service is US-hosted. TypeSafe states that it does not train on customer requests or responses.

Because no zero-retention mode is available, bounding what leaves the process is the deployment's job, and the seam exposes exactly one control for it: `ctx.judgmentRedactor`, which this provider consults exactly once per ask before the state is serialized; no consumer consults it. State caps belong in the consuming package's own Config, next to the question text that produces the state, so a cap and the text it bounds are tuned together. A distilled on-box engine behind the same `ctx.judgment` contract is the endgame for deployments whose governance rules cannot accept a retained-input vendor.

The vendor's site terms clause (vi) restricts using the service to develop new products without express written permission. Evaluation and BYOK experimentation proceed under that reading; shipping a product integration waits on the partnership conversation that also owns enterprise zero data retention and volume pricing.

## Measured operating bands

A one-day live evaluation on a labeled command-separation set measured clean separation on that set: harmful commands scored 0.63–0.99 and benign commands 0.12–0.34. The bands taken from those measurements are a flag at `noul` probability ≥ 0.6, human review from 0.4 to 0.6, and a pass below 0.4.

These are the evaluation's measured bands on that set, and they are evidence, not a contract: a deployment tunes its own bands against its own labeled cases, and the same run measured borderline probabilities wobbling by ±0.01–0.06 across identical reruns. Nothing in this package applies a threshold.

## Tier latency

On a state of 1.7k tokens the one-day live evaluation measured 273 ms for `jev-preview` and 685 ms for `jev-latest`.

Both aliases currently resolve to the same model id. An alias can move to a newer model without any change here, and a deployment whose thresholds were tuned against a measured run pins the versioned id in `models.fast` and `models.accurate` instead of an alias.

## Model Experience

### Typesafe judgment ask

#### What the model sees

The vendor's model receives `state` — after `ctx.judgmentRedactor` has run, when a deployment mounts one — and, per question, the question's `instructions` plus its mapped criteria, option descriptions, or levels. This package adds no prose of its own: every model-visible string is consumer-owned, and the question id is transport metadata that never reaches the vendor as text.

#### Token effect

The ask's input is the state plus the question text, charged at the vendor's input rate; a longer state costs more input tokens. The vendor returns probabilities rather than generated text, so this ask contributes no tokens to any conversation, and this package adds no text of its own. Question criteria that are never set are omitted from the request rather than sent empty.

#### KV Cache effect

Independent model request: the ask neither reads nor extends a conversation prefix, and nothing here appends to a later model request. A deployment that redacts or caps the state changes the bytes of this one request and no conversation prefix.

## Known Limitations and Deferred Work

- **No retries and no backoff** — a 429 or 529 arrives as `UNAVAILABLE` with the provider's message, and this provider neither waits nor repeats. A caller that wants a retry policy owns it entirely.
- **No streaming and no generated text** — the vendor returns one JSON body of probabilities, so there is no partial answer and nothing to render as text.
- **State is one string** — `JudgmentInput.state` is a string, so a consumer with structured state serializes it itself; this package sends what it was given, and a JSON state is the caller's serialization.
- **Text-only input** — the state and every question string are text. An image must be turned into text before it reaches an ask.
- **No threshold, and none transfers** — the vendor's own model card records structural jaggedness: probabilities can sum past 1, and a `noul` answer can disagree with a `choice` answer about the same state. This provider reports the distribution it received instead of repairing it, applies no cut-off, and a `noul` band does not transfer to a choice or score question.
- **Usage is not surfaced** — the vendor's `usage` envelope is read and ignored, so no consumer can price an ask from the result. Wiring it into the result would need a seam-level field first.
- **The deployment toggle is not consulted here** — mounting any engine installs the Definition-owned `judgment` settings section, and this provider neither reads it nor refuses an ask when it is off. A consumer gates its own calls on `ctx.judgment.settings().enabled`.
