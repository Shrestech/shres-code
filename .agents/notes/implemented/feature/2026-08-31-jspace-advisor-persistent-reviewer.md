# Agent Note: jspace-advisor standing continuable reviewer

Status: implemented

## Problem

The proactive advisor ran a fresh one-shot reviewer child per trigger ([the one-shot note](./2026-08-30-jspace-advisor-oneshot-drift-reviewer.md)). Each reviewer re-derived its judgment from a cold digest that carries no prior advice: verdicts oscillated, repeated redirects could not be recognized as ignored, and every trigger re-paid the persona plus the full digest. The consult channel is synchronous and rare, so the cost is concentrated in the trigger cadence.

## Decision

The proactive channel now runs one standing continuable child per root session; consult stays one-shot.

- **One advisor per session.** The first trigger calls `ctx.subagents.startContinuable` on the configured `subagentProvider`; every later trigger delivers a `followup` turn. The `spawn` provider already implements `prepareContinuable`, so no provider changed. After a process restart the advisor reattaches through the latest `jspace/advisor` event's `childId`, relying on the continuation manager's cold resume.
- **Deltas after the first turn.** Turn one carries the full digest; later turns carry `foldAdvisorDelta`: the U1 goal anchor, user messages since the last review, the current card, the trailing tool window inside the delta, and the step count. The reviewer keeps earlier verdicts in its own conversation instead of re-reading a full digest.
- **The verdict is the final reply JSON.** Continuable children accept only persona and toolFilter composition — there is no per-child structured-output tool — so the persona fixes the reply protocol (one JSON object, nothing else) and `parseReviewVerdict` validates it at the model boundary, accepting bare, fenced, or embedded objects. This differs from the rejected skeleton channel ([2026-08-30 note](./2026-08-30-jspace-advisor-oneshot-drift-reviewer.md), Problem): the plugin reads the exact child session's `turn/end`, not a settlement notice, so attribution is exact; triggers still classify on committed events; and the parent append runs in the awaiting continuation after the verdict resolves, outside the child event's publication window.
- **Failure discards the advisor and cools down cadence.** A failed start, a verdict-less turn, or a timeout (`reviewTimeoutMs`, interrupt + collect) marks the run unhealthy: the child id is dropped so the next trigger cold-restarts a fresh advisor, and drift/error-burst triggers wait for the next user message while goal-epoch and charter triggers always run. The old design re-fired failed reviews every 8 steps with no suppression.

## Consequences

- `settleReview` and `REVIEW_OUTPUT_JSON_SCHEMA` are gone; the review module owns the prompt builders, the delta builder, and the parser. Consult keeps its one-shot `outputSchema` capture.
- The subagent seam needs no change; a per-child setup contribution on `startContinuable` is the documented follow-up if reply-JSON parsing ever proves too loose, and `registerContinuableSetup` stays wrong for this because it mounts into every continuable child.
- The invariant companion is unchanged: every `jspace/advisor` event still carries `triggerSeq` with increasing drift-check pointers; `childId` now names one standing child except across cold restarts.

## Verification

Unit suites cover the delta fold (boundary, window pairing, render) and the verdict parser (bare/fenced/embedded/invalid). The apply-level harness patches the real subagent runtime's continuable operations with scripted advisor children that deliver verdicts through real child-session events: one drift review, one standing child reused across reviews with a delta second turn, section rendering, seat-off withdrawal, start failure, verdict-less turn with cold restart and drift cooldown, redirect-less drift, and fiber-dispose abort with one interrupt. A Loader-booted composition spec still passes unchanged.
