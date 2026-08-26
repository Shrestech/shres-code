# Agent Note: Measurement strategy for claiming and measuring against Prime Agent

Status: proposed

## Problem

The [MAPPING](../../../../MAPPING-prime-agent-2026-08-26.md) verdict stands: **we have mechanism without outcome proof.** w4–w8 are ties or losses at 1.6–2.9× input tokens, recorded in the [W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md). w9 (`off` vs `on-charter`, n=62) is pre-registered there and is **not** a completed powered run: experiment id `w9-charter-2026-08-26` launched and aborted at 0 completed; `w9-canary-2026-08-26` completed 4 **pressure** trials (not the pre-registered typo-guard canary) with `on-charter` `AGENT_TIMEOUT` in 2/2 on-charter cells. The typo-guard canary is still unrun. A real w9 needs a **fresh experiment id**.

Prime Agent reports 30%→95.5% Best@1 on ARC-AGI-3 and long-context point estimates with no CIs; PRO-LONG reports +18.0 pp pass@1 from searchable logs. Our bench cannot quote any of those numbers today because it runs a different task family under a different protocol. Every claim below is therefore shaped by two rules:

1. **No external "beats Prime" claim before the internal gate passes.** If w9 loses or ties at powered n, jspace retires per its own pre-registration, and the campaign pivots to log + session-query + programmatic read — which is exactly the mechanism class the external benchmarks would test anyway.
2. **Comparable means same model, same benchmark generator, same budget accounting, paired arms, intervals mandatory.** Directional reproduction of their published deltas is achievable; bit-exact comparison to their published absolute numbers is not. That their prompts and sampling are not public is a **second-hand assumption** (not in MAPPING). They themselves substituted official numbers for native-harness reruns ([MAPPING §1.1](../../../../MAPPING-prime-agent-2026-08-26.md)).

**Model-pin verification.** The `run.json` `model` field records `deepseek-v4-flash` even on zai-tier runs. "Same model pin" claims must verify the `tierPatches` sha256 (and the tier file contents), not the `model` string.

## Proposal

A 30-day measurement campaign that (a) prices descendant spend and enforces `maxTotalTokens` as `BUDGET_EXCEEDED`, (b) runs w9 under a fresh experiment id with the pre-registered typo-guard canary, (c) ports an OOLONG-lite aggregation pair as the highest claim-strength-per-dollar external analog, and (d) only then spends on score-at-budget curves. Sequencing is [roadmap wave 0 then WP3.3 / WP3.4](2026-08-26-beat-prime-agent-roadmap.md).

Cost figures below use measured per-trial token counts from `bench/runs/w7-build-confirm-2026-08-26`, `w8-core-2026-08-26`, and `sq-adopt-2026-08-26` on Z.ai GLM-5.2. Assume $0.20–$1.00/M input and $1–$3/M output for GLM-class providers.

**Non-pass class in w7/w8 (not PROVIDER_ERROR).** Both runs contain **zero** `PROVIDER_ERROR`. w7 (24 trials): 11 pass, 12 `VERIFY_FAILED`, 1 `AGENT_TIMEOUT` (1/24). w8 (32 trials): 13 pass, 11 `VERIFY_FAILED`, 8 `AGENT_TIMEOUT` (8/32 = 25%). Timeout trials run until `timeoutMs` 900000 and bill the tokens accumulated (w8 timeouts: 68 570–199 241 input, mean 111 968; non-timeout mean 99 129). They are not cheap aborts.

Pressure-trial API cost, including timeouts: about **$0.02–$0.23 per trial**. A 124-trial pre-registered run at w8's 25% timeout mix is **$4–$21**, plus ~$0.20–$1 for a 10-trial typo-guard canary. If on-charter timeouts approach the w9-canary 2/2 rate, budget **$5–$28** for 124+10. The earlier $10–$30 figure treated failures as cheaper than successes and added a 5% `PROVIDER_ERROR` rerun buffer that w7/w8 do not support.

## Arm vocabulary (defined once)

Every later section uses these names and no others:

