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

The stable finding across w6 and w7 is behavioral, not statistical: in all 20 engaged card sessions, Core was empty on every snapshot, 11/12 (w7) Checked lines were a verifier-blind "tests green", 7/8 engaged failures shipped on that line before the constraint verifier would have failed, no session ever called `jspace_close`, and session-query was mounted but never called. The modal failure everywhere is one subtle constraint application (`Number(match[1])` instead of `match[qty(1)]` in `m04-bin.js`), identical across arms. The card as prompted does not capture once-stated constraints, and its ritual adds ~1.6–2× input tokens and ~8 turns without adding scrutiny the task's own tests lack. No shipped default changes on this evidence; the next measurable intervention is driving once-stated constraints onto Core at card open and gating ship on constraint-referencing done-criteria, run as a new arm on the same task and overlay at n≥16.

## Alternatives considered

**Run an external benchmark first.** Rejected: leaderboard suites measure absolute capability under one fixed configuration and cannot attribute a delta to a single harness feature; the paired internal design answers the actual question at a fraction of the spend.

**Full 2^4 factorial over the new toggles.** Rejected: 16 arms multiply cost without adding decision-relevant contrasts; the ladder covers every rule the decision needs, and an interaction suspicion can add one arm later under a new experiment id.

**LLM-as-judge success scoring.** Rejected: bench protocol rule 4 already forbids it in v1, and the forensics record shows judge/keyword gates are gaming surfaces; verifier-passed success only.

**Measure on live user sessions instead of the bench.** Rejected as the primary instrument: live sessions lack controls, pairing, and repeatability; the forensics pass mines them for dysfunction discovery, not effect size.

## Acceptance criteria

- The five arms register with settings and composition overlays; the off-arm integrity audit extends to assert the absence of session-query tool events in arms that exclude the consumer.
- The catalog holds ≥15 tasks with every stratum populated, including one card-injection adversarial task whose verifier fails when the smuggled instruction executed.
- `trials.jsonl` records the new per-trial metrics; `report/build.js` aggregates them per arm×stratum.
- One full interleaved experiment (all five arms, ≥5 repeats) completes on lab5, and an implemented results note records the verdict against every pre-registered decision rule.

## Risks

- **Wide intervals from a small catalog:** 7→20 tasks and 5 repeats still yield modest power; the paired tests recover some, and the decision rules demand intervals excluding zero rather than point estimates, so an underpowered result reads "not yet", not "no effect".
- **API spend:** five arms × ~20 tasks × 5 repeats is real money on lab5's key; run the ladder incrementally (`off,on,on-sq` first) if budget bites, keeping interleaving within whatever subset runs together.
- **Runner extension risk:** per-arm composition overlays touch the runner's spawn path; the bench stays a standalone zero-dependency tool, so the overlay must be file-based, not a workspace import.
- **Transfer caveat:** bench tasks are synthetic; a clean win here still warrants the live-session dysfunction re-scan (dangling-card rate on fresh real sessions) before declaring the uplift delivered.
