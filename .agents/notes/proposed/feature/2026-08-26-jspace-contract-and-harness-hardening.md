# Agent Note: J-Space contract — executor-enforced charter, pointer-carrying compaction, and harness hardening

Status: proposed

## Problem

Five paired experiments (w4–w8, recorded in [the W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md)) measured the long-horizon uplift and found one repeated failure class: every memory feature built as an offer the model may take up goes unused or misused. The jspace card engaged with an empty Core in 20/20 sessions, checkpointed a verifier-blind "tests green" line, shipped on it, and never closed; session-query was mounted in every sq arm and called zero times across more than one hundred trials; the always-on card costs 1.6–2.9× input tokens with no measured pass-rate benefit. The first w8 trials show the sharper boundary: with all six once-stated rules held verbatim on Core and reprinted every turn, the model still violated one, so visible prose does not survive contact with generation. The strategies that worked in every run are the enforced ones — files on disk, executed checks, refusals that name the violation. The card, the checkpoints, and the read path are organs of one product promise — the harness keeps a long-running agent on track without losing details — and they fail today because each depends on model initiative at a different point.

## Design principle

Nothing in the long-horizon path depends on model initiative; every promise is an executor-enforced gate whose refusal names the exact violation at the turn it occurs. The model requests; the executor decides.

## Proposal

Items 1–5 shipped in the [executor-enforced charter](../../implemented/feature/2026-08-26-jspace-executor-enforced-charter.md) note. Item 6 shipped in the [summary seq-pointers](../../implemented/feature/2026-08-26-compaction-summary-seq-pointers.md) note. This proposal remains open for items 7–12 and for graduating charter enablement to a shipped default via the w9 McNemar contrast.

### Phase 1 — the J-Space contract