| Arm | Meaning |
|---|---|
| `off` | Control: claimed feature disabled (jspace off, no kernel, no refine, …). |
| `on-charter` | W0/w9 treatment: executor-enforced charter. |
| `stuffed` | Whole corpus in the prompt, no read tools (Pi-mono role). |
| `read` | Corpus on disk + session-query path (no kernel required). |
| `shipped` | Full shres composition under test (the treatment that would ship). |
| `shipped-minus` | `shipped` with the claimed feature disabled (evidence-gated attribution). |

Internal feature beat (already supported): 2 arms, baseline `off` vs treatment, exact McNemar, n=62 pattern from `bench/analysis/w9-power.js`, plus the existing token-overhead grade (`TOKEN_OVERHEAD_MAX = 1.25`).

External-referenced beat: 3 arms from `{stuffed, read, shipped, shipped-minus}` chosen per experiment. The OOLONG-lite **pilot** (P2) is `stuffed` / `read` / `shipped`. The **powered** run (P4) is `stuffed` / `shipped` / `shipped-minus`. `read` is the session-query path; it is not a synonym of `shipped`.

## Budget-cap semantics (decision)

[`bench/schema/trial.js`](../../../../bench/schema/trial.js) already lists `BUDGET_EXCEEDED` among `FAILURE_MODES`. The runner does not enforce it today.

- **`maxTotalTokens` is a live cap.** When the running provider-reported total (sum of `usageOf` over `assistant/chunk` usage chunks and `assistant/message.usage` fallback — token-meter semantics, [WP0.1](2026-08-26-beat-prime-agent-roadmap.md)) would exceed `maxTotalTokens`, the runner terminates the trial as `BUDGET_EXCEEDED`. Success is not possible on that trial.
- **`success(B)` for B below the cap is post-hoc filtering**, not a second live cap. A trial that completed under a 200k cap can be scored as success-at-50k if its recorded totalTokens ≤ 50k. The live cap is the experiment's declared `maxTotalTokens`; the curve is a filter over completed (and `BUDGET_EXCEEDED`) trials.
- **Observation.** The runner maintains a running total from usage events as they land in the session log (same `foldUsage` helper as descendant accounting). It does not wait for session end. Mid-trial observation is required for the live cap to fire.

## Headline external claim (pre-registered)

The published delta this campaign must reproduce: **+31.8 pp = 0.874 − 0.556 on OOLONG-Pairs, GLM-5.2** ([MAPPING §1.1 Table 1](../../../../MAPPING-prime-agent-2026-08-26.md), Prime vs Pi-mono). Claim form: "on generated-OOLONG-Pairs with GLM-5.2, the stuffed→programmatic-read delta in our harness reproduces/exceeds the direction and magnitude of the published Pi-mono→Prime delta," never "our number beats their number."

**Superiority (primary):** McNemar p < 0.05, δ > 0, bootstrap 95% CI lower bound ≥ 10 pp (a conservative floor under the published 31.8 pp), token overhead ≤ 1.25×.

**Equivalence to published magnitude (secondary TOST):** the paired delta's 95% CI lies inside 31.8 ± 15 pp. Failing TOST without failing superiority is still a directional reproduction, not a magnitude match.

## Comparable-protocol inventory

Ratings: port feasibility into `bench/tasks/<id>/` + `verify.mjs` + overlay, where ★★★ = task-dir port only, ★★ = needs runner/schema extension, ★ = needs new infrastructure or access we do not have.

Facts MAPPING does not contain are marked **second-hand** or **assumption**.

