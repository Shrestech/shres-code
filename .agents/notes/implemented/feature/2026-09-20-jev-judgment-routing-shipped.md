# Agent Note: Typed-judgment seam — shipped routing, compaction, and escalation surfaces

Status: implemented

## Problem

The harness needed rented calibrated judgment for two decisions — which model should serve a turn, and what a delegated worker still needs — without letting a classifier's generated text reach execution.

## Decision

One seam with staged consumers. The [routing choice and difficulty decision](../bug-fix/2026-09-22-routing-choice-and-difficulty.md) owns the current-model option, score scale, and sticky candidate transitions; it supersedes those portions of this record.

- `ctx.judgment` (`packages/llm/judgment`, `packages/llm/judgment-typesafe`): choice/score/noul questions against TypeSafe's systemone API; the deployment switch treats off as exactly absent; request redaction has one home, the provider, and transient 429/529 refusals retry once after a validated wait with a spent budget surfacing the same UNAVAILABLE failure as before.
- `model-router` (`packages/llm/model-router`): downgrade-only sticky routing with the allowlist as the enforcement point, `minTurnsDowngraded` hysteresis, the `/route` command, and the `modelRouting` projection, which initializes `active: false`. `modeOf` folds `foldModelRouting` with its `initialMode` argument at the default `false`, so the projection and the consult agree that an eventless log is off. The configured `initialMode` reaches the log only when `reconcileConfiguration` commits a `model-routing/configuration` event (`packages/llm/model-router/src/index.ts:402-408, 511-521, 567`). `lastStrong` retention powers the chip's restore gesture.
- `compaction-jev`: verify-then-escalate range selection over the basic engine's protected `selectRange` hook.
- Bench (`bench/`): frozen route/compact arms under preregistration, executable verdicts, and the strength-per-realized-cost model ranking (`bench/analysis/model-ranking.js`) — tokens are the only cost currency, never a price table.
- Web surfaces: the Classifier settings card and engine-capability filter, the state-only routing chip (`ui-model-routing`) that never names the routed model at the chat surface, and trajectory ROUTING rows with the Routed badge and streak-break reasons (`ui-trajectory`).
- Worker escalation (`packages/team/worker-escalation`): Stage 0 deterministic triggers with the report-blocked terminal, the Stage 1 Jev observer (two-option, logged, executes nothing), and ask-to-escalate that rides the Team root for owned children, default off.

## Alternatives considered

A flat four-way choice question (base or one of three candidates) lost to cascaded gates: choice probabilities wobbled up to 0.06 run-to-run, so only wide margins decide, and a margin-gated two-option cascade degrades gracefully where a flat four-way collapses. A transition-cost estimator with per-model rate ratios was rejected because provider-controlled ratios go stale exactly like prices; realized usage from logged turns is the only cost currency. An acting escalation rung before labeled data exists was rejected — the Stage 1 observer exists to produce that data. Consumer-side request redaction was rejected in favor of one home at the provider.

## Consequences

Chat-surface state is model-silent by contract; routing detail lives in the trajectory and the durable log. The chip's pre-session placeholder reads off until a session exists; a composed session reports the mode in force. Stage 2 (flash consult) and Stage 3 (planner) stay evidence-gated on Stage 1 labeled data: the live proposal [2026-09-17 typed-judgment routing and compaction](../../proposed/feature/2026-09-17-jev-judgment-routing-and-compaction.md) remains the plan of record for the unshipped rungs and owns the debate outcomes.
