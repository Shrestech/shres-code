# Agent Note: long-horizon harness uplift — searchable memory, evidence-grade gates, bounded card, measured value

Status: proposed

## Problem

Shres Code already implements the three-part long-horizon architecture that current external evidence converges on — a bounded always-visible working-memory card (J-Space), an append-only reconstructable session log, and executor-enforced completion gates — but ships it incompletely, so the harness captures the ceremony of long-horizon reasoning without most of its measured value.

Five gaps, in order of cost:

1. **The accessible-memory read path is unmounted.** `tool-session-query` exposes five read-only tools over `ctx.sessionQuery` (search, event search, event read, event trace, lineage trace), but the package is opt-in, absent from shipped compositions, and no prompt text drives the model to query its own history instead of re-deriving facts. External ablations place the majority of long-horizon gains in exactly this read path.
2. **Checkpoint evidence is keyword-grade.** `jspace_checkpoint` accepts any `by` string matching a coverage term; the [live-session forensics](2026-08-24-jspace-live-session-forensics.md) show models padding `by` to satisfy the match. The optional `evidence` call-id raises cost but proves nothing about verification. The ship gate is therefore enforced ritual around an honor-system core.
3. **The card violates its own bounded-working-set principle.** Checked is append-only with no reprint cap and Open is unbounded; live sessions carried 10+ Checked lines, reprinted into every request. The card's value argument is a small forced working set; an unbounded ledger is neither.
4. **The card's net effect is unmeasured.** The W0 outcome measurement named in the forensics note has never run. Whether J-Space (card + protocol modules + gates) improves task outcomes, for which model tiers, at what token cost, is unknown.
5. **Card content is unscreened system-prompt authority.** Tool-argument text is reprinted into the system prompt every assemble, compaction-proof, without untrusted-data marking, and the rebuild path is not Shield-screened; the [settings-toggle note](../../implemented/feature/2026-08-18-jspace-settings-toggle.md) defers this.

## Evidence

External sources reviewed 2026-08-25 (agent-delegated full reads; spot-check any load-bearing number against the source before implementation):