| Prime Agent benchmark | Their protocol | Port? | Keyed API | Contamination | Licensing | Est. cost/trial | Verdict |
|---|---|---|---|---|---|---|---|
| **ARC-AGI-3 RHAE Best@1** (score-at-budget curves; MAPPING records 30%→95.5% Best@1, no CIs) | Interactive game suite; recursive helper agent; Best@1 vs spend; they scored below vendor leaderboards natively and substituted official numbers | ★★ runner lacks an interactive env loop (one instruction → done); needs a game-API adapter behind `setup.mjs`/phase spawns | Yes (ARC API key; access gated) | Low (hidden games) | **Assumption:** verify ToS before spending; ARC-AGI-1/2 data is CC-BY-NC (not in MAPPING) | High: many episodes/game, long horizons | **Long-term.** Highest prestige, worst dollars/access. Design the adapter seam now, spend later |
| **OOLONG / OBLIQ / LongBench suite** (MAPPING Table 1; largest clean lift vs Pi-mono: OOLONG-Pairs 0.874 vs 0.556 on GLM-5.2) | Long-context aggregation over generated corpora; single-shot answers; point estimates, no CIs | ★★★ synthetic generator → fixture files + deterministic verifier; matches our task contract exactly | Yes (any LLM run), but tiny: ~50–200k tokens/trial | Medium: corpora may be memorized → mitigate with seeded regeneration + random-token substitution of names/IDs so answers cannot be recalled | **Assumption:** OOLONG repo is open-source research code (re-check license file before redistribution; not in MAPPING) | ~$0.02–0.23 | **Best claim-strength per dollar.** Same benchmark class, same model pin (GLM-5.2 via our zai tier, verified by `tierPatches` sha256), generated instances beat contamination |
| **nanoGPT speedrun out-of-loop experiments** | **Second-hand:** "Fig 6 process metric" and "100 training runs" are not in MAPPING. MAPPING records only: "choice of harness has little effect on final records compared to the noise"; process traces differ (REPL experiments) | ★★ metric is log forensics we can implement in `metrics.js`; the real speedrun workload needs GPUs we do not own | Real workload: yes + GPU | High for outcomes (speedrun solutions are public) — low for the process metric itself | **Assumption:** nanoGPT MIT (not in MAPPING) | GPU rental dominates ($100s+) | **Port the metric, not the workload.** Define out-of-loop experiment rate on our iterative tasks (chain-*, self-modification demos) computed from session logs. Near-zero marginal cost; process-trace comparability, not record comparability |
| **PMPP-Hard fixed budgets** | CUDA kernel synthesis under token budgets | ★ needs GPU verification; CPU-correctness-only fallback changes the benchmark | Yes | Medium (kernel solutions circulate) | Open dataset | GPU hours | Skip for now |
| **EmulatorBench verifier scores** | **Second-hand / assumption:** protocol details (verifier-scored state inside emulated environments) are not in MAPPING | ★★ "lite" version portable: a deterministic fake CLI/app state machine shipped in `fixture/`, verifier scores end state | Yes | Low if we author our own environments | Reimplement, do not copy | ~$0.05–0.23 | Good medium-term: exercises multi-session persistence exactly like chain-* stratum |
| **Factorio tech progression** | 7-day run, 23.4M output tokens, **24/196 techs total** ([MAPPING §1.1](../../../../MAPPING-prime-agent-2026-08-26.md)), descendant accounting incl. 633 subagents. **Not** a "techs/24h" rate | ★ proprietary game server + RCON infra + very long horizons | Yes | Low | Game license required | $100s–1000s | Skip. Adopt the lesson already logged: least-privilege interfaces + executor-enforced done |
| **MazeBench states-per-dollar** | **Second-hand:** MazeBench protocol is not in MAPPING | ★★ reimplementable as a grid world exposed through bash/file tools; verifier counts states from logs | Yes | Low (our own mazes) | Metric definition only | ~$0.05 | Optional exploration-stratum add-on; only after descendant-inclusive dollar accounting exists |

**Maximum claim-strength per dollar subset:** (a) OOLONG-class aggregation with a context-stuffed control arm (direct Table-1 analog, contamination-controlled, ~$5–15 per powered experiment); (b) score-at-budget curves on our existing pressure catalog (score-at-spend analog using tasks we already trust, reuses w7/w8 fixtures); (c) process-metric forensics from logs we already hold ($0). ARC-AGI-3 stays a design-only spike until access exists.

## Defining "beat": protocols

All comparisons are same-model paired contrasts in bench/: pinned model (via `tierPatches` sha256), temperature, base URL, harness commit, task set, interleaved arms per taskId+trialIndex (protocol rules 1–2). Never pool provider tiers; never compare wall time across experiments.

