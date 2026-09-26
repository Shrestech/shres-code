# @shres-code/shres-code-judgment-shield

Local engine for the typed-judgment seam, registered in `ctx.judgmentEngines` as `shield` for [judgment-dispatch](../judgment-dispatch/README.md) to route asks to. Each ask posts the consumer's state and typed questions to an explicitly configured local `/v1/judgments` gateway. `toWireRequest` selects only `state`, `model`, and `questions`; an ask's optional `correlation` (`sessionId`, `consultKey`) is local-only and never reaches that JSON. The gateway owns the model runtime and artifact provenance; this package owns tier-to-artifact selection, cancellation, response-size limits, and response validation.

This provider is separate from the `shres-shield` host seat. The host seat exposes the paid Shield security service through `ctx.shield`; this package does not import that service or reinterpret its binary injection score as a choice or score judgment.

## Config

Every composition field is validated at load. Unknown keys fail by name, and the endpoint must use `http` or `https` with hostname `localhost`, `127.0.0.1`, or `::1`. Credentials, query strings, and fragments are rejected. Model ids are explicit artifact pins; there is no implicit model or endpoint.

| Key | Default | Effect |
|---|---|---|
| `endpoint` | required | Loopback gateway base. The provider posts to `{endpoint}/v1/judgments`. |
| `models.fast` | required | Artifact for an explicit `fast` ask. |
| `models.accurate` | required | Artifact for an explicit `accurate` ask and an ask that omits its tier. |
| `timeoutMs` | `30000` | Deadline for the gateway request and complete response body. |
| `maxRequestBytes` | `262144` | Maximum complete serialized UTF-8 request body size. The provider measures the JSON sent on the wire and rejects a larger request before opening HTTP. |
| `readinessIntervalMs` | `30000` | Interval between readiness probes, each one TCP connection to the endpoint bounded by `timeoutMs`. |
| `maxResponseBytes` | `4194304` | Maximum response body size. The provider checks both the declared length and bytes actually received; the configured maximum is 64 MiB. |

The `accurate` mapping is the default for an omitted tier because the cheap tier is an explicit optimization. The provider requires the gateway's exact `engine: 'shield'`, artifact `model`, and non-negative `latencyMs` fields, then reports its own wall-clock duration for the complete ask.

## Composition

```yaml
- name: '@shres-code/shres-code-judgment-dispatch'
  config:
    defaultEngine: shield
- name: '@shres-code/shres-code-judgment-shield'
  config:
    endpoint: 'http://127.0.0.1:8765'
    models:
      fast: 'convaiinnovations/laya@1c5edc17a7acd8701df6fc341c0d179f1c62c982'
      accurate: 'convaiinnovations/laya@1c5edc17a7acd8701df6fc341c0d179f1c62c982'
```

The provider injects `judgmentEngines`, so it loads only where the dispatcher does. Its registry descriptor declares `egress: 'local'`, `calibration: 'calibrated'`, and fitting; it also names both tier artifacts and the endpoint's host as its destination. Its status reports whether the gateway is reachable: `starting` until the first probe settles, then `ready` or `unavailable` with the connection failure. A probe opens one TCP connection to the endpoint — no judgment request — at load, every `readinessIntervalMs`, whenever the status is read while not `ready`, and after an ask fails with `UNAVAILABLE`; an answered ask reports `ready`, and a failed ask never sets the status itself, since an HTTP or answer failure comes from a reachable gateway. The plugin finishes loading once the first probe settles, so a Loader composition does not route an ask while the status is `starting`. The package has no credential seam and makes no external calls. The owned gateway is responsible for loading and validating its model artifacts before it serves a request.

## Request and answer validation

The request carries `state`, the selected `model`, and one question per typed seam question. Question ids, instructions, binary criteria, choice options, and score levels are forwarded without provider-generated prompt text.

