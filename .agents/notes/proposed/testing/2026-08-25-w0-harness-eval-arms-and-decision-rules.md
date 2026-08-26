# Agent Note: W0 harness evaluation — arm ladder, metrics, and decision rules for the 2026-08-25 uplift

Status: proposed

## Problem

The [long-horizon harness uplift](../feature/2026-08-25-long-horizon-harness-uplift.md) shipped its buildable workstreams (session-query mounted and driven, evidence-grade checkpoints, bounded card reprint, untrusted framing, note-spam refusals) with their net effect on task outcomes unmeasured — the exact W4 gap the plan names. The measurement instrument exists: `bench/` is a pre-registered paired A/B suite (interleaved arms, pinned manifest, Wilson/bootstrap intervals, McNemar, verifier-passed success as the primary metric, no LLM judging) but it knows only two arms (`off`, `on` for the J-Space toggle), carries seven tasks across four strata, and `runs/` holds only synthetic demo data — no real experiment has ever run. The new interventions have no arms, the ritual-compliance dysfunctions the [session forensics](../feature/2026-08-24-jspace-live-session-forensics.md) documented have no metrics, and the question "what do we measure against" has no recorded answer.

## What we measure against

The comparison target is ourselves, not a leaderboard: every claim is a paired delta between arms on identical tasks, the same pinned model, temperature, harness commit, and task set, with arms interleaved per task and repeat so provider drift cannot confound the toggle (bench protocol rules 1–3). The control arm is the same harness with the intervention off, so each delta isolates one feature's earned value at its token cost. External suites (Terminal-Bench, SWE-bench-lite) answer a different question — absolute agent capability — and become interesting only after the internal deltas justify the harness configuration they would run under.

## Proposal

### Arm ladder

Register in `bench/runner/arms.js`, keeping the paired design and skipping the full factorial; the ladder covers every decision-relevant contrast:

| Arm | Configuration |
|---|---|
| `off` | Control: jspace disabled, no session-query consumer (exists). |
| `on` | J-Space `available` (exists). |
| `sq-only` | Session-query tools + driver, jspace disabled — isolates the read path, the contrast the PRO-LONG evidence predicts carries most value. |
| `on-sq` | J-Space + session-query — the shipped default composition. |
| `on-sq-verified` | `on-sq` plus `verifierTools` naming the bench harness's shell tool and `requireVerifiedEvidence: true` — prices the evidence gate. |
| `on-adaptive` | `on-sq` plus `engageAfterSteps: 10` — separates the always-on prompt and schema cost from the card's long-horizon benefit. |
| `on-core` | `on` plus `requireCoreOnOpen` and `requireCoreForShip` — prices the constraint-capture gates against the arm whose sessions left Core empty. |

Primary contrasts: `off↔sq-only` (read path alone), `on↔on-sq` (read path given the card), `on-sq↔on-sq-verified` (gate benefit vs friction), `off↔on` (the original W0 question). Arms today are settings overlays; `sq-only`/`on-sq` differ by composition, so `arms.js` needs a per-arm cordis overlay in addition to the settings overlay — that runner extension is part of this work.

### Task catalog

Grow `bench/tasks/` from 7 to roughly 20, keeping the stratum design: more `long` and `chain` history-dependent tasks (where the literature locates the gains, e.g. multi-phase fixes whose later phases need facts from earlier tool output), retain `short` as the expected-no-gain control stratum, extend `adversarial` with a card-injection task (instructions smuggled into jspace_note content; the verifier checks the smuggled action did not execute — this measures the untrusted frame), and keep compaction-stress via the sanctioned `thresholdRatio` overlay.

### Metrics

Extend `bench/runner/metrics.js` to compute per trial, from the session logs the runner already owns: total tokens and cost including descendant sessions; dangling-card rate (card open at session end); verified-checkpoint share; coverage-refusal-then-pad sequences (the `by`-padding proxy); `JSPACE_NOTE_NOOP` and note-cap refusal counts; session-query call count and whether a queried fact was subsequently re-derived by re-running the producing tool. Trial success stays verifier-passed only.

### Statistics and decision rules

