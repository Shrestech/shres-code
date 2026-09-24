# @shres-code/shres-code-judgment-llm

An LLM-as-judge engine for the [typed-judgment seam](../judgment/README.md). It registers in `ctx.judgmentEngines` as `llm:<provider>/<model>`, and [judgment-dispatch](../judgment-dispatch/README.md) routes an ask to it only when the `judgment` settings select that id. Each ask is one model request on one configured `ctx.llm` route.

## Config

```yaml
- name: '@shres-code/shres-code-judgment-llm'
  config:
    provider: ollama-local
    model: qwen3:8b
    egress: local
    maxStateTokens: 8192
    timeoutMs: 30000
```

| Field | Meaning |
|---|---|
| `provider` | Registered `ctx.llm` provider route that answers every ask. Required. |
| `model` | Model id on that route. Required. With `provider`, it forms the registry id. |
| `egress` | `local` only for a route that runs on this machine, `remote` for every other route. Required: the llm seam records no route locality, so the engine never infers it from the provider name. The descriptor reports this value. |
| `reasoningEffort` | Adapter-owned effort for the judge request, validated against the model when the route resolves. |
| `maxStateTokens` | Largest redacted state one ask may send, enforced as a UTF-8 byte count. A tokenizer emits at most one token per byte, so the bound holds for every route. Required. |
| `timeoutMs` | Bound on one ask's model request, default 30000. |
| `temperature` | Sampling temperature for the judge request. |

A row with an unknown key, a missing required field, or an out-of-range number fails load by name.

## Status

The engine reports `starting` until `ctx.llm` has resolved the configured route, and resolves it again after every `llm/adapters-updated` topology change. It reports:

- `ready` when the route resolves and accepts every configured control;
- `unavailable` with the resolution failure while no adapter serves the route or the model does not resolve;
- `unconfigured` when the route refuses the configured `reasoningEffort`, or when `temperature` is set and the route declares the model does not accept a stated temperature (`LlmResolvedModelInfo.acceptsTemperature: false`, as for Claude Opus 4.7 and later on an Anthropic route and for every llm-cli-bridge route). The detail names the field, and the engine logs it once as an error.

Through the dispatcher, a status other than `ready` fails the ask `UNAVAILABLE` with that detail before the engine is asked. The engine never answers with another route or another engine.

## Ask behaviour

An ask with no questions returns no answers without a request. Otherwise the engine consults `ctx.judgmentRedactor` exactly once, rejects a redacted state above `maxStateTokens` bytes with `INPUT_TOO_LARGE`, and sends one request carrying `JUDGE_SYSTEM_PROMPT`, one user message from `renderJudgeMessage`, and the one tool from `answerTool`. There is no retry: a failed or timed-out request fails the ask `UNAVAILABLE`, and a caller that wants a second attempt asks again.

The judge answers through one `judgment_answer` tool call whose parameter schema requires every question and every option or level. `readAnswers` then applies these rules:

- every asked question is answered, with nothing unasked, and every option of a choice question and every level of a score question carries a number from 0 to 1;
- a choice or score distribution is normalised by dividing each value by its sum, which must be above 0;
- `confidence` is `1 − H(p) / ln(n)`: normalised Shannon entropy subtracted from 1 over the `n` options or levels. It is 0 for a uniform distribution and 1 when one key holds all the probability or the question has one key;
- a choice's `option` is the highest-probability key, the earliest listed on a tie, and a score is the probability-weighted level index.

Any other answer, a text reply, a second tool call, or an answer cut off at the output limit fails the ask `INVALID_ANSWER`. The ask honours `input.signal` at every await: the redaction and the request each settle it `ABORTED` as soon as the signal aborts, even when the redactor or the route is slow to observe cancellation, and the request also receives the signal so the route can stop.

A result reports `engine: 'llm'`, the configured `model`, which the llm runtime requires the adapter to resolve under exactly that id, `latencyMs`, and the request's `usage` when the route reported it.

## Calibration

The probabilities are the model's own stated numbers, so the descriptor declares `calibration: 'verbalized'` and `supportsFitting: false`. No adapter in this repository exposes token log-probabilities, so there is no `logprob` path.

## Model Experience

### Judge request

#### What the model sees

The judge model receives `JUDGE_SYSTEM_PROMPT` as the system prompt and one user message: the redacted state inside `<state>` tags, then each question with its answer key, its instructions, and its options with descriptions, its levels keyed `"0"`, `"1"`, …, or its yes and no criteria. The request carries one tool, `judgment_answer`, whose schema names every question and every option or level.

#### Token effect

The input is the system prompt, the state, the question text, and the tool schema. A longer state or more options costs more input tokens. The output is one tool call of probabilities, plus any reasoning tokens the configured effort produces. Every token is billed to the judge route, and `JudgmentResult.usage` reports the adapter's counts.

#### KV Cache effect

Independent model request: the ask neither reads nor extends a conversation prefix, and nothing here appends to a later model request. The system prompt and tool schema precede the state, so a route with prefix caching can reuse them across asks with identical questions.

## Known Limitations and Deferred Work

- **Verbalized probabilities are uncalibrated** — a model's stated numbers are not calibrated probabilities, and thresholds tuned on another engine do not transfer. Select this engine for shadow and bench runs only, until the router's operating points record one for it with `acceptVerbalized`.
- **The judge route's own quota** — every ask spends tokens and requests on the configured route. A judge on the same provider as the strong route competes for its quota and rate limits.
- **No token log-probabilities** — `calibration: 'logprob'` needs an adapter that returns token log-probabilities, and none in this repository does.
- **Byte bound, not tokens** — `maxStateTokens` counts UTF-8 bytes, which never undercounts tokens and rejects some states a real tokenizer would admit.
- **Tier has no effect** — one route serves both tiers, so `tier: 'fast'` and `'accurate'` send the same request.
- **Structured output is a tool call** — the llm seam has no response-format field, so the schema rides on the `judgment_answer` tool. A route that ignores tool schemas can still return any arguments, and `readAnswers` rejects what does not match.
- **The request is not logged by this package** — the engine appends nothing to a session. A consumer's decision event records the questions, the state's source, and the answering engine; see the [Agent Note](../../../.agents/notes/implemented/feature/2026-09-24-llm-judgment-engine.md) for what a log can reconstruct.