The response must carry `engine: 'shield'`, the exact requested model id, a non-negative `latencyMs`, and one answer for every asked id. Binary probabilities and choice/score probabilities are finite values in `[0, 1]`. Choice and score answers must contain exactly one probability for every requested key, sum to one within `0.001`, and carry confidence in `[0, 1]`. A choice must select an argmax option, accepting ties and four-decimal rounding. A score must equal its probability-weighted zero-based level index within a level-count-scaled rounding tolerance.

Malformed JSON or an invalid answer is `JudgmentError('INVALID_ANSWER')`. A request larger than `maxRequestBytes` is `JudgmentError('INPUT_TOO_LARGE')` before HTTP is opened; an oversized response is `JudgmentError('INVALID_ANSWER')`. Transport, non-success HTTP status, body-read, and timeout failures are `UNAVAILABLE` except that caller cancellation is `ABORTED`. The optional `ctx.judgmentRedactor` runs exactly once before the request is serialized and is cancellation-aware.

## Atomic fit-and-ask

When the selected engine is this provider, `ctx.judgment.fitting` routes to its fitting capability, and a consumer can send ordered complete state alternatives to `/v1/judgments/fitted`. The provider resolves one pinned model, redacts every state exactly once, and sends all resulting states with the typed questions. The gateway selects a state without truncating it and either returns `kind: 'answered'` with the ordinary validated result or returns `kind: 'unfit'` with one of `state`, `head`, `option`, or `batch` capacity reasons. An unfit response does not run inference.

An answered fit reports `selectedIndex`, `stateTokens`, one `sequenceTokens` count per question, `paddedTokens`, and tokenizer limits containing `maxSequenceTokens`, `maxHeadTokens`, `maxBatchTokens`, and a 64-character `manifestSha256`. The wire fit omits state text; the provider restores the exact redacted state at `selectedIndex` before returning it. It rejects out-of-range indexes, non-finite or inconsistent counts, limit violations, malformed hashes, identity mismatches, and invalid nested answers. The same deadline, response-size cap, and caller-cancellation rules apply to fitted requests, including cancellation after the gateway has produced a response.

## Wire client

`createShieldWireEngine(options)` is the one client for `/v1/judgments` and `/v1/judgments/fitted`. It takes a resolved configuration (`resolveConfig` output), a `redact` function the client calls exactly once per state before serialization, and a `label` that prefixes diagnostics, and returns an engine with `ask` and `fitting.ask`. Request caps, deadline and caller-cancellation classification, bounded response reads, and answer validation behave exactly as described above. The client owns no configuration resolution and no process: this provider binds it to a deployment-run gateway, and [`@shres-code/shres-code-judgment-laya`](../judgment-laya/README.md) binds it to the gateway it supervises.

## Model Experience

### Judgment ask

#### What the model sees

The local gateway receives the redacted `state` and consumer-supplied `questions`, including each question's `instructions` and its choice options, score levels, or binary criteria. This provider contributes no question wording, threshold, route policy, guardrail policy, or generated conversation text.

#### Token effect

The gateway's model processes one independent judgment request. State and question length determine its input work; the returned typed probabilities are not conversation tokens.

#### KV Cache effect

The ask is independent of the conversation model request. Repeated state and question prefixes may use the gateway's own cache, but this package neither reads nor extends a conversation prefix.

## Known Limitations and Deferred Work

- **Gateway availability is deployment-owned** — the package requires a live loopback `/v1/judgments` service and reports it unavailable when that service is absent; it does not start, supervise, or reload the model runtime. [`@shres-code/shres-code-judgment-laya`](../judgment-laya/README.md) is the provider that supervises its own gateway.
- **Artifact trust is gateway-owned** — model manifests, hashes, device selection, and runtime resource policy are validated by the owned service before it serves requests; this adapter validates only the returned identity and typed answer.
- **No routing or guardrail policy** — this provider returns typed answers and applies no threshold, downgrade decision, Shield posture, or blocking action. Consumers remain responsible for those decisions.
- **No retry** — one ask makes one bounded request. A deployment that retries owns that policy outside the typed provider so repeated judgments remain visible to the caller.