Existing stats stand (Wilson/bootstrap, McNemar, mandatory intervals). With a small catalog, run `--repeats 5` minimum per task×arm. Pre-registered rules, extending bench README rule 5: session-query stays default-mounted only if `on-sq` beats `on` (or `sq-only` beats `off`) on the long+chain strata with the interval excluding zero and short-stratum token overhead under 15%; `requireVerifiedEvidence` graduates from default-off to recommended-on only if `on-sq-verified` pass rate is not lower and the padding proxy drops; the reprint bound and note refusals need only non-regression on the long stratum. The two available backends (below) give the two-tier capability-floor stratification directly: the matrix runs once per tier, and a scaffolding feature that helps the stronger tier while hurting the weaker one is reported per tier, never pooled.

### Execution on lab5

No DeepSeek API key is available; the two real backends are a Z.ai key (GLM models over their OpenAI-compatible endpoint) and Ollama Cloud serving DeepSeek-V4-Flash (hosted; there is no local model). Both are pure configuration over routes the base profile already mounts on `llm-pi-ai`: a `zai` route (`apiKeyEnv: ZAI_API_KEY`, models from the pi-ai catalog) and an `ollama-cloud` route (`apiKeyEnv: OLLAMA_API_KEY`, `baseURL: https://ollama.com/v1`, `deepseek-v4-flash:cloud` with `contextWindow`/`maxTokens` pinned in the bundle). Both tiers are capable models, not a weak-vs-strong contrast; they measure harness effect across two independent frontier-class providers. Expect ceiling effects on short tasks: when pass rates saturate across arms, the verdict weight shifts to the long/chain and adversarial tasks and to efficiency and forensics metrics (tokens, turns, `danglingCard`, `verifiedCheckpointShare`) under the same pre-registered decision rules. V4-Flash's high output speed fits more turns into a fixed time budget than a slower model would; wall-time and turn comparisons are valid only across arms within one experiment, never across tiers. A tier file is therefore a config patch on `agent-default-model` naming that provider and model, not an adapter insert: the profile already mounts `llm-pi-ai`, and re-inserting it fails the load with `duplicate loader entry id`. Composition changes belong to the arm overlay instead, which is what mounts `tool-session-query` (absent from the profile) for the session-query arms. The provider route and model are experiment-level pins in `run.json` — identical across arms within an experiment, per protocol rule 2, so each tier is its own experiment id. Execution on the lab5 VM: clone at the pinned develop commit, `pnpm install && pnpm run build`, provide `ZAI_API_KEY` and `OLLAMA_API_KEY` either exported or via the harness credential store (`~/.shres/.credentials.yaml`, which the runner reads when the variable is unset and injects into each trial's environment; never copied into the repo), then `node bench/runner/run.js --experiment w4-<date>-<tier> --arms off,on,sq-only,on-sq,on-sq-verified --repeats 5` once per tier with the matching `--api-key-env` and `--tier-patch`, copy `runs/<experiment>/` back and rebuild the report (`node bench/report/build.js`). Results land as a new implemented note recording the verdict per decision rule and per tier, and the uplift plan's W4 section is settled by that note.

## Pilot result (2026-08-25)

Experiment `w4-2026-08-25-zai-pilot` ran arms `off`, `on`, and `on-sq` on Z.ai GLM-5.2 at 1 repeat, roughly 25 trials. Every arm passed 100% of trials: the catalog sits below a frontier model's floor, so the pilot settles no decision rule and the ceiling-effect risk this note anticipated is now measured, not hypothetical. The efficiency columns did separate. `on` cost 2.9× the input tokens and 33% more turns than `off` for the same outcome, worst on the longest tasks (5.4× on `compaction-stress-constraints`), because the card, driver, and four tool schemas are paid from turn one and the model then spends extra turns on note and checkpoint traffic. `on-sq` was consistently cheaper than `on`, consistent with PRO-LONG (arXiv 2607.20064): read-time history access substitutes for write-time note keeping. A sixth arm, `on-adaptive` (`on-sq` plus `engageAfterSteps: 10`), now registers to separate the always-on prompt and schema cost from the card's long-horizon benefit; the [adaptive-engagement note](../../implemented/feature/2026-08-25-jspace-adaptive-engagement.md) owns the mechanism it exercises. Separating the arms on correctness needs harder tasks before any decision rule can fire on this tier.

