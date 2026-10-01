# Agent Note: Explicit current-model choice and difficulty limits

Status: implemented

## Problem

A routing judge offered only downgrade candidates cannot choose to retain the manual model. With one candidate, the question also violates the judgment service's two-option minimum. Separately, treating zero-based difficulty scores as a 1–5 scale and applying escalation only inside a held streak permits an initial downgrade on a hard task. Sticky transitions between different candidates undermine the intended reduction in model changes.

## Decision

The route question contains the reserved `keep-current` option and the eligible configured candidates, with provider/model identities, explicit effort, and candidate task descriptions. A candidate naming the manual provider/model is never eligible ([routing correctness after the live review](2026-09-24-routing-correctness-after-live-review.md)). Choosing the current model ends a downgrade immediately. Difficulty at or above the configured threshold prevents entry and ends a held streak. Scores use the judgment service's zero-based level indices; the default five-level rubric's hard threshold is `3`. The controller reads answers by question id and requires every configured question to be answered.

The TypeSafe provider requires a probability for every requested choice option. An omitted competitor is an invalid answer, not an implicit zero that enlarges the routing margin. Score distributions may remain sparse, and the provider does not renormalize vendor probabilities.

A held candidate remains selected below the configured horizon unless the current-model choice, difficulty, unavailability, allowlist removal, or existing manual/error exits return to the manual route. The initial request is judged once; while a downgrade is held, each new step gets a fresh route and difficulty judgment over the latest surface with a full capability assessment, while a same-step retry reuses its step's decision only while its complete candidate inputs are unchanged, after rechecking manual selection, allowlist membership, and capabilities. A manual, `kept-strong`, or `error` decision retains the manual route for the rest of that turn, subject to the existing mode on/off override. An accepted candidate change after the horizon records a new entry turn, which the durable fold preserves; the horizon counts turns, not steps.

Routing state follows the live session surface, including assistant and tool evidence surrounding a follow-up. Complete messages retain role and source labels; replacements suppress their shadowed history, and omitted context is explicit. The complete latest user message must fit the configured character budget. Decisions retain renderer settings, source sequences, exact questions, and detached capability assessments so a changing model catalog cannot silently alter the explanation of an earlier selection.

The request waterfall exposes detached, immutable assembled content while preserving its configuration-only rewrite authority. Candidate eligibility uses exact adapter metadata and call preparation. It preserves declared image support, reasoning settings, context capacity, and hosted tools. A conservative comparison requires candidate context capacity at least as large as the manual route's because no shared tokenizer proves exact request fit. New steps rebuild the bounded latest surface and run the full capability assessment; same-step retries recheck capabilities and manual selection before reusing their pinned judgment only when their complete candidate inputs are unchanged. Compaction can replace that context within the same turn and step, so the pin compares an exact serialized raw candidate-input key before provider fitting or redaction; the redacted fitted state's `stateHash` is not the retry key. An incompatible tool result or removed route ends the downgrade within the turn.

Selection restoration first reads the latest explicit `agent/model-selection` event. An explicit selection is durable even when no request header exists or its provider/model/effort is byte-identical to a routed header, so resume and fork preserve manual intent. Without that event, restoration uses the active streak or the decision that produced the last routed request header. Turning routing off or breaking a streak cannot promote the candidate header into the manual base. A subsequent manual header ends restoration; provider-applied default effort remains distinguishable through the header's recorded defaults.

Cancellation propagates before a decision is appended or pinned, including when a judgment provider resolves after cancellation. A retry therefore has no cancelled selection to reuse. Full-log replay and the session projection share the sticky-state transition function. Each active decision records its error limit, so mutable settings cannot reinterpret an earlier failure. Failure counts belong to one held route and reset when the streak ends or its selection changes.

A route-error break requires a manual-model recovery turn before another downgrade. The recovery decision records the current manual route, and the request-header invariant enforces that selection. Completion requires a matching manual header and a non-aborted turn end; an interrupted request or an unconsumed decision cannot spend the recovery requirement. A judgment error that returns the manual route ends the candidate streak, so a subsequent manual failure cannot count against the candidate.

Deployment mode is a durable `model-routing/configuration` fact, separate from explicit user mode. A same-valued user choice still records authority because otherwise a later settings write could reverse that choice. Live controllers reconcile their owned agents at mount and at accepted steps; cold sessions preserve recorded state until resumed. The projection starts off and reads committed events only, which also permits distinct controller defaults to share one projection definition without sharing a mutable configuration closure.

Trajectory request rows use the latest same-turn routing decision preceding the request anchor or belonging to its step. The same-step match includes decisions produced after `step/start`; the sequence comparison preserves a held route on later steps without a new decision. A later-step manual or capability exit cannot alter the route attributed to an earlier request. Entry rendering identifies a streak entry from the preceding decision, so multiple `turnsElapsed: 0` decisions in one entering turn do not create duplicate entry markers while actual candidate changes remain visible.

This decision supersedes the candidate-choice and difficulty portions of the [shipped judgment note](../feature/2026-09-20-jev-judgment-routing-shipped.md) and [routing proposal](../../proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md). Both remain active because they own the wider judgment capability, compaction, and staged escalation decisions.

## Alternatives considered

**Retain candidate-only choice and rely on confidence.** A classifier's confidence distinguishes the options it receives; it cannot supply an omitted current-model alternative. One-candidate compositions need a meaningful second option.

**Apply difficulty only after entering a streak.** The first request needs the same capability limit as later requests. An effort lift can apply below that limit but cannot override it.

**Replace routing with a trained local security model.** Security classification and task-to-model suitability require different labels and evaluations. A judgment provider can change independently after the controller's decisions are correct.

**Infer capacity from a character count or advisory model list.** Tokenization varies by provider, and catalog membership does not establish request acceptance. Exact adapter resolution supplies the capability facts; unknown capacity retains the manual route. This excludes some usable shorter-window models until request token accounting exists.

**Rejudge immediately after repeated candidate failures.** An unchanged task can produce the same high-confidence downgrade again. Requiring a manual-model turn makes error escalation affect the consumed request. Logging the effective limit also avoids a projection-cache invalidation mechanism and preserves the meaning of earlier failures across settings changes.

**Read live configuration from the projection.** A settings change would have no durable sequence to advance the change feed, and replay could reinterpret history. Recording deployment changes gives execution and the UI the same authority without introducing a projection-specific refresh protocol.

## Consequences

Routing consumes one additional option and may return to the manual model before its cache horizon. Avoiding a downgrade takes precedence over amortization when the judge explicitly prefers the manual model or rates the task too hard. The allowlist limits destinations but does not certify model strength, task completion, or security; omitted workspace evidence can still cause confident mistakes.

An explicit manual pick remains distinguishable after resume and fork even when it produces no request header or a byte-identical routed header. The durable selection event records manual intent without changing the routing policy: the router still evaluates and may apply an eligible downgrade for the current request, then returns to the recorded manual base.

Controller regressions cover entry and exit decisions, option identities, missing answers, candidate transitions, same-turn capability loss, and manual changes. Session projection cases preserve follow-up context and exclude shadowed messages. The HTTP provider composition and real headless snapshots verify that a one-candidate configuration can retain the manual model and that the request header matches the recorded decision. Classifier accuracy and cost improvement require a separate labeled evaluation; deterministic fixtures do not establish them.
