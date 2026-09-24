# Agent Note: An LLM route answers typed judgment questions

Status: implemented

## Problem

The [engine registry](../architecture/2026-09-24-judgment-engine-registry.md) lets a deployment select a judgment engine at runtime, but the shipped engines are TypeSafe's remote classifier and the local Shield gateway. A deployment with neither, or one that wants to compare either against a general model, had no engine. The [model-routing plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md) calls for any registered `ctx.llm` route to serve as a judge. The owner's local-first rule applies: the judge is an explicit, opt-in selection that never falls back to another route, and its descriptor reports where the state goes.

Three facts constrain the design. The llm seam records no route locality, so a descriptor cannot derive `egress` from the route. The llm seam has no response-format field, so structured output has to travel through a tool schema. And pi-ai silently omits a stated `temperature` for an Anthropic model whose compat sets `supportsTemperature: false` (Claude Opus 4.7 and later), so a configured temperature could vanish without an error.

## Decision

[judgment-llm](../../../../packages/llm/judgment-llm/README.md) registers one engine per plugin row under `llm:<provider>/<model>`, branded with `judgmentEngineId`.

**Egress is configured, never inferred.** The row's required `egress` field is `local` only for a route that runs on this machine and `remote` otherwise, and the descriptor reports it unchanged. The engine never reads the provider name to guess, so a route named `ollama-local` that points at a remote host is still declared by the deployment that knows.

**Structured output is one tool call.** The request carries a fixed system prompt, one user message holding the redacted state and the questions, and one `judgment_answer` tool whose parameter schema requires every question and every option or level. `readAnswers` enforces the seam's provider contract on the arguments:

- every asked question is answered and nothing unasked appears;
- every choice option and every score level carries a number from 0 to 1, and an omitted one is `INVALID_ANSWER`;
- a distribution is normalised by its sum, which must be above 0;
- `confidence` is `1 − H(p) / ln(n)`.

A text reply, a second tool call, or an answer cut off at the output limit is `INVALID_ANSWER`.

**Calibration is `verbalized`.** No adapter in this repository returns token log-probabilities (`logprob` appears nowhere in `packages/llm/*/src` outside the calibration vocabulary), so a `logprob` path would be dead code. The descriptor declares `calibration: 'verbalized'` and `supportsFitting: false`.

**The route is resolved, and the engine never falls back.** The engine is `starting` until `ctx.llm.resolveModelInfo()` resolves the configured route, and resolves it again on every `llm/adapters-updated`. A resolution failure leaves it `unavailable` with the failure text. A refused `reasoningEffort` leaves it `unconfigured`. A generation counter discards a resolution that a later one or the fiber's disposal superseded. Through the dispatcher, any status other than `ready` fails the ask `UNAVAILABLE`. No other route or engine is tried.

**Temperature refusal is a route fact.** `LlmResolvedModelInfo` gains `acceptsTemperature?: boolean`. `false` means the route rejects or discards a stated temperature for that model, and absence is no claim. The llm runtime validates and carries it. The pi-ai adapter sets it from the Anthropic compat switch that makes pi-ai omit the field, and llm-cli-bridge declares it for every model, because its stream refuses a stated temperature. A configured `temperature` on such a model leaves the engine `unconfigured`, with a detail naming the field, logged once as an error. It is never sent and silently dropped. This is the earliest resolvable point: adapters register after load and can change at runtime, so the check cannot run in the config schema.

**One request, no retry.** Each ask consults the redactor exactly once, bounds the redacted state by `maxStateTokens` counted as UTF-8 bytes (no tokenizer emits more tokens than bytes), and makes one request bounded by `timeoutMs`. The caller's signal cancels it, and a cancelled ask fails `ABORTED` even when the route finished anyway. A failed request fails `UNAVAILABLE`, and its `LlmFailure` becomes the cause.

**Usage rides on the result.** `JudgmentResult.usage?: TokenUsage` carries the judge request's usage exactly as the adapter reported it, so `TokenUsage`'s presence contract holds unchanged: a cache count is present exactly when the provider reported it, and a reader uses `cacheCount`. The field is absent when the route reported nothing. The dispatcher's spread keeps the field on a routed result.