### Score-at-equal-spend

Add a token budget cap to the runner (`maxTotalTokens` per trial; live `BUDGET_EXCEEDED` as specified above). For a pre-registered budget grid B ∈ {25k, 50k, 100k, 200k}:

- `success(B)` = fraction of trials resolved with totalTokens ≤ B (post-hoc filter). Wilson CI per point.
- Paired McNemar at each B on the indicator {resolved ∧ within B}, paired on taskId+trialIndex.
- Summary statistic: area under the success-vs-budget curve, bootstrap percentile CI (seeded mulberry32, existing machinery).
- Long-horizon claims additionally require `pressureFired === true` per the existing rule.

### Spend-at-equal-score (inverse)

Smallest budget B* whose Wilson lower bound reaches a target pass rate (pre-register the target, e.g., 0.75). Report the arm ratio B*_treatment / B*_baseline with a bootstrap CI. This converts "cheaper at equal quality" into one number with an interval.

### Extending Wilson/McNemar to continuous metrics

Primary metric stays binary verifier-passed success (protocol rule 4 unchanged). Continuous secondaries: `totalTokens` (descendant-inclusive once P0 / [WP0.1](2026-08-26-beat-prime-agent-roadmap.md) lands), `durationMs`, `turns`, and the already-schemad optional `trial.score ∈ [0,1]` for partial credit.

- **Paired differences:** Wilcoxon signed-rank on within-pair deltas (exact enumeration for n ≤ 25, normal approx above; new module `bench/stats/paired-continuous.js`). Hodges-Lehmann estimate optional.
- **Intervals:** `bootstrapDeltaCi` **already exists** for pass-rate deltas ([`bench/stats/intervals.js:75`](../../../../bench/stats/intervals.js)). `bootstrapMeanCi` exists. What is new is a **continuous paired-delta CI** (`bootstrapPairedDeltaCi`) and ratio-of-means (log-transform) for token/duration deltas.
- **Equivalence ("no regression") claims** (the reprint-bound/note-refusal class): TOST with a pre-registered margin, e.g., token overhead ≤ 1.15 on the short canary — same shape as the existing w9 bounds.
- **Decision-rule template (extends the current grade):**
  - `improvement` = McNemar p < 0.05 AND δ > 0 AND continuous overhead ratio ≤ bound AND Wilcoxon p < 0.05 on the spend metric in the favorable direction;
  - `tradeoff` = binary win, continuous bound breached (do not graduate);
  - `tie`/`not yet` = p ≥ 0.05 or realized discordant pairs < 25 — never reported as "no effect".
- **best@k:** the unbiased `passAtK(n, c, k)` estimator already ships in stats/paired.js; report best@1 and best@3 per arm on pressure/long strata, matching PRO-LONG's reporting habit.

## OOLONG-lite specification (pinned)

- **Corpus format.** JSONL, one object per line, fields `{ id, name, value, category }` with integer `value`. Names and ids are drawn from a seeded alphabet so they are not English words the model can recall.
- **Aggregate-question types.** `count` (rows matching a predicate), `sum` (of `value` under a predicate), `unique-count` (distinct `name` or `id`), `conditional-count`. The pairs task asks for co-occurrence counts of (`category_a`, `category_b`) pairs.
- **Verifier tolerance.** Exact match for counts, ids, and pair tables. Integer sums exact (no floats in v1).
- **Seeded regeneration.** `mulberry32` seed in the task config; regeneration rewrites names/ids from the alphabet while preserving the numeric aggregates the verifier checks. A fixture rebuilt from the same seed is byte-identical.
- **Stuffed-arm × forced-compaction overlay.** The `stuffed` arm does **not** use the forced-compaction overlay: compaction would destroy the "whole corpus in the prompt" condition. `read` and `shipped` arms **may** use forced-compaction so session-query/kernel have to earn the answer. Mixing stuffed+forced-compaction is a protocol error; the runner must refuse that overlay combination.