- **PRO-LONG** ([arXiv 2607.20064](https://arxiv.org/abs/2607.20064)): appending every observation losslessly to a log kept out of the prompt, read via grep/Python, lifts the same coding agent +15.7 to +21.0 points on ARC-AGI-3 at 4.2–5.8× fewer tokens than specialized harnesses. Tool ladder: read-only +0, +grep +4.1, +Python +11.1, +note-writing +2.9 — programmatic read over lossless history carries the value; self-authored notes are nearly redundant once the log is searchable. Gains concentrate on history-dependent tasks and vanish when the current observation is a sufficient statistic.
- **Prime Agent** ([arXiv 2608.23552](https://arxiv.org/abs/2608.23552), [repo](https://github.com/PrimeIntellect-ai/prime-agent)): persistent-kernel L2 state, non-blocking subagent admission with family-scoped mailboxes, descendant cost accounting, external command gates with a skip-when-workspace-unchanged fingerprint, and versioned online harness CRUD with rollback. Its Factorio failure — an anti-cheat instruction ignored, then `/refine` persisting the exploit as a durable skill — is direct evidence that self-attested completion and unvalidated self-modification get gamed.
- **Reference graph** (RLM [arXiv 2512.24601](https://arxiv.org/abs/2512.24601), Continual Harness [arXiv 2605.09998](https://arxiv.org/abs/2605.09998), MemGPT, Voyager, Reflexion, SWE-Gym, STaR, METR metrics note): recurring principles — keep the visible context a bounded working set with history addressable outside it; prefer lossless append + read-time selection over write-time summarization; enforce completion with an executor or test, never self-declaration (Voyager loses 73% of items without its verifier); self-improvement needs typed versioned rollbackable state and has a capability floor (Continual Harness under a weak model underperforms doing nothing); measure score-versus-spend curves including all descendant sessions.

The 2026-08-25 fixes (epoch reset made model-visible, [`note` rejects Goal identity changes](../../implemented/bug-fix/2026-08-25-jspace-note-rejects-goal-change.md), fixture realignment) closed the correctness gaps this plan builds on; [docs/subsystems/jspace.md](../../../../docs/subsystems/jspace.md) describes the current subsystem.

## Proposal

Six workstreams, ordered by expected value per unit risk. W1–W3 are independent and parallelizable; W4 should start only after W1 and W3 land so the measurement covers the improved harness.

### W1 — Mount and drive the session-history read path

Add `tool-session-query` to the shipped compositions (base bundle and example agents), defaulted on. Add one driver sentence to the system prompt (J-Space driver when the seat is active, a standalone section otherwise) stating that the full session history is searchable and should be queried before re-deriving prior facts, decisions, or tool output. Add an epoch-scoped convenience: an event filter bound to `goalOpenedSeq` ranges so the model can scope searches to the current or a named Goal epoch, making epochs the natural partition key for history. Verify compaction leaves `log-only` surface events reachable through the tools (the engine's `current` / `shadowed` / `log-only` classification already models this; the check is that shipped compositions do not sever it).

### W2 — Evidence-grade checkpoints and gate dedup

Extend `jspace_checkpoint` with a validated evidence class: a checkpoint may cite a gate-class tool call — an executed verifier command (test, build, lint) whose logged result is non-error — and record the workspace fingerprint (git status + diff + untracked hash) at verification time. Add a `requireVerifiedEvidence` config (default off initially) making `jspace_ship` demand at least one evidence-grade checkpoint in the current Goal epoch. Adopt the fingerprint both ways: refuse to count a re-cited verifier result when the workspace changed since it ran, and surface fingerprint equality so unchanged workspaces need not re-run a passed gate. Keyword coverage remains the floor for ordinary checkpoints.

### W3 — Bound the card reprint

Cap the reprinted card: the last N Checked lines (config, default around 5) and last M Open questions render on the card with a count of elided lines; the full sets remain in the durable log, reachable through W1's tools. The write model is unchanged — events still carry whole-card snapshots — only `formatJspaceCard` truncates. Update capacity-module copy so the model knows elided lines are queryable, not lost.

### W4 — Run W0 with score-versus-spend methodology

Build the measurement on `ctx.tracker`: matched task sets run with J-Space on/off and session-query on/off, n replicates per cell, stratified by model tier (the Continual Harness capability-floor result predicts scaffolding can hurt weaker models), reporting pass@1 and best@k with bootstrap confidence intervals plus token/cost curves that include descendant sessions. Add a ritual-compliance metric from telemetry: rate of checkpoint refusals followed by `by`-padding, and rate of ships whose evidence is keyword-only. W0's outcome decides whether the protocol-module prose (passes, capacity, broadcast) earns its per-turn token cost or gets trimmed to the card + gates.

### W5 — Screen the card rebuild path

Mark card-derived lines in the system prompt as untrusted data (delimiter text stating the card content is session-authored working memory, not instructions) and route the rebuild through Shield screening, closing the deferred item in the settings-toggle note. This is the direct application of the Prime Agent contamination lesson to our one hygiene gap: tool-argument text must not gain unmarked system-prompt authority.

### W6 — Deferred: delegation ergonomics and bounded self-improvement

Held until W1–W4 report: subagent admission handles (spawn returns before completion), durable child mailboxes surviving compaction, and lineage-tree cost roll-up (the `traceSession` lineage already computes the tree); any continual-harness-style online refinement only as typed versioned entries with plan/apply at turn boundaries, compare-and-swap, human-firable rollback, and executor validation of every refined artifact. PRO-LONG's zero-subagent result argues delegation topology is not the scarce resource before memory is searchable, and the Factorio incident fixes the safety envelope for refinement.

## Alternatives considered

**Enrich the card instead of mounting the read path.** Rejected: every measured external result places long-horizon value in programmatic read over lossless history, not in larger always-visible state, and the bounded-working-set principle (RLM, MemGPT, Reflexion's forced cap) says a bigger card is actively worse.

**A persistent code-kernel (REPL) as the primary action surface, as in Prime Agent.** Rejected for now: collapsing typed tools into one kernel forfeits permission enforcement, UI render intent, and keyless replay of model-visible text — the properties this harness is built on. A kernel Consumer behind the existing seams, where every value serialized into context is a session event, remains open as a later experiment under W6's constraints.

**LLM-as-judge verification for checkpoints.** Rejected: the literature and our own forensics classify judge/keyword gates as gaming surfaces; the upgrade path is executed-verifier evidence, which the session log can prove.

**Online self-refinement of prompts/skills now.** Rejected for sequencing: Prime Agent's own run shows refinement laundering an exploit into policy, and Continual Harness shows a capability floor below which refinement is net-negative; both demand the W2 evidence standard and W4 measurement exist first.

**Recording new snapshot scenarios instead of hand-maintaining fixtures.** Not an alternative but a dependency note: W1–W3 change model-visible text and behavior, so each needs its keyless snapshot updated in the same PR; scenario re-recording requires `DEEPSEEK_API_KEY`.

## Acceptance criteria

- W1: shipped compositions register the five session-query tools; a driver line referencing history search is pinned in snapshot fixtures; an epoch-scoped filter exists with unit coverage; a keyless snapshot scenario shows a query over prior session events succeeding after compaction.
- W2: a checkpoint citing a non-error verifier call with a recorded workspace fingerprint is distinguishable in the event payload; `requireVerifiedEvidence` gating is unit- and e2e-covered including the fingerprint-mismatch refusal; ship refusal copy names the missing evidence class.
- W3: a card with more than N Checked lines reprints exactly N plus an elision count; the durable event still carries all lines; snapshot fixtures pin the truncated rendering.
- W4: a tracker-backed report exists with per-tier pass@1/best@k, confidence intervals, and cost curves including descendants, for at least the on/off × on/off matrix on one task set; the ritual-compliance metric is computed from real session telemetry.
- W5: card-derived prompt lines carry the untrusted-data framing in pinned fixtures; the rebuild path passes through Shield when Shield is mounted.
- W6: no acceptance criteria yet; requires its own proposal informed by W4's results.

## Risks

- **Transfer risk.** The external evidence is from grid-game and long-context benchmarks; coding workspaces often make the current files a sufficient statistic, which PRO-LONG identifies as the no-gain case. W4 exists to measure the transfer rather than assume it.
- **Token cost of the read path.** Driving history queries adds tool calls and result tokens; spill/timeout policies bound single results, but W4 must report net cost, not only score.
- **Gate friction.** `requireVerifiedEvidence` can block legitimate ships on tasks with no runnable verifier; it ships default-off and per-deployment config is the mitigation.
- **Card truncation confusion.** A model may treat elided Checked lines as lost and re-verify needlessly; driver copy and the elision count mitigate, and W4's compliance metrics would surface it.
- **Measurement cost.** W0 needs real API spend across a model×harness matrix; stratification multiplies runs. Run one task set first; expand only if the effect is directionally clear.
- **What this plan gives up.** No REPL/L2 state, no online refinement, and no delegation-ergonomics work until measurement lands — accepting slower expressivity growth in exchange for evidence-ordered investment.