The provider contract the plan lists is now part of the `JudgmentEngine` JSDoc and [the subsystem page](../../../../docs/subsystems/judgment.md#the-engine-contract). Both existing providers already reject an omitted choice option; TypeSafe keeps its documented sparse score levels.

## Reconstructing a judge request from the log

The engine appends nothing to a session, like every judgment provider. A judge request is reconstructable only through what the asking consumer logs. For the model router, the one consumer that asks an engine without fitting, `model-routing/decision` records:

- `judgmentQuestions`: the exact questions, which fix the rendered question text and the `judgment_answer` schema;
- `stateSeqs`, `stateProjection`, and `stateHash`: the source messages, the renderer and bounds that turn them into state text, and a hash of the state text the router passed;
- `engine` (`'llm'`), `model`, and `latencyMs`.

The system prompt is a pinned package constant. `renderJudgeMessage` and `answerTool` are pure functions of the state and the questions. So a log reader who rebuilds the router's state from `stateSeqs` and `stateProjection`, and checks it against `stateHash`, can rebuild the request byte for byte, except in these cases:

- **The route and controls are not in the decision.** The decision carries `engine: 'llm'` and the model id, but neither the provider nor the configured `temperature` or `reasoningEffort`. The registry `engineId` names the route, but router decisions on this base do not record it. Recording `engineId` in the decision closes the route half; the controls come from the composition, which the log does not hold.
- **Redaction output is not logged.** With a `ctx.judgmentRedactor` mounted, the sent state is whatever the hook returned. For a fitting engine the router logs that text in `judgmentInput`, but an `ask()` engine returns no redacted text to log. The same holds for TypeSafe.
- **Usage is not yet logged.** `JudgmentResult.usage` is on the result, and the router's decision does not copy it yet. Bench accounting that prices judge calls from decisions depends on it.
- **The raw answer is not logged.** The decision records the route answer's probabilities as the engine returned them, after normalisation, and the difficulty's score and confidence. The tool arguments before normalisation are not recorded.

PR 8b, the router half of PR 8 in the [delivery plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md#6-delivery-sequence), owns the first and third gaps: it adds `engineId` and `usage` to the router's decision events. This package cannot make that change, because it holds no session.

## Alternatives considered

**Infer egress from the provider.** A name such as `ollama-local` or a loopback `baseURL` looks decisive, but the llm seam exposes neither a locality fact nor a base URL for every adapter, and a misreported `local` would break the owner's rule silently. A required config field makes the deployment state the fact.

**A response-format field on `GenerateOptions`.** A seam-wide structured-output option would need every adapter to map it, and several providers have no such mode. Tool calls already cross every adapter, and the strict reader enforces the schema either way.

**Check temperature in the config schema.** The config schema runs before any adapter registers and cannot know a model's compat. Failing at route resolution with an `unconfigured` status, which the dispatcher turns into `UNAVAILABLE`, is the earliest point where the fact exists.

**Retry a failed judge request.** A retry doubles cost on the judge route and hides a failing route from the consumer, whose own fallback keeps the strong route. The engine makes one request, and a caller that wants another asks again.

**Implement a `logprob` path now.** No adapter surfaces token log-probabilities, so the path could not run and would need tests against a fake adapter only. It is deferred until an adapter exposes them.

## Consequences

A deployment can select any registered route as its judgment engine through the `judgment` settings. Its descriptor declares `verbalized` calibration and the egress the deployment configured. Until the router's operating points accept a verbalized engine, it serves shadow and bench runs only. Every ask spends the judge route's own tokens and quota, and a judge on the strong route's provider competes for its rate limits.

Later work:

- The router's operating points and `acceptVerbalized` gate belong to the router.
- `judgment-shield`'s remote endpoint policy belongs to that package.
- The Settings card's engine picker belongs to the Settings card.
- PR 8b records `engineId` and `usage` in the router's decision events and adds the keyless snapshot example that composes an LLM judge. Until then no shipped example composes this engine, so its model-facing text is pinned by unit tests and its request by the Loader composition test.

## Verification

- `tests/answer.spec.ts` pins the system prompt, the rendered message, and the answer schema. It covers valid answers, normalisation, the confidence formula, and each `INVALID_ANSWER` case: malformed JSON, a missing question or option, an unoffered option, and out-of-range probabilities.
- `tests/engine.spec.ts` covers:
  - the descriptor for both egress values;
  - every status transition, including adapter registration and removal and the temperature refusal logged once by field name;
  - a refused reasoning effort;
  - the exact request;
  - usage present and absent;
  - the redactor called once, and the byte bound after redaction;
  - one request with no retry;
  - the timeout;
  - cancellation before, during redaction, during the request, and after the route finished.
- `tests/loader-composition.spec.ts` boots file settings, `judgment-dispatch` with a local default engine, the llm runtime, DeepSeek pointed at the mock LLM server, and this package through the real Loader. A settings write selects `llm:deepseek-official/deepseek-v4-flash`. The next ask reaches the mock server with the `judgment_answer` tool and returns normalised probabilities with `engineId` stamped and `usage` present.
- The llm runtime and pi-ai adapter tests cover `acceptsTemperature`: it is carried and validated, and it is declared only for an Anthropic model whose request body really omits a stated temperature.