Corpus size ~300–600 items. Instruction asks for aggregate facts computable only by scanning everything.

## Near-term target vs the long-term ARC problem

### Hit now, cheaply or keylessly

1. **OOLONG-lite aggregation pair (`oolong-aggregate`, `oolong-pairs`).** Seeded generator writes the corpus into `fixture/`; `verify.mjs` checks exact values. Pilot arms: `stuffed` vs `read` vs `shipped`. This is the Table-1 analog at ~$5–15 per powered run and feeds the roadmap question "does programmatic read need a kernel?" ([persistent-kernel note](2026-08-26-beat-prime-agent-persistent-kernel.md)).
2. **Out-of-loop experiment counting from logs ($0 marginal).** New forensics metric `outOfLoopExperiments` in `runner/metrics.js`: count tool calls/subagent spawns outside the mainline attempt sequence, computed from session JSONL we already store. Recompute over w6–w8 and sq-adopt runs immediately; no new API spend. Publishes "our harness produces N process traces per 100 mainline attempts" as the comparable process quantity. (The Prime "Fig 6" / "100 training runs" framing is **second-hand**.)
3. **EmulatorBench-lite** (**assumption** about their protocol). One deterministic fake stateful service in `fixture/` (a small protocol the agent drives through bash), verifier scores final machine state. Exercises cross-session persistence; medium term.
4. **Score-at-budget sweep on the existing pressure catalog.** Reuses `constraint-survival-*`, `noise-needle`, `chain-ledger-deep`; only needs the budget cap + curve builder.

### The ARC-AGI-3 access problem (long-term)

Requires: interactive environment loop in the runner (multi-turn episode with per-step observation), an ARC API account, per-game episode budgets, and their scoring pipeline. None exist today. Spend nothing beyond a design note until access is granted; when it is, the RHAE (recursive helper) pattern maps onto our subagent capability seam and becomes the swarm benchmark. Until then the honest sentence stays: "we reproduce the published harness-delta pattern on the same benchmark class and model; we do not run ARC-AGI-3."

## Which harness features each chosen benchmark exercises

Every adopted benchmark must discriminate between competing roadmap items, not just produce a number.

| Benchmark | Features exercised | Roadmap item it arbitrates |
|---|---|---|
| OOLONG-lite (`read` arm) | session-query Consumer, compaction seq pointers, future kernel-over-log Consumer | [Adoption shortlist items 1 and 5](../../../../MAPPING-prime-agent-2026-08-26.md): is grep/read enough, or does the +11.1 pp step (PRO-LONG Table 2 Python-over-log) require a kernel? If `read` wins big, kernel drops priority; if `read` plateaus at search-snippet depth, kernel rises |
| Score-at-budget sweep on pressure catalog | forced compaction, windowed log, charter checks | w9 charter decision; compaction-pointer value; autonomous continuation ([MAPPING shortlist item 6](../../../../MAPPING-prime-agent-2026-08-26.md)) as the next lever once curves flatten |
| Experiment-count metric | guard plugins, maxStepsPerTurn, repeat veto, subagent seats/caps | Whether autonomy features ([shortlist item 6](../../../../MAPPING-prime-agent-2026-08-26.md), [technique inventory item 13](../../../../MAPPING-prime-agent-2026-08-26.md) concurrent-subagent cap) raise productive out-of-loop experiments rather than tool storms |
| EmulatorBench-lite / chain tasks | durable sessions, resume/fork (currently missing — cold carry only), heartbeats ([technique inventory item 16](../../../../MAPPING-prime-agent-2026-08-26.md)) | Multi-session persistence work; `resumedFrom` stops being null |
| Swarm tasks (Factorio-analog lite) | subagent mailboxes, concurrency caps, **descendant-inclusive accounting** | [Shortlist item 2](../../../../MAPPING-prime-agent-2026-08-26.md) is a hard prerequisite: `tokensIncludingDescendants`/`costIncludingDescendants` are null today, so no subagent arm can be priced and no states-per-dollar or experiments-per-dollar number is honest |
| Injection/adversarial ports | untrusted frame, landlock/permission seams | Security-posture claims that Prime explicitly disclaims |

