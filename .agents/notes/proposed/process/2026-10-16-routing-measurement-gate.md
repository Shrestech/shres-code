# Agent Note: The routing measurement gate

Status: proposed

This note records why the PR 16 routing measurement is built the way it is, which
parts are provisional until the integrating PRs land, and what the calibration
step must do before any confirmatory trial runs. It supersedes plan §5 details
where they differ, notably arm N as a bench-only seeded engine and the idle-gap
cap. The preregistration is
[`bench/routing/prereg-2026-10.md`](../../../bench/routing/prereg-2026-10.md)
with `bench/analysis/routing-gate.js` as the method of record.

## Decisions

- **The gate is a module, not a convention.** H1–H5, the Holm family, the
  screens, and the power reading live in `bench/analysis/routing-gate.js`.
  The preregistration prose states the rules; the module is the executable
  authority, and a changed rule is a new experiment name. Rejected
  alternative: recomputing the math by hand in the report, which is how the
  pilots drifted from their own preregistrations.
- **Robustness screens refuse rather than default.** Lost turns and routing
  invariant failures are counted from session-log facts the integrating PRs
  have not landed yet; while their sources are absent the facts are null and a
  null screen cannot yield a PASS. Rejected alternative: defaulting missing
  counters to zero, which would let an uninstrumented run pass its own gate.
- **bench-random is a workspace package, not a bench file.** The pinned arm
  overlays are path-free by convention, so a bench-relative plugin path could
  not be emitted verbatim across machines; a small
  `@shres-code/shres-code-judgment-bench-random` package follows the
  typesafe/laya/shield engine-seam pattern. Its draws are logged at info and
  replay exactly from the configured seed.
- **Provisional pins never claim calibration.** Arm R's operating point and
  arm N's entry rate and seed are placeholders so the compositions load, and
  they deliberately carry NO `calibratedBy`: in the router that key's presence
  alone marks a point calibrated, so shipping it would misrepresent an
  enforced gate that has not run. `replay-judges.mjs` is the sole writer of
  the id, the threshold and margin, and the matched rate, and the runner
  refuses confirmatory trials unless the registration records a passed gate
  and the overlay equals it (aegis §10.4).
- **Idle gaps are capped, not discarded.** L1/L2 realize
  `min(drawn, 20 min)` and keep the drawn value in the trial record, so the
  over-1-hour stratum is visibly truncated and the report names it unmeasured.
- **Arm T never runs shadow with live children.** Shadow means no request in
  the session is rewritten, children included, so T composes `initialMode: on`
  with no judgment service: main consults keep with `engine-absent` (or
  `warm-prefix` after PR 12), static child policies need no engine, and the
  audit requires zero main downgrades with at least one routed child per
  delegating task (aegis §10.2).
- **Model ids are pinned by provenance.** The strong arms hand-declare
  `anthropic/claude-opus-5-5` from the spec metadata (its metered-key API
  acceptance is unproven until the owner-approved first run), and the cheap
  route is the proven `deepseek-v4-flash`, billed at V4.1-Flash rates through
  the `2026-09-26` alias snapshot row; published snapshots are never edited
  (aegis §10.3).

## Blocked on the integrating PRs

Arm R's overlay pins the PR 12 surface (quota cold-point entry without
`allowEveryTurn`, `initialMode` values) and arm T's pins the PR 13b surface
(`childPolicies`, `childRouteErrors`). Both fail the harness load, by name,
until the integrating branch carries them; the multiturn execution path is
refused, fail-loud, until the harness grows the headless follow-up surface the
bench's `resumedFrom` field has always anticipated.

## Coverage gaps

- The multiturn runner execution, the per-trial gap records in
  `trials.jsonl`, and the headless follow-up surface are not implemented in
  this commit; the task format, the sampler, and the dry-run path are.
- The gate's log extractor (strong-route token classes, cold-write totals,
  judge critical-path samples) lands with the session-log fields it reads.
- The gap anchor table's interior points interpolate the two measured
  quantiles; the real logged table replaces them only before the calibration
  run.
