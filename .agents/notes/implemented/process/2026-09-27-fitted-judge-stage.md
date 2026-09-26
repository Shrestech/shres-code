# Agent Note: Fitted-judge stage (prepare-only by default)

Status: implemented

## Problem

Prepared replay rows carry consult inputs but no fitted answers. Calibration needs one live-equal fitted ask per eligible consult, with honest unanswered rows when the engine is unfit, errors, misses the deadline, or returns an invalid answer. A prepare-only host must not call judgment at all.

## Decision

`judgeReplayRows` asks `fittingFor(MODEL_ROUTER_JUDGMENT_CONSUMER)` once per eligible consult (`kind === 'ask'`) with the consult's `states` and `questions`, `tier` from the resolved R config, and `correlation = { sessionId, consultKey: 'turn:t/step:s' }`. The deadline is `AbortSignal.timeout(config.judgmentDeadlineMs)`; a post-deadline answer is discarded. `hostReplayTrial` / `hostReplayRun` take `judge` defaulting to false, so prepare-only runs write zero asks. Pre-flight `UsageError` covers disabled judgment, a non-fitting engine, missing `difficultyInstructions`, and a refused `routingCalibration` of the public `ctx.judgmentEngines.get(id).descriptor.calibration`. Answered rows set `truncated = fit.selectedIndex > 0` and `headTokens = max(sequenceTokens) − stateTokens`. Unanswered rows keep null score fields and leave prepared labels unchanged.

## Alternatives considered

**Judge inside `replayConsultInput`.** That would mix consult construction with calibration answers and would run on prepare-only hosts. The stage is opt-in after prepared rows exist.

**Reach into dispatcher internals for calibration.** The router already reads `entry.descriptor.calibration` through `ctx.judgmentEngines.get`. That public registry path is enough.

**Invent or drop labels so a mixed S/C run passes the whole-run gate.** Labels belong to the labeller. This stage spreads prepared rows and writes only score fields.

## Consequences

Prepare-only hosts stay prepare-only. Eligible consults get exactly one fitted ask. Failures stay unanswered with the reason in the asks log, not on the row. S unlabelled / `task-outcome-unknown` labels survive. The product judgment API is unchanged.
