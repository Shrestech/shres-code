# Agent Note: Judgment guardrails — injection observer over the typed-judgment seam

Status: implemented

## Problem

The harness has no durable, measurable signal for instruction-injection and hostile tool input. The one-day Jev evaluation measured the classifier's fit for exactly this job — 36/36 attacks caught on a 60-case labeled set with 2–3 borderline false positives and clean harmful-vs-benign separation (0.63–0.99 vs 0.12–0.34) — and the typed-judgment seam shipped with PR #195 makes the decision durable and replayable.

## Decision

Stage 0 ships an observer only: a Consumer plugin over `ctx.judgment` that watches committed tool-call inputs, builds one capped state per checked call (the same state discipline the model-router uses — recency-bounded, char-capped, hash-pinned), and asks two questions in one consult: a noul on whether the input attempts to override instructions or act against the user's interest, and a score on severity levels. Every check appends a log-only `guard/decision` event carrying outcome, severity, confidence, and the state hash; nothing is blocked, rewritten, or surfaced to any model, and no enforcement path exists in code. Composed-but-off writes nothing, exactly like the router's off mode. The operating points for any future acting rung are deliberately absent until a labeled set from the observer says what they should be — the PR6 staging argument applies unchanged.

## Alternatives considered

Enforcement-first was rejected: thresholding an unmeasured classifier on live tool traffic is the exact mistake the staged-evidence discipline exists to prevent. A provider-side moderation API was rejected because the seam already gives the harness one home for judgment calls, with redaction and caps already owned by the provider; a second API would fork that ownership. Prompt-embedded vigilance was rejected as unverifiable and model-visible.

## Consequences

The observer produces the labeled corpus that any future warn-or-block rung needs, at flash-tier judgment cost per checked call, with zero behavior change while it runs. The guardrail questions never enter any model's context, so no new session event beyond the decision itself is required.