Rule: a benchmark enters `bench/tasks/` only if its result can flip at least one roadmap ordering. That keeps the catalog anti-ceiling and history-dependent, which is where the sources locate all gains.

The adoption shortlist has **8 items**. Concurrent-subagent-cap is [MAPPING technique inventory item 13](../../../../MAPPING-prime-agent-2026-08-26.md), not a ninth shortlist row.

## Ranked 30-day roadmap with estimated API spend

Spend assumes Z.ai GLM-5.2 tier pricing of $0.20–$1.00/M input, $1–$3/M output, and the measured per-trial anchors above (timeouts billed at full pressure-trial rates). All runs interleaved, pinned manifests, pre-registered decision rules. Model pin = `tierPatches` sha256.

| Rank | Days | Work | Deliverable | Trials | Est. spend |
|---|---|---|---|---|---|
| P0 | 1–3 | Descendant-inclusive accounting: walk persistence root for depth>0 sessions via `parentSession` headers ([`session-layout.js`](../../../../bench/runner/session-layout.js) already copies `encodeSegment`/`projectKey`); fill `tokensIncludingDescendants`/`costIncludingDescendants`; add `maxTotalTokens` live cap + `BUDGET_EXCEEDED` enforcement. Address the schema's "fragile and untested in v1" comment ([`trial.js:31`](../../../../bench/schema/trial.js)) by keying the walk on durable headers of closed files, once per completed trial | Schema un-null'd; unit tests; demo data updated | 0 (code only) | $0 |
| P1 | 2–6 | **Run w9 as pre-registered** (`off` vs `on-charter`, 31×2 pressure tasks, **typo-guard canary**). Fresh experiment id (do not reuse `w9-charter-2026-08-26` or `w9-canary-2026-08-26`). Canary is the pre-registered short-stratum typo-guard task, not a pressure smoke | Implemented results note; retire-or-graduate verdict | 124 + 10 | $5–$28 |
| P2 | 3–8 | OOLONG-lite generator + `oolong-aggregate`/`oolong-pairs` tasks + pilot (arms `stuffed`, `read`, `shipped`; 3 tasks × 2 repeats) | Pilot note with Wilson CIs; go/no-go for powered run | ~18 | $2–$8 |
| P3 | 5–9 | `outOfLoopExperiments` forensics metric; recompute across all stored runs; report lane | Curve table over w6–w8/sq-adopt; $0 API | 0 | $0 |
| P4 | 9–16 | Powered external-referenced run: `stuffed` vs `shipped` vs `shipped-minus` on OOLONG-lite + `noise-needle` + `chain-ledger-deep`, n=31 pairs, budget grid active | First externally-referenced claim with intervals | ~186 | $18–$55 |
| P5 | 12–20 | Score-at-budget sweep + spend-at-equal-score builder in report/UI; rerun pressure catalog under budget caps (2 arms × 2 tasks × 5 budgets × 3 reps) | Score-at-spend curves in ui/data.js | ~60 | $6–$18 |
| P6 | 18–26 | EmulatorBench-lite task (stateful fake service) + chain integration | New pressure/chain task + pilot cells | ~12 | $1–$5 |
| P7 | 22–30 | ARC-AGI-3 spike: apply for access, write adapter design note against the phase-spawn seam; 3-game smoke only if keys arrive | Design note + access status; else documented blocker | ≤ 10 | $0–$20 |
| — | buffer | Infra flakes. w7/w8 contribute **0** `PROVIDER_ERROR`. Do not provision 30 rerun trials on that class. Keep a small unknown-flake line (~5 full-price pressure trials) | — | ~5 | $0.10–$1.15 |
| | | **Total** | | ~415 trials | **≈ $32–$135** |

P4's upper bound rose because timeout trials consume the full wall-clock token spend; the previous $18–$45 assumed cheaper failures.

Keyless components throughout: stats/paired-continuous.js, report curve builder, demo generator extension, snapshot lanes unaffected (`docs/testing.md` tiers untouched; bench remains standalone zero-dependency Node).

