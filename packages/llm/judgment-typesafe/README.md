# @shres-code/shres-code-judgment-typesafe

TypeSafe AI "System One" judgment engine for the typed-judgment seam, registered in `ctx.judgmentEngines` as `typesafe` for [judgment-dispatch](../judgment-dispatch/README.md) to route asks to. One ask posts the state and the typed questions to the vendor's `/v1/systemone` endpoint over raw `fetch`, and the vendor answers with probabilities instead of text: a `noul` probability for a binary question, an option distribution for a choice question, and a weighted score for a score question.

The engine owns transport, credential resolution, tier-to-model mapping, and the validation of the one untyped input it reads — the response body. It adds no prompt prose, no session event, and no tool: every question string, threshold, and decision belongs to the consuming package. The request path, headers, and body follow the vendor's documented API.

A refused request is retried in a bounded way: only a status the retry policy names — the vendor's documented transient 429 and 529 by default — is sent again, at most `retry.maxRetries` times, after one fixed `retry.delayMs` wait that ends at once when the caller cancels. A deterministic refusal such as 401 or 422, a spent budget, a status the policy does not name, and a transport failure with no status all arrive as `UNAVAILABLE` on their first response, exactly as this provider behaved before retry existed. There is no streaming.

## Config

Every field is validated at plugin load, and unrecognized keys fail load by name.

| Key | Default | Effect |
|---|---|---|
| `apiKeyRef` | required | Credential reference (environment-variable name) holding the API key. There is no default: which reference holds the key is the deployment's decision. It is resolved through `ctx.credentials` on **every** ask and cached nowhere, so a rotated key reaches the next ask without a restart. |
| `endpoint` | `https://api.typesafe.ai` | Vendor endpoint base; a trailing slash is dropped. Requests go to `{endpoint}/v1/systemone`. |
| `models.fast` | `jev-preview` | Model id serving the `fast` tier. |
| `models.accurate` | `jev-latest` | Model id serving the `accurate` tier, and every ask that omits a tier. |
| `timeoutMs` | `30000` | Deadline for one vendor request, in milliseconds. An ask that outlives it fails with `UNAVAILABLE` naming the figure. Must be a positive finite number no greater than `MAX_TIMER_DELAY_MS` (2147483647). |
| `retry.maxRetries` | `1` | Retries allowed after the first request. `0` disables retry. Must be a non-negative safe integer. |
| `retry.delayMs` | `300` | Fixed wait before each retry, in milliseconds. `0` retries on the next timer turn. Must be a non-negative finite number no greater than `MAX_TIMER_DELAY_MS`. |
| `retry.statuses` | `[429, 529]` | HTTP statuses eligible for retry: the vendor's documented transient rate limit and overloaded service. Every other status fails on its first response, so a deterministic 401 or 422 must not be added here. Must hold statuses from 100 through 599, and must not be empty while `retry.maxRetries` is positive. |

The deadline is armed once per ask, before the first request, so credential resolution and redaction are not counted against it while a retry and its wait are: an ask whose retries outlast `timeoutMs` fails with `UNAVAILABLE` naming the figure, and a cancel during a wait fails with `ABORTED`.

## Composition

```yaml
- name: '@shres-code/shres-code-judgment-dispatch'
  config:
    defaultEngine: typesafe
- name: '@shres-code/shres-code-judgment-typesafe'
  config:
    apiKeyRef: TYPESAFE_API_KEY
```

The provider injects `judgmentEngines`, so it loads only where the dispatcher does. Its registry descriptor declares `egress: 'remote'`, `calibration: 'calibrated'`, no fitting, and the vendor's terms URL; its status is always `ready`, because a missing credential surfaces per ask as `UNCONFIGURED`. The key itself is never in configuration: the credentials seam (`ctx.credentials`, provided by `@shres-code/shres-code-credentials-local` for a file or environment source) resolves the reference. Without that service mounted, every ask fails with `UNCONFIGURED` and no request leaves the process.

## Ask behaviour