## Pressure results (2026-08-26)

Three follow-up experiments on the same Z.ai GLM-5.2 tier drove the catalog past the ceiling and produced the first mechanism-grade evidence. `w4-2026-08-25-zai-adaptive` (15 tasks × off/on/on-adaptive × 1) confirmed the cost half of adaptive engagement — on/off input 2.01×, on-adaptive/off 1.07× — but the turn-counting predicate never fired in single-prompt sessions, which motivated the step-based `engageAfterSteps` rework. `w5-pressure-2026-08-26` (4 pressure tasks × 3 arms × 1) stayed at ceiling: 12/12 pass, compaction never fired, so the card had no memory loss to compensate for. `w6-compaction-2026-08-26` (same 4 tasks × 3 arms × 2, forced-compaction overlay) broke the ceiling (off 6/8, on 7/8, on-adaptive 7/8, all ties at McNemar p = 1) and `w7-build-confirm-2026-08-26` (`constraint-survival-build` × 3 arms × 8, same overlay) reversed the point estimate: off 5/8, on 3/8, on-adaptive 3/8, both contrasts still `tie` (p = 0.625 / 0.6875), on/off tokens 1.64×.

The stable finding across w6 and w7 is behavioral, not statistical: in all 20 engaged card sessions, Core was empty on every snapshot, 11/12 (w7) Checked lines were a verifier-blind "tests green", 7/8 engaged failures shipped on that line before the constraint verifier would have failed, no session ever called `jspace_close`, and session-query was mounted but never called. The modal failure everywhere is one subtle constraint application (`Number(match[1])` instead of `match[qty(1)]` in `m04-bin.js`), identical across arms. The card as prompted does not capture once-stated constraints, and its ritual adds ~1.6–2× input tokens and ~8 turns without adding scrutiny the task's own tests lack. No shipped default changes on this evidence; the next measurable intervention is driving once-stated constraints onto Core at card open and gating ship on a non-empty Core, which the `on-core` arm carries — the [constraint-capture note](../../implemented/feature/2026-08-26-jspace-constraint-capture.md) owns the mechanism. Its pre-registered rule: those requirements graduate from default-off only if `on-core` beats `on` on `constraint-survival-build` under the same forced-compaction overlay at n ≥ 16.

