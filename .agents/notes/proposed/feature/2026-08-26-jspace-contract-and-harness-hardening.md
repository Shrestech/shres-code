# Agent Note: J-Space contract — executor-enforced charter, pointer-carrying compaction, and harness hardening

Status: proposed

## Problem

Five paired experiments (w4–w8, recorded in [the W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md)) measured the long-horizon uplift and found one repeated failure class: every memory feature built as an offer the model may take up goes unused or misused. The jspace card engaged with an empty Core in 20/20 sessions, checkpointed a verifier-blind "tests green" line, shipped on it, and never closed; session-query was mounted in every sq arm and called zero times across more than one hundred trials; the always-on card costs 1.6–2.9× input tokens with no measured pass-rate benefit. The first w8 trials show the sharper boundary: with all six once-stated rules held verbatim on Core and reprinted every turn, the model still violated one, so visible prose does not survive contact with generation. The strategies that worked in every run are the enforced ones — files on disk, executed checks, refusals that name the violation. The card, the checkpoints, and the read path are organs of one product promise — the harness keeps a long-running agent on track without losing details — and they fail today because each depends on model initiative at a different point.

## Design principle

Nothing in the long-horizon path depends on model initiative; every promise is an executor-enforced gate whose refusal names the exact violation at the turn it occurs. The model requests; the executor decides.

## Proposal

### Phase 1 — the J-Space contract

1. **Typed charter.** `jspace_open` takes constraints as typed entries: an executable check (a command the executor can run — lint, grep, test invocation) or prose, executable preferred. A charter with no checkable entry is refused on constraint-bearing work, extending `requireCoreOnOpen` from presence to substance.
2. **Checkpoints run the charter.** `jspace_checkpoint` executes the charter's checks and records results as verified Checked lines citing the executed calls; a failing check refuses the checkpoint with the named violation. A checkpoint can no longer certify a criterion the charter does not contain, which structurally removes the w7 false-assurance mode.
3. **Ship gates on charter passing.** `jspace_ship` re-runs every charter check and refuses on the first failure, naming it. `requireCoreForShip` today gates on Core being non-empty; this gates on the checks passing.
4. **Compaction leaves pointers.** Compaction summaries carry sequence references into the lossless session log, kept visible with the pinned card. Session-query's measured adoption is zero when offered as a tool; a visible reference the model can dereference converts retrieval from initiative into instruction-following, and is the integration point between the write path and the read path.
5. **Close hygiene.** The [close-hygiene proposal](2026-08-25-jspace-close-hygiene-and-goal-card-binding.md) stands: cards close at goal end, and dangling cards become a live invariant rather than a bench-only metric.

### Phase 2 — measurement gates for phase 1

Each phase-1 item ships with its arm; no item graduates to a shipped default without its paired contrast passing the pre-registered rules in the W0 eval note. The w8 run (off vs `on-core`, n=16, forced compaction) decides whether prose capture alone moves pass rate and is the input to item 1's design. A w9 charter-checks arm at n≥16 on `constraint-survival-build` plus one task whose constraints its own test suite cannot see is the decisive run for items 1–3. A session-query adoption experiment — a task whose needed fact exists only in a prior session's event log, run with and without a driver line naming the tool at the moment of need — decides item 4's mechanism. A live-session dysfunction re-scan follows any default change.

### Phase 3 — harness runtime hardening (independent of jspace)

From the runtime survey of persistence, memory, tool calling, and subagents:

6. **Max-turns budget** in the agent loop with a structured stop reason, and escalation of the repeat-tool guard from advisory reminder to veto past a threshold. No turn limit exists today anywhere in the loop or guards.
7. **Registry-wide default tool timeout**, overridable per tool. The timeout guard arms only for tools that declare `timeoutMs`; the workhorse tools declare none.
8. **Windowed in-memory session log.** A live session retains every event in memory for its lifetime regardless of compaction; flushed events outside the model surface should drop from RAM and re-read from the durable log on demand.
9. **SQLite `busy_timeout` and durable-log retention.** The persistence backend sets no busy timeout and has no pruning or rotation story; streaming chunks persist 1:1 forever.
10. **Subagent enforcement gaps.** A global concurrent-subagent cap, and honoring or loudly rejecting `maxDepth`/`toolFilter`/`outputSchema` on out-of-process providers that silently ignore them today.

Items 6 and 7 are small, unblocked, and ship first; items 1–3 build on the w8 verdict.

## Alternatives considered

**Merge jspace and session-query into one package.** Rejected as a code move: the seams evolve and die independently, and the bench prices them separately. The product-level unification is the contract above — the packages remain its implementation.

**Strengthen prompt guidance instead of gates.** Rejected: w7 measured ritual compliance with the existing guidance (stock Goal, empty Core, tests-green Checked), and w8's early trials show even captured, reprinted prose being violated. Guidance was the control arm; it lost.

**Retire jspace outright and keep only the log and query tools.** Premature: the enforced-charter version has never been tested, and the w8/w9 arms are the cheap way to test it. If w9 fails, retirement is the recorded fallback and the read path stands alone.

## Acceptance criteria

- Charter entries are typed; an executable entry is run by the executor at checkpoint and ship; refusals name the failing entry.
- Compaction summaries carry seq pointers; a bench task exists whose resolution requires dereferencing one.
- The w9 arm and the session-query adoption experiment run at n≥16 with verdicts recorded against pre-registered rules.
- Max-turns and default tool timeout land as validated config with loud stop reasons.

## Risks

- **Executable checks are a sandbox surface**: charter commands run with tool authority; they must route through the same executor policy as model tool calls, never a privileged path.
- **Gate friction on honest work**: over-strict refusals teach gaming; every refusal must be satisfiable and name the exact fix.
- **Small-n verdicts**: w7's reversal of w6 shows n=2 hints are noise; no default flips without the pre-registered thresholds.