1. **Typed charter.** `jspace_open` takes constraints as typed entries: an executable check (a command the executor can run — lint, grep, test invocation) or prose, executable preferred. Each executable entry names the constraint text it enforces. Enablement is composition-level config (an arm, preset, or deployment turns the charter requirement on), never a runtime heuristic classifying which work is "constraint-bearing" — a heuristic classifier would be uncalibrated in exactly the way the coverage-term gates were.
2. **Check substance, not check presence.** A gate on check existence can be placeholder-satisfied one level up (`echo ok` under gate pressure), the same ritual w7 measured in prose. The floor is mechanical: the executor rejects constant-success entries (commands with no workspace read). The real bar is discrimination — a check is credited only when it has been shown to fail on a violation, the runtime analog of the repo rule that a changed acceptance path must reject an invalid case; the cheap form is the harness running the check once against a seeded mutation when the charter registers, and the honest fallback where discrimination is infeasible is that the constraint↔check mapping stays unverified and the w9 arm measures net effect including gaming. This is the hardest open design item in the note, not a solved one.
3. **Charter seeding.** The harness proposes charter entries extracted from the first user message (the once-stated rules are literally there in every w6–w8 task), and the model confirms or amends rather than authoring from a blank slate. The measured root cause of empty Core is initiative; seeding removes the initiative step from capture itself.
4. **Checkpoints run the charter.** `jspace_checkpoint` executes the charter's checks and records results as verified Checked lines citing the executed calls; a failing check refuses the checkpoint with the named violation. Charter execution is a design item, not plumbing: checks route through the standard executor seam with the same policy, approval, and timeout treatment as model-issued calls (precedent: codeRuntime bindings and workflow scripts), count against the turn's budgets, and never take a privileged path.
5. **Ship gates on charter passing.** `jspace_ship` re-runs every charter check and refuses on the first failure, naming it. `requireCoreForShip` today gates on Core being non-empty; this gates on the checks passing. Checks are current-state assertions: a re-run at ship hits the workspace as it is then, hours after open. A check the workspace has legitimately outgrown is amended through a logged charter-amendment call, never bypassed; a workspace-fingerprint companion (deferred previously) is the complement that would make staleness detectable rather than discovered.
6. **Compaction leaves pointers.** Shipped: compaction summaries carry sequence references into the lossless session log on the compaction summary surface, not the card ([seq-pointers note](../../implemented/feature/2026-08-26-compaction-summary-seq-pointers.md)). `sq-adopt-2026-08-26` did not return zero (16/16 adoption on both arms; [W0 verdict](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md#session-query-adoption-result-2026-08-26)), so seq pointers proceeded as model-followed cues and harness auto-dereference was not built. The [pointer-follow bench task](../../../../bench/tasks/compaction-pointer-follow/task.json) is the remaining measurement of whether a weaker in-summary cue is followed under forced compaction.
7. **Close hygiene.** The [close-hygiene proposal](2026-08-25-jspace-close-hygiene-and-goal-card-binding.md) stands: cards close at goal end, and dangling cards become a live invariant rather than a bench-only metric.

### Phase 2 — measurement gates for phase 1

Each phase-1 item ships behind its arm; no item graduates to a shipped default without its paired contrast passing the pre-registered rules in the W0 eval note, extended with a token-neutrality rule: a charter arm must hold short-stratum input overhead under the existing 15% cap and long-stratum overhead under the report's 1.25× tradeoff bound, because the card's measured 1.6–2.9× cost is the liability the contract must retire, not grow. Arm size is pre-registered in the [W0 w9 subsection](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md#w9-pre-registration): n = 62 paired trials (31 repeats × `constraint-survival-build` + `constraint-survival-fare`) at ψ = 11/24, |δ| = 0.25, two-sided α = 0.05, power 0.8, exact McNemar; an underpowered run (realized discordant pairs < 25) reads "not yet", never "no effect". The w8 run (off vs `on-core`, n=16, forced compaction) is the input to item 1's design: prose capture alone did not move pass rate. A w9 charter-checks arm on `constraint-survival-build` plus `constraint-survival-fare` (constraints its own test suite cannot see) is the decisive run for items 1–5. A session-query adoption experiment — a task whose needed fact exists only in a prior session's event log, run with and without a driver line naming the tool at the moment of need — decides item 6's mechanism against its auto-dereference fallback; the [session-query adoption experiment](../../implemented/testing/2026-08-26-session-query-adoption-experiment.md) is that gate. A live-session dysfunction re-scan follows any default change.

### Phase 3 — harness runtime hardening (independent of jspace)

From the runtime survey of persistence, memory, tool calling, and subagents:

8. **Max-turns budget** as a guard plugin cancelling from an existing lifecycle extension point (the agent-loop README records the gap and prescribes exactly this), with a structured stop reason, plus escalation of the repeat-tool guard from advisory reminder to veto past a threshold.
9. **Registry-wide default tool timeout**, overridable per tool, engaging the fs package's recorded refusal of file-IO deadlines ("a deadline would kill work the OS will still finish"): the default must honor a definition-level opt-out so that recorded rationale stands, and the fs tools keep it unless that decision is separately revisited.
10. **Windowed in-memory session log.** A live session retains every event in memory for its lifetime regardless of compaction; flushed events outside the model surface should drop from RAM and re-read from the durable log on demand.
11. **SQLite `busy_timeout` and durable-log retention.** The persistence backend sets no busy timeout and has no pruning or rotation story; streaming chunks persist 1:1 forever.
12. **Subagent enforcement gaps.** A global concurrent-subagent cap, and honoring or loudly rejecting `maxDepth`/`toolFilter`/`outputSchema` on out-of-process providers that silently ignore them today.

Items 8 and 9 are small, unblocked, and ship first; items 1–5 build on the w8 verdict.

## Alternatives considered

**Merge jspace and session-query into one package.** Rejected as a code move: the seams evolve and die independently, and the bench prices them separately. The product-level unification is the contract above — the packages remain its implementation.

**Strengthen prompt guidance instead of gates.** Rejected: w7 measured ritual compliance with the existing guidance (stock Goal, empty Core, tests-green Checked), and w8's early trials show even captured, reprinted prose being violated. Guidance was the control arm; it lost.

**Runtime heuristic for constraint-bearing work.** Rejected: enablement is composition config; a heuristic classifier recreates the uncalibrated-gate problem the charter exists to remove.

**Retire jspace outright and keep only the log and query tools.** Premature: the enforced-charter version has never been tested, and the w8/w9 arms are the cheap way to test it. If w9 fails, retirement is the recorded fallback and the read path stands alone.

## Acceptance criteria

- Charter entries are typed and name the constraint they enforce; an executable entry is run by the executor at checkpoint and ship through the standard executor seam; refusals name the failing entry; constant-success entries are rejected, and credited checks carry a discrimination demonstration or an explicit unverified marker.
- Compaction summaries carry seq pointers on the summary surface; a bench task exists whose resolution requires dereferencing one.
- The w9 arm and the session-query adoption experiment run at power-analysis-derived n with verdicts recorded against pre-registered rules, including the token-neutrality bounds.
- Max-turns and default tool timeout land as validated config with loud stop reasons, the timeout default honoring definition-level opt-outs.

## Risks

- **Placeholder satisfaction moves up a level**: a gated model can write hollow checks; the discrimination bar and the w9 measurement are the mitigations, and if gaming wins there, the recorded fallback is retirement, not a stricter ritual.
- **Executable checks are a sandbox surface**: charter commands run with tool authority; they must route through the same executor policy as model tool calls, never a privileged path.
- **Gate friction on honest work**: over-strict refusals teach gaming; every refusal must be satisfiable and name the exact fix.
- **Charter staleness**: checks fixed at open run against a workspace that evolved; the amendment path and fingerprint companion bound the hazard.
- **Small-n verdicts**: w7's reversal of w6 shows n=2 hints are noise; no default flips without the pre-registered thresholds at powered n.