`w8-core-2026-08-26` ran that decision at n = 16 paired repeats (`off` 7/16 vs `on-core` 6/16, McNemar p = 1, grade `tie`, Δ = −6.25 pp, discordant 3 wins / 4 losses / 9 ties; on-core/off input tokens 1.60×, turns 1.79×). The gates did populate Core in 6/16 sessions (trial 0 captured all six house rules verbatim on Core and still failed the qty slip), but prose on Core did not change the failure class: both arms fail almost entirely on bare `qty(...)` literals in m01/m04, with no new gate-driven failure modes. Every on-core session ended with `danglingCard = true`; checkpoint/ship traffic rose but Checked lines remain verifier-blind. **Verdict:** `requireCoreOnOpen` / `requireCoreForShip` do not graduate — presence-only prose capture loses to the control on pass rate at 1.6× token cost. The contract plan in the [harness-hardening note](../feature/2026-08-26-jspace-contract-and-harness-hardening.md) proceeds: typed executable charter checks with discrimination, not stronger prose on the card. The [w9 pre-registration](#w9-pre-registration) below is that run, at n = 62 paired trials.

## w9 pre-registration

The [contract plan](../feature/2026-08-26-jspace-contract-and-harness-hardening.md) names w9 as the decisive paired contrast for executor-enforced charter checks (plan items 1–5): `off` vs `on-charter`, on `constraint-survival-build` plus one task whose own test suite cannot see the once-stated constraints. This subsection is that pre-registration. Sample-size formulas and the pairing table live in [`bench/analysis/w9-power.js`](../../../../bench/analysis/w9-power.js); `node bench/analysis/w9-power.js` reprints them from the committed pairing fixture, and `--from-runs` checks the fixture against `trials.jsonl` via the same `pairOutcomes` the report grades with.

### Arms, tasks, and pins

**Arms.** `off` (control) vs `on-charter`: jspace available, typed executable charter required at open and seeded from the first user message, charter checks executed at checkpoint and ship through the standard executor path, session-query absent. The graded contrast is `off↔on-charter`, not `on-core↔on-charter`: the question is whether the enforced charter beats the unassisted harness, and a loss retires the card rather than adding another ritual. `on-charter` is not in `bench/runner/arms.js` until phase 1 of the contract plan ships; w9 does not start before that overlay exists.

**Tasks.** Pressure only, two tasks: `constraint-survival-build` (the w7/w8 instrument) and `constraint-survival-fare` (specified below; catalog entry is part of w9 setup, not this note). The primary McNemar is the pooled pairing over those two tasks. A short-stratum token canary (`typo-guard`, 5 repeats, same model pin, excluded from the pass-rate test) is a companion experiment id required before any default-on; it is not mixed into w9's 62 pairs.

**Pins.** Same as w7/w8: Z.ai GLM-5.2 (`bench/tiers/zai.patch.yml`), interleaved arms, forced-compaction overlay `bench/pressure/forced-compaction.patch.yml`, verifier-passed success, no LLM judge. Model, temperature, harness commit, and task set are pinned in `run.json`. Experiment id `w9-charter-<date>`.

### Sample size

Pairing is `taskId+trialIndex` on `status === 'success'` trials. Empirical discordance from the committed fixture [`w7-w8-pairing.json`](../../../../bench/analysis/w7-w8-pairing.json): w7 `off↔on` 1 win / 3 losses / 4 ties (ψ = 4/8 = 0.50, δ = −0.25); w8 `off↔on-core` 3 wins / 4 losses / 9 ties (ψ = 7/16 = 0.4375, δ = −0.0625). Primary ψ pools those two contrasts: 11 discordant / 24 pairs = **11/24 ≈ 0.4583**. w7 `off↔on-adaptive` (2 wins / 4 losses / 2 ties, ψ = 0.75) is reported and not pooled — that arm mounts session-query and delays engagement.

The planned alternative is |δ| = 0.25, the w7-scale effect the contract plan names (off 5/8 vs on 3/8), at two-sided α = 0.05 and power 0.8, using the bench's exact McNemar test (`mcnemarExactP` in [`bench/stats/paired.js`](../../../../bench/stats/paired.js)). Under the observed ψ, Connor's uncorrected approximation (1987, Biometrics 43:701–705) gives n = 55.14; the Miettinen/Fleiss continuity-corrected form n_cc = (n/4)(1 + √(1 + 4/(n|δ|)))² gives n = 62.89; the exact search (`exactMcnemarN`) gives **n = 62** (power 80.7%), already a multiple of two tasks, so **31 repeats per pressure task** (124 interleaved trials). Conditional on discordance, the exact binomial McNemar needs n_d = 25 discordant pairs at π = (ψ + δ)/(2ψ) ≈ 0.773.

Sensitivity, same δ = 0.25: at 0.5× observed ψ (≈ 0.229) the alternative is infeasible (|δ| > ψ), so a 25 pp lift cannot occur if discordance collapses that far; at 1.5× observed ψ (≈ 0.688) exact n = 91 (plan 92). The registration assumes the observed ψ = 11/24, not the higher-discordance adaptive contrast.

**Powered-run gate.** Analyze n = 62 eligible pairs. If realized discordant pairs < 25, the run is underpowered: the verdict is "not yet", never retirement and never "no effect". If realized n_d ≥ 25, the decision rule below fires.

### Decision rule

Graduate charter items 1–5 from default-off toward recommended-on only if all of: (i) `on-charter` beats `off` on the pooled pressure tasks (McNemar p < 0.05, δ > 0, bootstrap interval excluding zero), (ii) pressure-task total-token overhead on:off ≤ 1.25, (iii) the short-stratum canary holds input-token on:off ≤ 1.15. A pass-rate win that misses a token bound is `tradeoff`: do not graduate, do not retire; a cheaper charter composition is required before another default-on bid.

If at powered n (realized n_d ≥ 25) the charter arm **loses or ties** on pass rate, **retire jspace**. The recorded fallback is not a stricter ritual — not stronger prompts, not another presence-only Core gate, not a tighter ship check on prose. The log and session-query tools stand; the contract plan already names that fallback. The alternative this n is powered to detect is a 25 pp lift at ψ = 11/24; a smaller positive effect that fails to reject is treated as failure, not as a reason to run a harsher card.

### Token-neutrality bounds

The card's measured liability is 1.6–2.9× input tokens (w4–w7) and 1.60× on `on-core` (w8). The charter must not grow that tax.

**Short stratum (15% cap).** Input-token mean on:off ≤ 1.15 — the bound this note's Statistics section already requires for session-query default-mount (`on-sq` / `sq-only`), and the short-stratum tax `bench/demo/generate.js` models. Evaluated on the `typo-guard` canary, not on the pressure McNemar pool.

**Pressure / long stratum (1.25× tradeoff bound).** Total-token (input + output) on:off ≤ `TOKEN_OVERHEAD_MAX` = 1.25 in [`bench/stats/paired.js`](../../../../bench/stats/paired.js), the cut `gradeComparison` uses to distinguish `improvement` from `tradeoff`. Evaluated on the two pressure tasks. w7/w8 ran at 1.64× and 1.60× on this overlay; crossing 1.25× with a pass-rate win is still not graduation.

Strata are not pooled for token ratios. Ceiling pass rates on the short canary do not count as a correctness win.

### Second task: `constraint-survival-fare`

`constraint-survival-build` is not a clean "tests cannot substitute for the charter" instrument: its `node:test` files import `inv*` names, so the export-prefix house rule is test-visible, while `qty(...)` wrapping, the audit banner, the line budget, and the `InventoryError` class are source-form and only the post-hoc `verify.mjs` sees them. A charter check of `node --test` is already hollow for those source-form rules, but a model that writes charter checks as "run the suite" still gets a mid-session green on a prefix-correct, qty-violating workspace. w9 therefore includes one task where every once-stated constraint is invisible to the fixture tests even in principle.

**Cover story.** Implement eight transit-fare modules so the provided `node:test` suite goes green. Work in numeric order (m01…m08). The prompt reads as a normal coding task: zone lookup, base fare, transfer discount, daily cap, night surcharge, concession multiplier, journey pricing, receipt formatting. Specs name the public API and examples; they do not restate the house rules. `src/probe.js` is provided and is a no-op. The instruction must not name J-Space. The finish line is `node --test` green — the prompt never mentions the house-rule scanner.

**Modules.** `src/m01-zone.js` `zoneForStop(stopId)`; `src/m02-base.js` `baseFare(fromZone, toZone)`; `src/m03-transfer.js` `transferDiscount(prev, next)`; `src/m04-cap.js` `applyDailyCap(spent, candidate)`; `src/m05-night.js` `nightSurcharge(fare, minutesAfterMidnight)`; `src/m06-concession.js` `concessionFare(fare, kind)`; `src/m07-journey.js` `priceJourney(legs, options)`; `src/m08-receipt.js` `formatReceipt(priced)`. Each has a `test/mNN-*.test.js` that imports only those names and asserts return values and thrown-message regexes.

**Once-stated constraints** (stated once at the top of the instruction; not repeated per module):

1. **Banner.** First line of every created module is exactly `/* FARE-CORE: RS-9F2A */`.
2. **Probe.** First statement of every exported function is `probe('<functionName>')` from `./probe.js`. Tests never import `probe` and never assert it ran.
3. **No template literals.** Created modules contain no backtick; string construction uses quotes and `+`.
4. **`const` only.** No `let` or `var` in created modules.
5. **Line width.** No physical line exceeds 88 characters.
6. **Forbidden clocks.** Created modules do not mention `Date`, `Math.random`, `performance`, or `process`.

**Why the test suite is structurally blind.** Tests import the fare API and assert I/O. They never `readFileSync` implementation files, never parse AST, never import `probe`, never check banners or line width. A behaviorally correct module that omits the banner, skips `probe()`, uses a template literal and `let`, exceeds 88 columns, and names `Date` still yields `node --test` green. Therefore `node --test` cannot substitute for the charter: a hollow check of the suite passes on a workspace that violates every house rule.

**Verifier.** Runner-owned `verify.mjs`, same contract as `constraint-survival-build`: source scans for the six rules, then `node --test`; exit 0 only if both hold; print per-module per-rule failures. The agent is not told to run it. Discrimination pin for the task author (not the agent): a seeded mutant that deletes `probe()` calls and the banner must keep `node --test` green and fail `verify.mjs`. Charter checks that only invoke the test suite are therefore non-discriminating in the sense the contract plan requires; checks that grep the banner or wrap `probe(` can discriminate.

**Stratum / budget.** `pressure`; `timeoutMs` 900000; `maxTurns` 120; eight modules so the forced-compaction overlay still fires as it did on the ten-module build task. Spec only; the catalog entry is authored with the `on-charter` arm.

## Alternatives considered

**Run an external benchmark first.** Rejected: leaderboard suites measure absolute capability under one fixed configuration and cannot attribute a delta to a single harness feature; the paired internal design answers the actual question at a fraction of the spend.

**Full 2^4 factorial over the new toggles.** Rejected: 16 arms multiply cost without adding decision-relevant contrasts; the ladder covers every rule the decision needs, and an interaction suspicion can add one arm later under a new experiment id.

**LLM-as-judge success scoring.** Rejected: bench protocol rule 4 already forbids it in v1, and the forensics record shows judge/keyword gates are gaming surfaces; verifier-passed success only.

**Measure on live user sessions instead of the bench.** Rejected as the primary instrument: live sessions lack controls, pairing, and repeatability; the forensics pass mines them for dysfunction discovery, not effect size.

**Power w9 for the w8 point estimate (|δ| = 6.25 pp).** Rejected: that alternative is a much smaller signal, and the [contract plan](../feature/2026-08-26-jspace-contract-and-harness-hardening.md) names the w7-scale 25 pp effect as the lift worth detecting. A smaller true effect that n = 62 misses is accepted as retirement, not as a reason to keep enlarging the card.

**Pool w7 `on-adaptive` into the planning ψ.** Rejected: that arm mounts session-query and delays engagement, so its ψ = 0.75 is a different composition. Planning uses the two intervention-vs-`off` contrasts that informed the charter decision (`on`, `on-core`).

## Acceptance criteria

- The five arms register with settings and composition overlays; the off-arm integrity audit extends to assert the absence of session-query tool events in arms that exclude the consumer.
- The catalog holds ≥15 tasks with every stratum populated, including one card-injection adversarial task whose verifier fails when the smuggled instruction executed.
- `trials.jsonl` records the new per-trial metrics; `report/build.js` aggregates them per arm×stratum.
- One full interleaved experiment (all five arms, ≥5 repeats) completes on lab5, and an implemented results note records the verdict against every pre-registered decision rule.

## Risks

- **Wide intervals from a small catalog:** 7→20 tasks and 5 repeats still yield modest power; the paired tests recover some, and the decision rules demand intervals excluding zero rather than point estimates, so an underpowered result reads "not yet", not "no effect".
- **API spend:** five arms × ~20 tasks × 5 repeats is real money on lab5's key; run the ladder incrementally (`off,on,on-sq` first) if budget bites, keeping interleaving within whatever subset runs together. w9 is 124 pressure trials (31 × 2 tasks × 2 arms) at the w8 cadence (~8 min/trial); do not drop repeats to finish faster — an underpowered finish is "not yet".
- **Runner extension risk:** per-arm composition overlays touch the runner's spawn path; the bench stays a standalone zero-dependency tool, so the overlay must be file-based, not a workspace import.
- **Transfer caveat:** bench tasks are synthetic; a clean win here still warrants the live-session dysfunction re-scan (dangling-card rate on fresh real sessions) before declaring the uplift delivered.
