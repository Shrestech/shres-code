# Agent Note: J-Space W0 benchmark suite (bench/)

Status: implemented

## Problem

The J-Space seat shipped with its value unmeasured: [W0](../../implemented/feature/2026-08-18-jspace-settings-toggle.md) stayed deferred, and both deployment reviews ([Claude](../feature/2026-08-18-jspace-deployment-review-and-uplift-claude.md), [Kimi](../feature/2026-08-18-jspace-deployment-review-and-uplift-kimi.md)) name the missing measurement as the highest-leverage gap and the gate for any capability uplift or default-on decision. No instrument existed to produce it. Writing one from scratch risked diverging from how recognized evaluation harnesses model runs, statistics, and reports — the [Scaffold Effect](https://arxiv.org/html/2607.22585v1) shows harness-level differences swamp the effect being measured, so the instrument's own conventions had to be defensible.

## Decision

`bench/` is a standalone, zero-dependency ESM Node suite at the repo root — deliberately **not** a pnpm workspace member, so no repo gate (knip, tsc project layout, coverage) sweeps it and real runs need no build of the report itself. It measures J-Space ON vs OFF as paired arms over a versioned task catalog with verifier-decided outcomes.

Conventions are copied from six recognized tools rather than invented:

- **Data model**: `runs/<experiment>/<arm>/{run.json, trials.jsonl, results.json}`. `trials.jsonl` is the source of truth (Terminal-Bench per-trial pattern); `run.json` pins model, temperature, task set, git commit, and arm config (Inspect/lm-eval identity record); `results.json` is rebuilt, never authored. Stable `taskId + trialIndex` is the A/B pairing key (Braintrust comparison-key lesson). Failure modes separate infrastructure errors from verifier failures (Promptfoo's failureReason).
- **Statistics**: accuracy ± stderr with Wilson intervals, seeded bootstrap CIs for means and paired deltas, exact McNemar over discordant pairs, unbiased pass@k, and an Improvement/Regression/Tradeoff/Tie comparison grade with a 25% token-overhead threshold (Inspect's mandatory uncertainty; Braintrust's grade). Single-run claims are rejected by construction: intervals are part of every aggregate.
- **Report**: static zero-build HTML at `bench/ui/` reading one generated `data.js` (Inspect's bundle pattern): Summary headline table, task×arm heat-colored matrix with m/n cells and a bold-when-significant rule, charts (grouped bars with CI whiskers, paired scatter with tie diagonal, stratum radar, per-task delta chart), and a filterable Trials drill-down with filter state in the URL hash (Promptfoo/Terminal-Bench shareability). Demo data banners itself as synthetic.
- **Protocol** (pre-registered in [bench/README.md](../../../../bench/README.md)): arms interleave per (task, trial); a changed task set is a new experiment; primary metric is verifier-passed success, no LLM judge in v1; the default-on decision rule is stated before running.

The runner launches the real harness per trial (`node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch <arm overlay> "<task>"`) with `SHRES_HOME` pointed into the experiment dir so user settings cannot leak into the measured composition, folds metrics from the session log, runs the task verifier, and appends validated trial records incrementally so a crashed run keeps its data. `demo/generate.js` emits a seeded synthetic experiment so the report is verifiable without an API key. The catalog, chain task type, and report UI grew in the follow-up [chain gym and report v2](2026-08-18-jspace-chain-gym-and-report-v2.md).

## Alternatives considered

**A workspace-member React/Vite report app.** Rejected: it drags the measurement instrument under hygiene/coverage gates and install weight meant for product code, and the report is a local artifact, not product surface.

**Reuse a SaaS/experiment tracker (Braintrust, LangSmith, W&B).** Rejected: runs must stay local, keyless except the provider, and reviewable in the repo; their export formats (NDJSON, comparison keys) informed the design instead.

**Hand-roll without studying existing harnesses.** Rejected: pass-rate-without-intervals and unpinned run identity are the exact credibility failures this suite exists to avoid; copying six tools' convergent conventions is cheaper than rediscovering them.

**LLM-as-judge scoring.** Deferred: v1 outcomes are verifier-decided only; judge blinding machinery can join later for free-text strata.

## Consequences

W0 is runnable: `node bench/runner/run.js --experiment <name> --arms off,on --repeats 3` after `pnpm install` in the checkout, with `DEEPSEEK_API_KEY` set. The report loop is `demo/generate.js` → `report/build.js` → `report/serve.js`. What it does not yet do: real end-to-end runs (needs the API key and a built harness), adversarial-arm coverage beyond one starter task, and LLM-judged strata. `bench/runs/` is gitignored; results are artifacts, not source.

## Testing

`node --test bench/tests/*.test.js` — 98 tests across stats (Wilson/bootstrap/McNemar/pass@k/grade boundaries), schema-conformant demo generation with a 40-seed directional sweep, report building over fake runs trees, UI chart structure via a DOM shim, runner metrics folding over fabricated session logs, and task-verifier discrimination (unmodified fixture fails, simulated perfect agent passes). The assembled report was browser-verified on synthetic data: all four views render, cell click-through filters Trials, empty state works without `data.js`.

## Related

- [J-Space as a Settings-toggled harness card](../../implemented/feature/2026-08-18-jspace-settings-toggle.md) — the seat under measurement; owns the W0 deferred item this instruments.
- Deployment reviews: [Claude](../feature/2026-08-18-jspace-deployment-review-and-uplift-claude.md), [Kimi](../feature/2026-08-18-jspace-deployment-review-and-uplift-kimi.md) — both gate capability uplift on this measurement.
