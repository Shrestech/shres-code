# Agent Note: Usage-based overflow detection is scoped to silently-truncating protocols

Status: implemented

## Problem

pi-ai's `isContextOverflow` detects overflow three ways: case 1 matches provider error text, case 2 treats a successful `stop` response whose reported input exceeds the context window as a silent overflow, and case 3 does the same for a zero-output `length` response that fills the window. Cases 2 and 3 exist for providers that accept an oversized prompt without failing — z.ai truncates silently, Xiaomi MiMo fills the window from the input and returns no output — and the harness passed the resolved catalog capacity into all three cases on every pi-ai protocol.

A capacity the harness resolves for such a route is a guess unless someone verified it. `llm-codex-session` ships no window for its models, so `DEFAULT_CONTEXT_WINDOW` (262,144) stands in. A production session against the ChatGPT backend (`openai-responses`, session-8bec6678) reached a completed response reporting 311,781 prompt tokens — input 8,805 plus 302,976 cached, `stopReason: "stop"`, full answer streamed — and the case-2 guard reclassified it as `CONTEXT_WINDOW_EXCEEDED`. The harness discarded that answer after generating it, the retried request produced and discarded it again, and the turn ended on the error. The same guard then killed the compaction summary that was supposed to relieve the session, because a summarization call is a text-only completion that ends `stop` by construction: the summarizer replays the conversation region it condenses, so once that region passes the declared window every attempt failed, automatic and manual `/compact` alike, and the session could not recover.

## Decision

`SILENT_OVERFLOW_PROTOCOLS` in `llm-pi-ai/provider.ts` names the protocols whose provider can accept an oversized prompt without failing — `openai-completions` today, which the installed catalog builds z.ai, Xiaomi MiMo, and DeepSeek on. The adapter passes `model.contextWindow` to `toStreamChunks` only for a model whose protocol is in that set, and `undefined` otherwise, which leaves `isContextOverflow` cases 2 and 3 off. It is a protocol constant, not a tunable: whether a provider reports rather than refuses an oversized request is a property of the wire implementation.

For every other protocol the declared capacity does not reach pi-ai. Real overflow arrives as an error and is classified from its text — pi-ai's case-1 patterns, or the harness's `isContextWindowExceededError` check in `stream.ts` — which is the path the ChatGPT backend takes: it fails an oversized request loudly, so a completed response is authoritative. Capacity keeps two consumers only: the compaction pressure threshold and the occupancy display, both of which can afford to be wrong in the recoverable direction.

## Alternatives considered

**Correct only the shipped window.** Rejected as the whole fix: it moves the boundary rather than removing the reclassification, so the next route whose window is a fallback or a lower bound repeats the wedge. A capacity the harness cannot verify must not decide whether a completed response is discarded.

**Require an exact window on every route before usage detection runs.** Rejected: nothing in the request path can verify a declaration against provider usage, and a missing or stale value would disable overflow recovery for the providers that do fail loudly — the population pi-ai's case 1 already classifies correctly.

**A per-route settings flag for the usage cases.** Rejected: the behavior belongs to the wire implementation, so a route-level switch would let a deployment declare a silent-truncating provider as loud (or the reverse) with no evidence, and it would have to be set correctly on every route rather than once per protocol.

**Drop the usage cases from the harness entirely.** Rejected: a silently-truncating provider would then return an answer built from truncated context with a successful finish, which is worse than a discarded response. Cases 2 and 3 stay live for the protocols they describe.

**Compare reported usage against provider-declared capacity from the endpoint.** Deferred: the ChatGPT backend exposes no model listing to read one from, and every other route's capacity is already catalog configuration. A route that publishes authoritative capacity would be a separate decision.

## Consequences

A completed response is never reclassified by a capacity its provider did not enforce, so final answers and compaction summaries survive on `openai-responses` and `anthropic-messages` routes. The cost is that a deployment whose loud provider actually truncates silently — a gateway in front of a truncating model, or a model whose protocol is declared as `openai-responses` while its endpoint accepts overflow — loses usage-based detection and needs the pressure threshold to fire first. That trade is deliberate: the detected case is invisible until the answer is wrong, while the discarded case destroys completed work on every turn above the declared window.

This guard was not the wedge's only cause: the recovery compaction that failed above spent 4.8 minutes of provider time on a summarization request carrying the same oversized region, and the pressure gate that should have compacted earlier read a heuristic surface figure 1.65x below the provider-reported prompt. Both are owned by notes landing with this change.

## Testing

`packages/llm/llm-pi-ai/tests/adapter.spec.ts` keeps the `openai-completions` usage-detection test and adds a hand-declared `openai-responses` route whose scripted response completes with `stop` above the declared window, expecting `stop`. `packages/llm/llm-codex-session/tests/adapter.spec.ts` replays the incident shape — 311,781 prompt tokens against the shipped route — and expects a completed answer with its usage preserved.