One ask resolves the credential reference, consults the optional egress hook `ctx.judgmentRedactor` exactly once — the provider is the hook's one home, so a consumer's state arrives unredacted and leaves as what the hook returned — resolves the tier to a model id, and posts one request. A refusal the retry policy names is sent again after its fixed wait, byte for byte: the retry repeats the same ask with the same credential rather than re-resolving anything. The result carries `answers` in the order the questions were asked (each with its question id), `engine: 'typesafe'`, the model id the response reported, and `latencyMs`, measured around the whole ask — every attempt and wait included — and rounded to a whole millisecond. The vendor reports the versioned id an alias resolved to, so a log records what answered rather than what was requested.

Failures are one `JudgmentError` each, and a consumer branches on `code`:

| Code | Raised when |
|---|---|
| `UNCONFIGURED` | No credentials service is mounted, or the reference holds no value. Thrown before any request is sent. |
| `UNAVAILABLE` | The request failed, the vendor answered non-2xx (401, 422, 429, 529 and any other status), a transient status outlasted `retry.maxRetries`, or the ask outlived `timeoutMs`. A non-2xx message carries the HTTP status and the provider's own message when its error body is JSON, and an exhausted retry carries the response that spent the budget. |
| `INVALID_ANSWER` | The response body is not an object, carries no model id or answers, omits a probability for a requested choice option, or answers with a missing entry, another kind's discriminant, an unasked option, or a non-finite number. |
| `ABORTED` | The caller's own `AbortSignal` ended the ask: before it started, during the credential lookup or the redaction hook, or during the request, body read, or a retry wait. A lookup or redaction that cannot be cancelled is abandoned rather than awaited, so a hanging one never holds a cancelled ask. Caller cancellation is classified before the deadline, so a cancelled ask is never reported as a timeout. |

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
| `{ type: 'choice', choice, probabilities, confidence }` | `{ kind: 'choice', id, option, probabilities, confidence }` | `choice` must name an asked option; every asked option must have a finite probability. The distribution is not renormalized. |
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

The ask's input is the state plus the question text, charged at the vendor's input rate; a longer state costs more input tokens, and a retry sends that same input again, so it is charged again. The vendor returns probabilities rather than generated text, so this ask contributes no tokens to any conversation, and this package adds no text of its own. Question criteria that are never set are omitted from the request rather than sent empty.

#### KV Cache effect

Independent model request: the ask neither reads nor extends a conversation prefix, and nothing here appends to a later model request. A retry sends identical bytes, which the vendor's own prefix cache may reuse, and the wait between attempts changes nothing outside this ask. A deployment that redacts or caps the state changes the bytes of this one request and no conversation prefix.

## Known Limitations and Deferred Work

- **Retry is bounded, fixed, and status-only** — one fixed delay is waited per retry, with no exponential growth, no jitter, no `Retry-After` reading, and no budget beyond `retry.maxRetries`. Only a refused HTTP status is retried: a transport failure, a body that cannot be read, and a malformed answer are not repeated, so a caller that wants those repeated owns that policy itself.
- **No streaming and no generated text** — the vendor returns one JSON body of probabilities, so there is no partial answer and nothing to render as text.
- **State is one string** — `JudgmentInput.state` is a string, so a consumer with structured state serializes it itself; this package sends what it was given, and a JSON state is the caller's serialization.
- **Text-only input** — the state and every question string are text. An image must be turned into text before it reaches an ask.
- **No threshold, and none transfers** — the vendor's own model card records structural jaggedness: probabilities can sum past 1, and a `noul` answer can disagree with a `choice` answer about the same state. This provider reports the distribution it received instead of repairing it, applies no cut-off, and a `noul` band does not transfer to a choice or score question.
- **Usage is not surfaced** — the vendor's `usage` envelope is read and ignored, and the result carries no `JudgmentResult.usage`, whose `TokenUsage` fields describe an `ctx.llm` route's token accounting rather than this vendor's, so no consumer can price an ask from the result.
- **The deployment toggle is not consulted here** — mounting any engine installs the Definition-owned `judgment` settings section, and this provider neither reads it nor refuses an ask when it is off. A consumer gates its own calls on `ctx.judgment.settings().enabled`.
