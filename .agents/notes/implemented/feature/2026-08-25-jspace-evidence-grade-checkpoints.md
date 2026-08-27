# Agent Note: J-Space evidence-grade checkpoints

Status: implemented

## Problem

`jspace_checkpoint` accepted any `by` string that matched a coverage term, and optional `evidence` only required a completed non-error `tool/call` in the session log. [Live-session forensics](../../proposed/feature/2026-08-24-jspace-live-session-forensics.md) show models padding `by` to satisfy that match, so `jspace_ship` enforced ritual around an honor-system core. The [long-horizon uplift plan](../../proposed/feature/2026-08-25-long-horizon-harness-uplift.md) named a verifier-citation evidence class as W2; a workspace fingerprint (git status/diff hash) was in the same plan and needs an fs/shell seam decision that this change does not make.

## Decision

A checkpoint whose `evidence` cites a call-id is evidence-grade when that call-id resolves, by the same `tool/call` plus non-error `tool/result` walk `checkpoint()` already used, to a completed call whose `name` is in seat config `verifierTools`. Classification writes optional `verified: true` on the Checked line inside the existing `jspace/card` snapshot so the grade is reconstructable from the log. `jspace/card` writers already pass `{ ignorable: true }`, so the optional payload field does not bump `SESSION_FORMAT_VERSION` ([session-log versioning](../architecture/2026-08-10-session-log-version-mechanism.md)).

`verifierTools` defaults to `[]`, which leaves classification dormant: a cited call still has to be a completed non-error tool call, but the line is not marked `verified`. `requireCoverage` is unchanged and remains the floor for ordinary checkpoints.

`requireVerifiedEvidence` defaults to `false`. When true, `jspace_ship` still requires a checkpoint at or after `goalOpenedSeq` for the current Goal epoch ([goal-epoch reset](../bug-fix/2026-08-24-jspace-goal-epoch-reset.md)), and then refuses unless that epoch also grew a `verified: true` line. The model-visible refusal is `jspace ship requires an evidence-grade checkpoint that cites a completed non-error verifier tool call`.

The workspace fingerprint named in W2 is deferred: this change does not hash git status or diff, does not refuse a re-cited verifier result after the workspace changes, and does not skip a passed gate on an unchanged workspace. That class needs an fs/shell seam decision before it can be recorded on the checkpoint payload.

No ACP snapshot scenario under `examples/acp-agent` pins the new checkpoint description or ship refusal; recording one needs `DEEPSEEK_API_KEY`, which was unavailable. Package unit tests and the keyless `evidence-grade.e2e.ts` cover classification, rejection paths, ship refuse/pass, and default-off dormancy.

## Alternatives considered

**Reject a checkpoint whose `evidence` names a non-verifier tool.** Rejected: `evidence` remains a completed-call citation for any tool; evidence-grade is an additional class on top of that walk, not a new refusal for ordinary checkpoints.

**LLM-as-judge or a stricter keyword list on `by`.** Rejected in the [uplift plan](../../proposed/feature/2026-08-25-long-horizon-harness-uplift.md): forensics classify judge/keyword gates as gaming surfaces; the log can prove an executed verifier, not a padded claim.

**Implement the workspace fingerprint in the same change.** Rejected for sequencing: hashing git status/diff/untracked needs an fs/shell seam that this workstream does not own; shipping a half-fingerprint would invent a read path the plan told us not to invent.

**Bump `SESSION_FORMAT_VERSION` for `verified`.** Rejected: the field is optional on an already-`ignorable` `jspace/card` payload; old readers skip the event, and new readers treat a missing `verified` as not evidence-grade.

## Consequences

Deployments that set `verifierTools` and `requireVerifiedEvidence` can refuse a keyword-only ship; default-off compositions behave as before. A cited verifier result still counts after the workspace changes, because the fingerprint class is deferred. Assembled-application snapshots do not yet pin the model-visible description or refusal sentence.
