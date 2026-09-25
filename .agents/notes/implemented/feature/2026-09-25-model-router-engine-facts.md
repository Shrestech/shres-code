# Agent Note: The router records what each judgment call cost and gates per engine

Status: implemented

## Problem

The router asked `ctx.judgment` without naming itself, so a `judgment.overrides` entry for it had no effect, and it read the deployment-wide `fitting` even when an override would route its fitted asks to another engine. Its decisions recorded the answering engine's name, model, and latency only for an answered call: a failed call left no latency and no engine, the capability assessment on the critical path was not timed, and neither the judge's own token usage nor the characters sent to it were logged. A bench trial therefore undercounted the router's critical path, and the routing card could not attribute its stats to a registered engine.

Judgment failures were counted without an engine. After a switch from engine A to engine B, A's failures kept B from being asked for up to `breakerOpenTurns` turns, and Laya's `UNAVAILABLE` answers while its gateway loaded counted as failures: turning routing on during a load could open the breaker and cost about eight turns of routing after Laya was ready. A coded failure that arrived after the deadline was recorded as `DEADLINE`, so a slow `INPUT_TOO_LARGE` rejection was tolerated as a held failure instead of ending the streak.

Every engine was gated by the same global thresholds, although thresholds do not transfer between engines, and an LLM judge's stated probabilities gated routing exactly like a classifier's calibrated ones.

## Decision

**Consumer id and fitting per consumer.** `JudgmentService` gains `fittingFor(consumer)` and `selectedEngine(consumer)`; a single-engine service answers with its own `fitting` and selects nothing, and [judgment-dispatch](../../../../packages/llm/judgment-dispatch/README.md) answers with the engine its settings select for that consumer. `JudgmentError` gains an optional `engineId`, which the dispatcher sets on every failure of a routed ask, re-creating an engine's error with the same code, message, and cause. The router declares consumer `model-router`, names it on every ask, reads its fitting through `fittingFor`, and reads the selected engine before it asks.