## Claim sentences this buys (post-conditions)

Once P1–P5 land, the strongest defensible statements are:

1. "On generated OOLONG-Pairs-class tasks with GLM-5.2, moving from context-stuffed prompting to programmatic read over a lossless typed log improves verifier-passed accuracy by X pp (McNemar p=…, 95% CI […]) at ≤1.25× total-token cost — reproducing the direction and magnitude of the published Pi-mono→Prime delta (+31.8 pp = 0.874 − 0.556)."
2. "At fixed token budgets, shres-code's success-vs-budget curve dominates the stuffed baseline at every grid point (Wilson CIs, paired McNemar per point)."
3. "Per 100 mainline attempts our harness logs N out-of-loop experiments (process metric), computed from replayable typed session logs."
4. And, conditional on w9 passing: "executor-enforced discrimination-gated charters beat the unassisted harness at powered n with token overhead ≤1.25×" — the internal effect Prime never ablated.

What remains unclaimable until ARC-AGI-3 access: any absolute comparison to their 95.5% Best@1, and any per-dollar figure involving subagents before P0 lands.

## Alternatives considered

**Quote Prime's published absolute numbers as ours.** Rejected: different task family, different protocol, no CIs on their Table 1, and they substituted official numbers for native reruns.

**Treat underpowered w9 as "no effect."** Rejected: the [W0 eval note](../testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md) already forbids it.

**Reuse experiment ids `w9-charter-2026-08-26` / `w9-canary-2026-08-26`.** Rejected: the first aborted at 0 completed; the second is a 4-trial pressure smoke, not the typo-guard canary.

**Force-compaction overlay on the stuffed arm.** Rejected: it destroys the stuffed condition.

**Compare `run.json` `model` strings as the pin.** Rejected: that field records `deepseek-v4-flash` even on zai-tier runs; the pin is `tierPatches` sha256.

**Provision a 5% `PROVIDER_ERROR` rerun buffer from w7/w8.** Rejected: both runs contain zero `PROVIDER_ERROR`.

## Acceptance criteria

- P0: `tokensIncludingDescendants` is a number on a planted descendant fixture; a live `maxTotalTokens` abort records `BUDGET_EXCEEDED`; the schema comment's "fragile and untested" walk is replaced by a header-keyed BFS with tests.
- P1: a fresh w9 experiment id completes 124 interleaved pressure trials plus a typo-guard canary; the implemented results note records retire-or-graduate against the pre-registered rule; underpowered ⇒ "not yet."
- P2: OOLONG-lite tasks exist with the pinned corpus/verifier/seed spec; stuffed arm refuses a forced-compaction overlay; pilot Wilson CIs published.
- P3: `outOfLoopExperiments` recomputed over stored w6–w8/sq-adopt runs at $0 API.
- P4/P5: externally-referenced claim cites +31.8 pp as the target; intervals mandatory; `bootstrapDeltaCi` used for pass-rate deltas; new continuous paired-delta CI used for token deltas.
- `pnpm run test:coverage` on any new bench JS that lands in packages (bench itself is the standalone runner); `pnpm run doc-sync` if docs change.

## Risks

1. **w9 on-charter timeouts.** w9-canary 2/2 on-charter `AGENT_TIMEOUT` at 900s. Calendar and dollar upper bounds assume that rate may persist. Mitigation: fresh canary on typo-guard (short) before the powered pressure run; do not treat pressure timeouts as infra flakes.
2. **Adoption of undriven tools.** Measured, not assumed ([sq-adopt](../../implemented/testing/2026-08-26-session-query-adoption-experiment.md) 16/16 when the prompt names a prior-session recording).
3. **Token-cost regressions.** Caps pre-registered; retire-if-tie.
4. **Contamination of OOLONG-class corpora.** Seeded regeneration + name substitution; still a residual.
5. **Descendant walk fragility.** Addressed by header-keyed BFS on closed files; tests required in P0.
6. **False "same model" claims via `run.json` `model`.** Pin is `tierPatches` sha256.
