# Agent Note: J-Space chain gym, arm-integrity audit, and report UI v2

Status: implemented

## Problem

The [W0 benchmark suite](2026-08-18-jspace-w0-benchmark-suite.md) shipped with three gaps. First, it measured only single-session tasks, but the session boundary is where the card's value should be most visible: a fresh process loses everything the workspace does not record. Investigation showed the boundary cannot be crossed by the bench today — automation entries are fresh-only by design ([acp-demo README](../../../packages/examples/acp-demo/README.md)), the SDK exposes no resume/fork, and while the session layer supports `parentSession`+seed lineage and the jspace seat implements copy-on-fork, no entry point reaches them. Second, three pilot tasks cannot power a paired test (the demo's +21 points at n=5 graded TIE, McNemar p=0.14): statistical power lives in the catalog. Third, the v1 report UI was too basic for the data: no per-phase visibility, no sorting, weak information hierarchy. A fourth concern — cross-trial memory leakage — turned out structural: the card lives in the session log, so the runner's fresh spawn per trial starts every card empty; the leak vector would be fork/resume across trials, which the bench never performs. That invariant had to be code, not hygiene.

## Decision

**Chain tasks.** `task.json` gains `phases` (≥2 entries, each `{ instruction, timeoutMs? }`); its presence replaces the top-level `instruction` (the two together fail loud at catalog load), and top-level `timeoutMs` becomes the per-phase default. A chain trial creates its scratch dir once (the workspace carries) and spawns each phase as a separate headless run with a fresh `sessions/<taskId>/<trialIndex>/phase-<i>` root (sessions do not carry — cold carry). The verifier runs once after the final phase; a PROVIDER_ERROR or HARNESS_ERROR aborts the chain early with the phases-so-far recorded. `Trial` gains optional `phases[]` (per-phase `sessionFile`, `exitCode`, `timedOut`, `metrics`, and `resumedFrom` — always `null` today; it is the slot card-carry populates once the [headless fork uplift](../feature/2026-08-18-headless-session-fork-for-automation.md) lands) and optional `integrity: { violations: string[] }`. Trial metrics are per-phase sums; the pairing key (`taskId` + `trialIndex`) and all paired statistics are unchanged.

**Arm-integrity audit.** Coded into the runner for every trial: the pre-trial session root must not already exist (`session-root-preexisting:*`), and the off arm's session logs are scanned for any `jspace/*` event (`off-arm-jspace-event:*` — proves overlay leakage). Violations are recorded on the trial and surfaced in the report; they never abort the experiment.

**Gym catalog.** Four tasks, each discrimination-proven (pristine fixture fails the verifier, a hand-written solution passes, verifier idempotent): `chain-debug-resume` (diagnose-then-fix across a boundary; cold phase 2 pays re-diagnosis tokens), `chain-lib-extend` (a README-pinned locale constraint a cold phase 2 must rediscover), `compaction-stress-constraints` (single session, 5.2 KB instruction, global constraints stated once and checked mechanically — the stratum where card and compaction fight), and `math-derivation-chain` (stateful two-session derivation through a workspace artifact). The catalog stratum enum gains `chain`. The sanctioned compaction-forcing knob is documented (`BasicCompactionConfig.thresholdRatio`) for future overlay use; overlay support is intentionally not built.

**Report UI v2.** Same zero-build/zero-dependency DOM+SVG architecture, rebuilt design: token-based dark design system, hero verdict banner (grade, Δ accuracy with bootstrap CI, McNemar p, token overhead), stat cards with sparklines, matrix stratum subtotals and chain badges, sortable trials table with integrity badges, a per-phase expander (verifier block + phase table with token bars, `cold`/`warm` resume labels), and a chain-phase chart section with a task picker. `model.js` mirrors `bench/stats/` algorithms (mulberry32/bootstrap/Wilson/pairing) because the report server roots at `bench/ui` and the browser cannot import across it; `bench/ui/CONTRACT.md` records the must-stay-equivalent obligation.

## Alternatives considered

**Add headless fork support in the same change.** Rejected: it is product surface (automation entries are deliberately fresh-only) and deserves its own review; filed as the [fork uplift proposal](../feature/2026-08-18-headless-session-fork-for-automation.md) instead. Chains ship cold-only until then.

**Simulate card carry by injecting phase-1 findings into the phase-2 prompt.** Rejected: it measures the bench's prompt engineering, not the product — the intervention would no longer be the jspace machinery.

**LLM-judge the chain handoffs.** Deferred with the rest of judge scoring: outcomes stay verifier-decided; the chain verifiers check end state (tests, constraint scans, exact numeric answers).

**Share `bench/stats/` with the browser via import.** Rejected: the static report must stay a single-root zero-build artifact; the mirrored algorithms carry an equivalence contract instead.

## Consequences

Chains run end-to-end today with cold carry; the decisive card-carry experiment remains blocked on the proposed uplift, and `resumedFrom: null` in every trial is the visible marker of that. The catalog is 7 tasks (3 pilot + 4 gym) across 4 strata; the demo experiment carries 2 synthetic chain tasks so every chain surface is exercisable without an API key. Real runs still need `pnpm install` and `DEEPSEEK_API_KEY`. The mirrored stats in `bench/ui/model.js` are a maintenance obligation enforced by convention (CONTRACT.md), not by a gate.

## Testing

`node --test bench/tests/*.test.js` — 137 tests: chain catalog validation, dry-run plan, fake-harness chain execution (cold per-phase roots, carried workspace, provider-error abort, phase timeout → AGENT_TIMEOUT), both integrity violations, report building over chain data, UI views against an extended fixture (phase expander, violation badge, sorting, empty state). The assembled report was browser-verified on regenerated demo data across all four views; a duration-formatting boundary (`2m 60s`) found there is fixed with a regression assertion. Gym verifiers were discrimination-proven in `/tmp` (pristine fails, hand-solved passes, idempotent, negative probes named per task).

## Related

- [J-Space W0 benchmark suite](2026-08-18-jspace-w0-benchmark-suite.md) — the suite this extends.
- [Headless session fork for automation](../feature/2026-08-18-headless-session-fork-for-automation.md) — the uplift that unblocks card-carry chains.
- Deployment reviews: [Claude](../feature/2026-08-18-jspace-deployment-review-and-uplift-claude.md), [Kimi](../feature/2026-08-18-jspace-deployment-review-and-uplift-kimi.md).