**Engine facts on every call.** Decisions gain optional `engineId`, `judgeUsage` (the engine's own `TokenUsage`), `eligibilityMs`, and `inputChars` (the state characters handed to the engine: the one state of a plain ask, or every alternative a fitted ask offered), so earlier logs replay. A failed call records the router's wall-clock `latencyMs` and the `engineId` its failure carried, or the one selected before the ask; it records no `engine` name, which only an answer carries. A coded failure is classified by its code whenever it arrives; `DEADLINE` is a cancellation or an uncoded failure after the deadline, or an answer that arrived after it. [bench/runner/accounting.js](../../../../bench/runner/accounting.js) reads `judgeUsage` and attributes a failed call to its `engineId`.

**Failures per engine; warm-up is not failure.** The fold's `judgmentFailures` records the `engineId` its calls were routed to; a failure routed to another engine starts a new count, and the consult reads the count only against the engine selected for `model-router`, so a switch clears the breaker and the hold tolerance at once. A count logged before the field matches any engine. A selected engine whose registry status is `starting` or `not-installed` is not asked: the decision records `engine-unavailable`, or `judgment-failure-held` while a streak holds, with `engineFailure: { code: 'UNAVAILABLE', engineState }`, and the fold does not count it. A registered engine that is `unavailable` is still asked and counts.

**Operating points.** `operatingPoints: [{ engine, downgradeThreshold, downgradeMargin, calibratedBy?, acceptVerbalized? }]` is optional. The point for the selected engine replaces the global thresholds, and every answered decision records `thresholds`, the values in force in a fixed key order: the two floors applied, `entryScoreCeiling` and `escalateBackScoreThreshold` when the difficulty question was asked, `source: 'operating-point' | 'global'`, and `calibratedBy` when the point names the preregistration that set it. A selected engine whose descriptor declares `verbalized` calibration is refused as `engine-uncalibrated`, with no eligibility check and no call, unless its point sets `acceptVerbalized`, the verbalized-engine policy of the [redesign plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md). A point naming an engine no provider registered is reported at error level once after the Loader settles and on each later change that introduces one. Points are written only through the settings file today; a write path that edits them, such as a Settings control, rejects a changed point naming an unregistered engine at `['operatingPoints', i, 'engine']`.

**Decide on the engine that answers.** The dispatcher reads its selection when a call is made, and the capability assessment before the call awaits, so the selection or an engine's status can change between the router's first checks and the call. The router therefore takes its engine snapshot twice: before the assessment, where the selected engine can only refuse the consult early, and immediately before the call, with no await in between, where it re-checks the breaker, the verbalized refusal, and warm-up for the engine the call goes to. A result or failure stamped with a different `engineId` is judged against the engine that produced it, and the refusal is enforced at the gate: an answer from a refused engine is recorded and discarded as `engine-uncalibrated`. A failure from an engine whose status reads `starting` or `not-installed` when the failure arrives is warm-up and is not counted.

**Deviation from the redesign plan's §R1.4.** §R1.4 made every engine without an operating point fail closed as `engine-uncalibrated`. Engines calibrated by design (Laya, TypeSafe, Shield) without a point route on the global defaults instead, recorded as `source: 'global'` with no `calibratedBy`, so the owner can test routing with Laya before any preregistration has produced a point; only a `verbalized` engine is refused. Turning routing on by default still requires calibrated points, under the plan's §5.8 criteria.

## Alternatives considered

**Fail closed for every engine without a point, as §R1.4 wrote.** No engine has a calibrated point until the multi-turn routing suite and its preregistration exist, so routing could not be exercised on any engine, including Laya, which is calibrated by design. Recording `source: 'global'` keeps every such decision visibly uncalibrated, and default-on stays gated on calibrated points.

**Keep one failure count and reset it when a decision names a new engine.** A reset in the fold alone would still let the consult open the breaker on the old count at the first consult after a switch, before any call to the new engine is recorded; reading the count against the engine selected before the ask is what lets the new engine be asked at once.

**Count warm-up failures but raise the threshold while an engine starts.** The registry already states that the engine cannot answer, so asking only produces a known `UNAVAILABLE` and spends the turn's judgment budget; not asking, and not counting, is both cheaper and exact.

**Enforce the verbalized refusal in the dispatcher.** The dispatcher would have to read the router's operating points to know which asks to refuse, and the judgment seam leaves every threshold and every decision taken from an answer to the consumer. The router makes the decision at its gate, where it refuses both before the call and on the answer.

**Wrap an engine's failure without re-creating it.** Mutating the thrown error would change an object the engine may still hold; re-creating it keeps the code, message, and cause and adds only the id.

## Consequences

- `judgment.overrides.model-router` routes the router's asks, fitted asks included.
- A decision's `thresholds.source` and `calibratedBy` show whether a downgrade passed calibrated thresholds; routing on Laya without a point is visibly uncalibrated in every decision and on the routing card.
- The projection state version moves to 10, so persisted projection caches rebuild from the log.
- The snapshot normalizer zeroes `eligibilityMs` and `latencyMs` on `model-routing/*` records, which are wall-clock measures.
- The engine id is recorded when the service selects one: a deployment that composes a single `ctx.judgment` provider without the dispatcher records no `engineId`, and operating points never apply to it.

## Verification

- judgment-dispatch `dispatch.spec.ts`: per-consumer fitting under an override, engine-stamped failures (engine errors, the dispatcher's own, fitted asks), and the unchanged propagation of an already-stamped or non-judgment failure.
- model-router `controller.spec.ts`: the consumer id on every ask and its declaration, answered and failed call facts, the late coded failure classes, per-engine failure counting and its breaker and tolerance resets, warm-up in both statuses and while a streak holds, the verbalized refusal with and without an accepting point, calibrated and global thresholds, and the unregistered-point report; `config.spec.ts` pins each operating-point error.
- model-router `engine-composition.spec.ts`: a real Loader composition of the router, judgment-dispatch, and registered engines, in which four warm-up consults open no breaker and a settings switch of `judgment.engine` asks the new engine at once. A switch to a `verbalized` engine made while candidates are assessed records `engine-uncalibrated` and asks nothing, and a switch to a `starting` engine, or a status change to `not-installed`, during the assessment records warm-up and is not counted; both fail against a router that reads the engine only before the assessment.
- `bench/tests/routing-accounting.test.js` drives the built router, dispatcher, and a registered judge and folds the resulting log: answered and failed calls, the critical path, and the priced judge usage.
- The keyless `model-router-llm-judge` snapshot routes on `judgment-llm` accepted through its operating point; without `acceptVerbalized` it records `engine-uncalibrated`.
- Negative controls: removing per-consumer fitting, the error stamping, the consumer name on the ask, the per-consumer fitting read, the late-code classification, the pre-ask engine fallback, the consumer declaration, the warm-up detection or its fold exclusion, the per-engine breaker read or count reset, the verbalized refusal, the point thresholds in the gate, the recorded `calibratedBy`, the unregistered-point report, or the duplicate-point check each fails its named test.
