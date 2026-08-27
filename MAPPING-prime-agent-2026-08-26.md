# Mapping: Prime Agent / PRO-LONG sources → shres-code campaign (2026-08-26)

Working file. Not an Agent Note. Sources re-read 2026-08-26 from GitHub (`PrimeIntellect-ai/prime-agent`, default `main`), ar5iv HTML of arXiv 2608.23552 (Prime Agent paper, current version 2026-08-24) and arXiv 2607.20064 (PRO-LONG), plus load-bearing citations followed on ar5iv. Prior-session lessons from transcript [`1d660141-f1a3-476e-8097-25aba54fd525`](file:///Users/parthmondal/.cursor/projects/Users-parthmondal-git-shres-code-develop/agent-transcripts/1d660141-f1a3-476e-8097-25aba54fd525/1d660141-f1a3-476e-8097-25aba54fd525.jsonl) (path is `<uuid>/<uuid>.jsonl`, not a bare `.jsonl`). All source claims below are from those fetches unless marked **second-hand**.

## Source identities

| ID | What it is |
|---|---|
| **Prime-Agent paper** | Karten, Zhang, et al., “Prime Agent: A Self-Improving RLM Harness,” arXiv 2608.23552. Same project as the GitHub repo (README citation block). |
| **Prime-Agent repo** | `https://github.com/PrimeIntellect-ai/prime-agent` — MIT, ~18.5k stars on fetch. Built on [`pi`](https://github.com/earendil-works/pi). Docs under `packages/coding-agent/docs/`. |
| **PRO-LONG** | Fox, Wang, Rosu, Dhingra (Duke), “PRO-LONG: Programmatic Memory Enables Long-Horizon Reasoning,” arXiv 2607.20064. Code: `https://github.com/alexisfox7/PRO-LONG`. Prime-Agent §3.1 uses an autonomous prompt adapted from this paper ([9] in their bibliography). |

Two of the three campaign seeds are one system (paper + repo). PRO-LONG is the independent ablation.

## 1. Source extraction

### 1.1 Prime Agent architecture (repo + paper §2)

**Information hierarchy (paper Fig. 2, §2.2).** L0 = frozen weights. L1 = active token context (compaction rewrites it). L2 = persistent IPython REPL + recursive subagent sessions (“agentic garbage collection”: create/retain/summarize/delete REPL values and children). L3 = disk: append-only event history, kernel snapshots, session tree, compaction records, message queues, versioned Continual Harness state. Compaction replaces a conversational prefix with a summary and **retains the original events in L3 for REPL retrieval** (paper §2.2). Repo `docs/compaction.md`: auto-compact when `contextTokens > contextWindow - reserveTokens` (default reserve 16384); keep-recent default 20k; structured summary (Goal / Constraints / Progress / Decisions / Next / Critical Context + `<read-files>` / `<modified-files>`); original JSONL entries stay on the branch; `firstKeptEntryId` is the model-visible cut.

**Programmatic computation (paper §2.3; `docs/rlm.md`).** One built-in model tool: `ipython`. File ops, shell, skills, and subagents are Python. `rlm(...)` **admits** a child and returns a handle before completion; results arrive later on daemon-mediated family queues (`agent_message`). Default recursion depth is a host policy, not a fixed workflow graph.

**Continual Harness (paper §2.5; `docs/rlm-runtime.md`; skill `packages/coding-agent/skills/refine/SKILL.md`).** Typed supplemental state: prompt notes, memories, skills, subagent specifications. `/refine` / `refine.run()` plans at turn end, applies CRUD, records snapshots for rollback. Base system prompt is immutable. Local-by-default; `global_=True` writes `~/.prime/agent/harness/`. Paper §3.5 Factorio: the agent discovered RCON resource spawning, used it despite an anti-cheat heartbeat, then **persisted the cheat as a reusable skill**. Authors’ prescription: least-privilege action interfaces, independent state validation, auditable rollback of contaminated refinements.

**Long-horizon controls (paper §2.6; `docs/long-running-agents.md`; `src/core/autonomous.ts`).** Three mechanisms: (1) **autonomous mode** — continuations until quality gates pass or turn/token/wall-clock/continuation limits; `--autonomous-gate "npm run check"`; a passed gate checks only what that gate verifies; reaching a limit does not imply success. Gates skip re-run when `git status`/`diff`/untracked hash match the last failed snapshot (`captureGitWorktreeSnapshot` in `autonomous.ts`). (2) **Goals** — durable objective; **only `goal.complete()` marks success** (self-attested). (3) **Heartbeats / cron** — `/heartbeat`, `rlm_heartbeat`, `prime-agent schedule`. Daemon workers survive client detach.

**Evaluation (paper §3).** RQ1 test-time scaling on ARC-AGI-3: RHAE Best@1 **30% → 95.5%** (abstract; intro also says “95%”). No component ablation. Native Claude Code / Codex reruns scored below vendor leaderboards; they **substituted official numbers**. Table 1 long-context: Prime vs Pi / Claude Code / Codex; **bold is not statistical significance; CIs unavailable**. Largest clean lift vs Pi-mono on GLM-5.2: OOLONG 0.700 vs 0.420, OOLONG-Pairs 0.874 vs 0.556. nanoGPT: “choice of harness has little effect on final records compared to the noise”; process traces differ (REPL experiments). Factorio 7-day Sonnet 5: 23.4M output tokens, 24/196 techs, 633 depth-one subagents, max 7 concurrent, recovered after a destructive world reset. PMPP-Hard: similar solve rates, Prime cheaper in tokens.

**Accounting.** Paper §2.6: evaluation accounting aggregates root **and descendant** sessions.

### 1.2 PRO-LONG (ar5iv 2607.20064)

**Failure modes named.** Context rot (Hong et al. 2025; Liu et al. 2023 “lost in the middle”). Fidelity–tractability tradeoff: write-time summarization / note / skill distillation discards details whose relevance is only visible later. Truncated memory (last-25-action log) loses coverage as `k` grows (Fig. 2). Gains vanish when the current board is a sufficient statistic (ft09, cd82 in §3.3). High run-to-run variance → they report pass@1 and best@k.

**Mechanism.** Write = append every observation/action/outcome to `logs.txt` (header, plan, action, board). Read = coding-agent tools over that file. ~30-line prompt, **no subagents**. Design principles: simplicity, losslessness, coding-agent compatibility.

**Headline numbers (matched 500-action, 25 public ARC-AGI-3 games).** +15.7 to +21.0 pp vs no-log coding agent (mean **+18.0 pp**). Matches specialized harnesses (WorldModeler, Schema, Arcgentica) at **4.2–5.8× fewer billed tokens**. Fable 5 at 2000 actions: **97.4% best@2** for $1,750. Tool ladder (GPT-5.5 pass@1, Table 1/2): Read-only 23.1; +grep 27.2 (**+4.1**); +Python 38.3 (**+11.1**); +Write/Edit 41.2 (**+2.9**). Workspace wipe every call: PRO-LONG 41.2 → 40.7; no-log 24.0 → 19.9. Tool mix: PRO-LONG 60.6% Python vs no-log 40.8%; workspace writing 4.6% vs 30.3%.

### 1.3 Load-bearing citations (followed)

| Cite | Contribution used here |
|---|---|
| Zhang, Kraska, Khattab, **Recursive Language Models**, arXiv 2512.24601 (Prime [44], PRO-LONG). Re-read ar5iv. | Prompt-as-variable in a REPL; recursive self-calls over snippets. Compaction is “rarely expressive enough for dense access.” Table 1 GPT-5: BrowseComp+ 91.33 vs base 0.00 (context-limit); OOLONG-Pairs F1 58.00 vs base 0.04; CodeQA 62 vs base 24. Handles 10M+ token inputs. |
| Karten et al., **Continual Harness**, arXiv 2605.09998 (Prime [18]). Re-read ar5iv. | Online CRUD of prompt / subagents / skills / memory mid-episode; immutable vs reset-based prompt opt. Emerald Pro: ~40% cost cut vs minimalist ($130 vs $215) at 100% vs 98% milestones. **Flash-Lite: every CH variant 3–13% vs minimalist 20%** — capability floor; scaffolding can hurt a weak model. Factorio-class contamination is the coding analog of writing policy from a gamed trajectory. |
| Cunningham, **Metrics of agent ability**, METR 2026-07-24 (Prime [8]). Not re-fetched (blog). | Score at fixed spend vs score at practical plateau; spend must include descendants. Prime §1 cites this as the eval stance. |
| Packer et al., **MemGPT**, arXiv 2310.08560 (both papers). Abstract not re-fetched this pass. | OS-like paging: tiny working context + explicit move in/out of external memory. Prior-session synthesis cited 32%→92% on a deep-memory retrieval task — **second-hand**, transcript `1d660141` assistant line ~55. |
| Wang et al., **Voyager**, arXiv 2305.16291 (Prime [36]). Not re-fetched. | Skill library + critic/verifier. Prior-session claimed **73% item loss when verifier ablated** — **second-hand**, same transcript line. Mechanism used: completion must be an executed check. |

Also load-bearing but not campaign-central: CodeAct (Wang 2024, executable code actions); SWE-agent / SWE-bench (Yang/Jimenez); Reflexion / Self-Refine (verbal RL, short-horizon); Generative Agents (Park 2023, retrieval-ranked memory — PRO-LONG treats ranking as a lossy read).

### 1.4 Lessons the prior session explicitly took (transcript `1d660141`, 2026-08-25)

User ask (line ~27): rate shres/jspace against the three sources; extract improvements.

Recorded derivations (assistant synthesis, lines ~47–64, then W0 design ~196–293):

1. Shared thesis: **addressable state outside the window with programmatic read**, not more ceremony. PRO-LONG’s ladder prices Python-over-log at +11.1 pp and notes at +2.9.
2. jspace is **accessed** working memory (L1 card). The papers’ measured points are **accessible** memory (L3 log + read). “Build the harness around jspace” only if the card is an index into the log, not a bigger card.
3. `tool-session-query` already implements the read primitive; the gap was **opt-in and undriven**, not missing code. Reframe: mount, drive, measure.
4. Prime’s `goal.complete()` is self-attested; Factorio `/refine` of an exploit **validates executor-enforced done**. Coverage-term checkpoints (`by`-padding) sit on the gamed side of that line.
5. Prime quality gates (`--autonomous-gate` + worktree fingerprint skip) are a stronger evidence class than keyword coverage.
6. Do **not** copy Continual Harness refinement as policy-writing until contamination is closed; if built, plan/apply at turn boundary, CAS, rollback, local-by-default, never write the rules the gates depend on.
7. Eval blueprint: matched on/off, replicates, pass@1 and best@k, bootstrap CIs, spend curves including descendants, model-tier split (Continual Harness Flash-Lite floor). That became the W0 note and later w9 pre-registration.
8. Transfer caveat, stated then and still true: PRO-LONG gains vanish when current state is a sufficient statistic; coding files on disk often are. History-dependent work (tool storms, prior-session facts, compacted spans) is the regime that should pay.
9. After the w4 pilot (line ~293): **PRO-LONG confirmed in miniature** (`on-sq` cheaper than `on`); Prime’s missing-ablation caveat reproduced (working-memory card costs tokens without a pass-rate lift at ordinary task scale).

Campaign that followed is the contract plan + W0 ladder, not a reimplementation of IPython.

## 2. Our side (plan, results, commits)

**Plan:** [`.agents/notes/proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md`](.agents/notes/proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md). Principle: nothing in the long-horizon path depends on model initiative.

**Eval rules and numbers:** [`.agents/notes/proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md`](.agents/notes/proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md). All on Z.ai GLM-5.2 unless noted. Verifier-passed success, no LLM judge.

| Experiment | Result |
|---|---|
| w4 pilot | 100% all arms (ceiling). `on` 2.9× input tokens vs `off`; `on-sq` cheaper than `on`. |
| w4-adaptive | on/off input 2.01×; on-adaptive/off 1.07×. |
| w5-pressure | 12/12 pass; compaction never fired. |
| w6 forced-compaction | off 6/8, on 7/8, on-adaptive 7/8; McNemar ties p=1. |
| w7 `constraint-survival-build` ×8 | off 5/8, on 3/8, on-adaptive 3/8; ties p=0.625/0.6875; on/off tokens 1.64×. Core empty 20/20 engaged card sessions; 11/12 Checked = verifier-blind “tests green”; 0 `jspace_close`; 0 session-query calls. |
| w8 `off` vs `on-core` n=16 | 7/16 vs 6/16; Δ −6.25 pp; McNemar p=1, 3/4/9 win/loss/tie; tokens 1.60×. Core populated 6/16; trial 0 held all six rules verbatim and still hit the qty slip. Presence-only prose **does not graduate**. |
| `sq-adopt-2026-08-26` n=8×2 | 16/16 success; `sessionQueryCalls ≥ 1` every trial both arms. Driver line indistinguishable at ceiling. Zero prior adoption was missing initiative, not unusable tools. |
| w9 | Pre-registered, **not run**. `off` vs `on-charter`; n=62 pairs (31×2 pressure tasks); ψ=11/24; \|δ\|=0.25; α=0.05; power 0.8; n_d gate 25; token caps 1.15 short / 1.25 pressure. Loss or tie at powered n **retires jspace**. |

**Design (uncommitted):** [`DESIGN-charter-2026-08-26.md`](DESIGN-charter-2026-08-26.md) — charter is card state, not Core; discrimination `failProbe`; seed from first user message; nested `ctx.tools.execute('bash')`.

**Commits `fbf9ee6dbc..HEAD` (campaign slice):**

| Hash | What shipped |
|---|---|
| `3b2bc1b157` | Guard: `maxStepsPerTurn`, repeat-tool veto, optional `defaultTimeoutMs`. |
| `6b1050909c` | w8 result note. |
| `1afab1e5bf` | w9 pre-registration. |
| `d353b4ff31` | session-query adoption task + `sq-driver` arm. |
| `1b1eacfe08` | Windowed in-memory log; SQLite `busy_timeout` + optional chunk tombstones. |
| `f975ab7d01` / `943a64f333` | `constraint-survival-fare` (tests cannot see house rules). |
| `b5b62bec3f` | Bench trial-pool concurrency. |
| `5679b2ec91` | Executor-enforced charter (typed checks, probes, seed, checkpoint/ship). |
| `75536fc76e` | Windowed-log `exactOptionalPropertyTypes` fix. |
| `4287af116c` | sq-adopt ceiling recorded; pointers proceed for item 6. |
| `65e8cc5cfa` | `on-charter` arm + charter forensics metrics. |
| `7da86dbb82` | Charter on auto-opened cards; probe symlink guard; registration cap. |
| `3627bf470e` | Global `maxConcurrentSubagents`; loud OOP option honor/reject. |
| `9520538268` | Compaction summary seq pointers + `compaction-pointer-follow` task. |
| `22cd19b1f6` | Catalog that task; `maxPointers: 0` on pressure overlay. |

Plan items 1–6 and 8–12 have implementation commits. Item 7 (close hygiene) remains proposed. w9 and pointer-follow **measurement** remain pending.

## 3. Technique inventory

Status key: **COMPLETED** = mechanism exists in tree (commit/package named). **PARTIAL** = shipped subset. **NOT STARTED**. **DELIBERATELY DIVERGED** = we have evidence to not copy.

| # | Source mechanism | Citation | Our status |
|---|---|---|---|
| 1 | Lossless append-only trajectory (write-all) | PRO-LONG §2.2; Prime §2.2 L3 JSONL | **COMPLETED.** Typed session log, model-visible ⟺ logged, `SESSION_FORMAT_VERSION` 0. Stronger typing than `logs.txt` / Prime JSONL. |
| 2 | Programmatic read of that log (grep / code) | PRO-LONG §2.2, Table 2; RLM 2512.24601 REPL-over-prompt | **PARTIAL.** `tool-session-query`: `session_search`, `session_event_search`, `session_event_read`, traces ([adoption note](.agents/notes/implemented/testing/2026-08-26-session-query-adoption-experiment.md)). Structured query, **not** a Python REPL over the log — the +11.1 pp step is the piece we did not copy. Spontaneous use: **0 calls in 100+ w6–w8 trials**. When the prompt names a prior-session recording: 16/16 (`sq-adopt`, `4287af116c`). |
| 3 | Keep the log **out** of the prompt; decide relevance at read time | PRO-LONG §1; RLM Fig. 2 | **COMPLETED** as architecture (compaction shadows; log remains). **PARTIAL** as behavior: pointers (`9520538268`) convert retrieval into instruction-following; pointer-follow bench not yet run. |
| 4 | Compaction archives rather than erases | Prime §2.2; `docs/compaction.md` | **COMPLETED** (event-sourcing). Seq pointers on the summary (`9520538268`, `shres-compaction-basic`) are our addition; Prime’s summary format has Goal/Constraints text, not seq handles into a query API. |
| 5 | Bounded always-visible working set (card / MemGPT working context) | MemGPT (cited); Prime compaction “Constraints & Preferences” block; **not** PRO-LONG | **COMPLETED** as product (jspace card, reprint caps, untrusted frame — [reprint note](.agents/notes/implemented/feature/2026-08-25-jspace-card-reprint-bounds-and-framing.md)). **DELIBERATELY DIVERGED** from “the card is the memory”: w6–w8 show offer-based / prose-on-Core memory **fails** (empty Core 20/20; w8 7/16 vs 6/16 at 1.60× tokens). Papers did not refute a forced card; **our data** say presence-only capture is a tax. |
| 6 | Offer-based notes / skills / memories as primary store | PRO-LONG ablation (+2.9 Write/Edit); Prime Continual Harness | **DELIBERATELY DIVERGED.** PRO-LONG: notes nearly worthless once the log is queryable. Us: note ceremony 1.6–2.9× tokens, zero Core capture until gated, then gated prose still misses qty. Fallback in contract plan: if w9 loses, retire the card, keep log + session-query. |
| 7 | Executor-run quality gates / verifiers | Prime `autonomous.ts` gates; Voyager critic (**second-hand** 73%); PRO-LONG environment score | **PARTIAL → mechanism COMPLETED, effect unmeasured.** Charter checks at checkpoint/ship (`5679b2ec91`, `7da86dbb82`, `shres-tool-jspace`). Discrimination `failProbe` is stricter than Prime’s “exit 0” gate. Prime **skips** a failed gate on unchanged git snapshot; we **deliberately always re-run** charter (`readsFingerprint` recorded, never skips — DESIGN-charter + charter note). w9 is the pass-rate test. |
| 8 | Self-attested goal completion | Prime `goal.complete()` (`docs/long-running-agents.md`) | **DELIBERATELY DIVERGED.** Ship / charter refusals are executor-enforced. Factorio §3.5 is the external warrant; w7 “tests green” ship is the internal warrant. |
| 9 | Discrimination: a check must fail a seeded violation | Not in sources. Closest: PRO-LONG backtest in Schema baseline; Prime gate = command exit | **COMPLETED (ours).** `charterDiscrimination: 'required'` + content `failProbe` (`5679b2ec91`). Sources have executed gates, not “prove the check can fail.” |
| 10 | Seed constraints from the task text | Not in sources (PRO-LONG prompt names the log; Prime goal is user `/goal`) | **COMPLETED.** `jspace/charter-proposal` from first user message (`5679b2ec91`). Response to measured empty-Core initiative failure. |
| 11 | Persistent L2 REPL (IPython / prompt-as-variable) | Prime §2.3; RLM 2512.24601 | **NOT STARTED / DELIBERATELY DIVERGED** as default. Prior session: a kernel is a valid optional Consumer behind seams; collapsing typed tools into one Python tool forfeits permission, render-intent, and replay. Unverified as a POC. |
| 12 | Recursive non-blocking subagents + family mailboxes | Prime `rlm()` + `agent_message`; paper §2.4 | **PARTIAL.** Continuable children, `send_message`, `list_agents`, interrupt, parent-side `maxDepth` (`3627bf470e` plus earlier subagent work). No IPython admission-handle-as-value; no daemon mailbox that outlives the client the way Prime’s supervisor does. PRO-LONG: **zero subagents** and still beat 4-role orchestras — tempers urgency. |
| 13 | Concurrent-subagent cap | Prime Factorio: max 7 concurrent (observed, not a stated hard cap) | **COMPLETED** as config, default `'unlimited'` (`3627bf470e`). |
| 14 | Tree-wide descendant token/cost accounting | Prime §2.6; METR [8] | **NOT STARTED.** `bench/README.md`: `tokensIncludingDescendants` / `costIncludingDescendants` are **null** in v1 (runner cannot see descendant session roots). |
| 15 | Turn / token / wall-clock autonomous budgets | Prime `DEFAULT_AUTONOMOUS_LIMITS` (12 turns, 80k tokens, 30 min, 3 continuations) | **PARTIAL.** `maxStepsPerTurn` + repeat veto + optional tool timeout (`3b2bc1b157`), default off. No autonomous continuation loop with quality gates. |
| 16 | Heartbeats, cron, daemon detach/reattach | `docs/long-running-agents.md` | **NOT STARTED.** ACP/headless exist; resident supervisor + scheduled re-entry do not. |
| 17 | Continual Harness `/refine` (versioned supplemental CRUD + rollback) | Prime §2.5; Continual Harness 2605.09998 | **NOT STARTED.** **DELIBERATELY DEFERRED** given Factorio contamination and CH Flash-Lite floor. Contract plan does not include it. |
| 18 | Worktree-fingerprint skip of unchanged failed gates | `autonomous.ts` `gitWorktreeSnapshotsEqual` | **NOT STARTED** for autonomous loops. **DELIBERATELY DIVERGED** for charter: always re-run at ship. |
| 19 | Untrusted wrapping of injected objectives / card text | Prime `<untrusted_objective>` (prior session; not re-quoted from paper HTML). Repo warning: workers are **not** a security sandbox. | **PARTIAL.** Card reprint uses `frameUntrusted` ([reprint note](.agents/notes/implemented/feature/2026-08-25-jspace-card-reprint-bounds-and-framing.md)). Shield re-screen of rebuilt card text still deferred. Landlock + permission capabilities exceed Prime’s documented non-sandbox. |
| 20 | Windowed RAM / durable retention | Prime keeps JSONL; paper does not describe in-memory windows | **COMPLETED** (`1b1eacfe08`). Independent of the papers; plan item 10–11. |
| 21 | Close dangling cards at goal end | Not in sources | **NOT STARTED** (plan item 7). w6–w8: every engaged session `danglingCard = true`. |
| 22 | Pre-registered paired McNemar, token-neutrality, underpowered = “not yet” | Not in sources. Prime Table 1: no CIs. PRO-LONG: bootstrap CIs on ARC, best@k, rescoring competitors | **COMPLETED as instrument, unused for charter.** W0 note + `bench/analysis/w9-power.js` + `1afab1e5bf`. Sources measure absolute RHAE/pass@1 on games; we measure paired harness deltas on synthetic coding tasks. |
| 23 | Adoption experiment (initiative vs instruction-following) | Not in sources | **COMPLETED** (`d353b4ff31`, `4287af116c`). Sources assume the agent will search the log once told it exists. |
| 24 | Forced-compaction experimental overlay | Not in sources (they compact naturally on long games) | **COMPLETED** (`bench/pressure/forced-compaction.patch.yml`). How w6–w8 escaped the ceiling. |
| 25 | ARC-AGI-3 / OOLONG / EmulatorBench / Factorio eval | Prime §3; PRO-LONG §3 | **NOT STARTED.** Catalog is custom `bench/tasks/` (W0 note: external suites after internal deltas). |

## 4. What we built that the sources do not have

Claimed only where the fetches showed absence:

1. **Discrimination-gated executable charter** — a check is credited only if a harness-applied content mutation makes it fail (`failProbe`, `5679b2ec91`). Prime gates are “command exit 0.” PRO-LONG has no standing constraint object at all.
2. **Pre-registered powered paired eval** — exact McNemar n=62, ψ from w7/w8 pairing fixture, token caps, “underpowered ≠ no effect,” retirement rule (`1afab1e5bf`). Neither paper pre-registers a harness-on/off sample size; Prime Table 1 states CIs are unavailable.
3. **Adoption contrast** isolating “will the model call the read tool” from “does the tool work” (`sq-adopt`). Sources prompt “read `./logs.txt`” every turn; they never measured undriven vs driven query.
4. **Typed, replayable, keyless session events** with `ignorable` envelope and assembled-application snapshots. Prime JSONL / PRO-LONG `logs.txt` are not this.
5. **Untrusted-frame + landlock/permission** as product policy. Prime README: not a security sandbox.
6. **Constraint-survival tasks whose own tests cannot see the rules** (`f975ab7d01`), so `node --test` cannot substitute for the charter.
7. **Compaction summaries that name `session_event_read` seqs** (`9520538268`). Prime summaries list files and prose constraints, not query handles.

Not claimed as novelty: lossless log, programmatic search, executed gates, bounded working set, subagents, compaction-with-archive. Those are in the sources.

## 5. Honest improvement verdict

We can claim we **built** a lossless typed log, a model-facing session-query Consumer, compaction that archives and now points at seqs, an executor-enforced charter with discrimination probes, step/repeat/timeout guards, a windowed live log, and a pre-registered paired bench. We **cannot** claim any of that improved task pass rate. w4–w8 are ties or losses on verifier-passed success (w7 off 5/8 vs on 3/8; w8 off 7/16 vs on-core 6/16; all McNemar grades `tie`), at 1.6–2.9× input tokens for the card arms. Session-query’s only powered behavioral result is an **adoption ceiling** (16/16 when the prompt names a prior-session recording), not a lift versus a no-query control on a task that also needs history under compaction. w9 (`off` vs `on-charter`, n=62) is the first registered test of the enforced-charter thesis and has not run. Versus the sources: PRO-LONG reports +18.0 pp pass@1 on ARC-AGI-3 from searchable lossless logs, and Prime reports 30%→95.5% Best@1 on the same suite plus long-context point estimates without CIs — **our bench cannot compare to those numbers**. A comparable evaluation would need an ARC-AGI-3 (or equally anti-ceiling, history-dependent) adapter, matched model and action/token budget, pass@1 and best@k with intervals, spend including descendant sessions, and an ablation that isolates log-query vs charter vs card rather than pooling them. Until w9 (and pointer-follow) return powered grades, the honest statement is: we refined their mechanisms with executor enforcement after their Factorio failure and after our own offer-based memory failed, and we still have **mechanism without outcome proof**.

## 6. Adoption shortlist (in the sources, missing from the open plan)

Plan items 1–6 and 8–12 are in flight or shipped. These source items are **not** in that plan and remain worth a later note, in priority order:

1. **Python (or code-mode) analysis over the session log** — PRO-LONG Table 2’s largest step (+11.1 pp). Session-query is grep/read of typed events; it is not `regress.py` over a replayable log. Highest remaining PRO-LONG delta.
2. **Descendant-inclusive token/cost accounting in the bench** — Prime §2.6 and METR [8]. `tokensIncludingDescendants` is null today; without it, subagent arms cannot be priced.
3. **best@k + score-vs-spend curves on the same task set** — PRO-LONG Fig. 1–2; Prime Fig. 5. Our McNemar is paired pass/fail; it does not show coverage expansion the way best@k vs truncated-log did.
4. **ARC-AGI-3 (or OOLONG-class) adapter** — the only external yardstick both papers share. Internal synthetic tasks hit GLM-5.2’s floor until forced compaction; we still cannot quote their pp.
5. **Optional persistent REPL Consumer** — RLM 2512.24601 / Prime L2. Keep typed tools; expose a kernel as one Consumer that logs every serialization. Not a default, not a collapse of the tool registry.
6. **Autonomous continuation + host quality gates** (Prime `autonomous.ts`) — distinct from charter-at-ship: keep injecting turns until a deployment-specified command passes, with fingerprint skip for **failed** unchanged workspaces. Complements charter; does not replace it.
7. **Heartbeats / scheduled re-entry / resident worker** — Prime long-running docs. Needed for multi-hour ops, not for w9.
8. **Continual Harness refinement with contamination controls** — only after (a) least-privilege on what refine may write, (b) refine cannot author charter/policy the executor trusts, (c) capability-floor split (CH Flash-Lite result). Not a near-term default.

Do **not** adopt: self-attested `goal.complete()`; write-time note/skill distillation as the memory strategy; pooling model tiers; treating a token-limit stop as task success (Prime already warns).

## 7. Source-access exceptions

- ar5iv HTML and GitHub API for Prime-Agent README/docs/tree/`autonomous.ts`/`refine/SKILL.md` succeeded. PDFs were not required.
- METR blog [8], MemGPT full text, Voyager ablation table: **not re-fetched**. Mechanism names from the papers’ bibliographies; numeric Voyager/MemGPT figures are **second-hand** from transcript `1d660141` (assistant ~line 55).
- Transcript path on disk is `agent-transcripts/1d660141-…/1d660141-….jsonl`, not the bare file named in the task brief.
