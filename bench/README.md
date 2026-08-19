# bench/ — J-Space A/B benchmark suite (W0)

Paired measurement of the J-Space card: same model, same tasks, same harness, intervention ON vs OFF. This directory is **standalone tooling**, not a pnpm workspace member: plain ESM Node, zero runtime dependencies, tests via `node --test`.

Conventions follow the established evaluation harnesses rather than inventing new ones: per-trial source of truth with rebuilt aggregates (Terminal-Bench), one manifest + JSONL per arm run (Inspect AI, lm-eval), a task×arm matrix as the primary report view (OpenCompass, Promptfoo, Terminal-Bench dashboard), mean ± stderr with Wilson/bootstrap intervals (Inspect, lm-eval), and a delta-vs-baseline summary grade (Braintrust). Uncertainty is mandatory; single-run claims are the failure mode this suite exists to avoid.

## Arms

| Arm | Meaning |
|---|---|
| `off` | Control. `jspace` `enabled: false` — zero prompt, tool, or token difference. |
| `on` | `enabled: true`, `mode: available` — tools and prompt sections mount; loop-classified requests auto-open a card, while shorter work may open one explicitly. |

Further first-party arms register in `runner/arms.js` when measured. The suite does not vendor the third-party J-Space skill.

## Layout

```
bench/
  schema/       Validation + JSDoc typedefs for every on-disk record (the contract)
  runner/       Executes tasks against the harness per arm, writes trials.jsonl + run.json
  stats/        Aggregation, Wilson/bootstrap intervals, paired tests (McNemar, tie counts)
  report/       Rebuilds results.json per arm and ui/data.js for the report
  ui/           Static zero-build report (index.html + SVG charts); reads generated data.js
  demo/         Seeded synthetic data so the UI runs without an API key
  tasks/        Task catalog: instruction + fixture + verifier per directory
  tests/        node --test suites
  runs/         Output. runs/<experiment>/<arm>/{run.json, trials.jsonl, results.json}
```

## Use

```sh
node bench/demo/generate.js            # synthetic data into runs/demo/
node bench/report/build.js             # rebuild aggregates + ui/data.js
node bench/report/serve.js             # open the report at http://127.0.0.1:7474
node --test bench/tests/*.test.js        # unit tests
```

Real runs need a built harness plus the provider's credential (`DEEPSEEK_API_KEY` for the default route; other providers resolve their own `apiKeyEnv`, e.g. `OLLAMA_API_KEY` for `ollama-cloud`):

```sh
node bench/runner/run.js --experiment w0-2026-08-18 --arms off,on --repeats 3

# Ollama Cloud (provider/model are pinned into every trial's overlay, and run.json records them):
OLLAMA_API_KEY=… node bench/runner/run.js --experiment w0-ollama --provider ollama-cloud --model deepseek-v4-flash:cloud
```

## Protocol rules (pre-registered)

1. Arms run **interleaved** per task and repeat, never all-off-then-all-on — provider model drift must not confound the toggle.
2. Provider, model, base URL, optional context-window treatment, harness commit, and task set are pinned in `run.json`; a changed task set is a new experiment. Temperature is not claimed because the runner does not apply one.
3. Every aggregate reports uncertainty; a delta without an interval is not a result.
4. Primary metric is verifier-passed task success; LLM judgment is not used in v1.
5. The decision rule is stated before running: default-on only if `on` beats `off` on the long-horizon stratum with the interval excluding zero, and the short-stratum token overhead stays acceptable.
6. Compaction-stress tasks force mid-task compaction through the sanctioned tunable, never a harness patch: `BasicCompactionConfig.thresholdRatio` (a validated config field of the `compaction-basic` plugin, default `0.8`; compaction fires at `floor(contextWindow × ratio)`), lowered via the arm overlay.

## Chain tasks

A task with `phases` (at least 2) in task.json runs as a chain: one scratch dir whose workspace carries across phases, but a separate headless spawn per phase with a fresh per-phase session root (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>/phase-<i>`) — the session boundary is the experiment. The verifier runs once, after the final phase, against the carried workspace; a phase ending in PROVIDER_ERROR or HARNESS_ERROR aborts the chain and excludes the trial from the pass rate. Trial-level metrics are per-phase sums. Carry is **cold-only** today: `resumedFrom` stays null because the harness has no headless/SDK session resume or fork yet; card carry across sessions is a proposed uplift.

Every trial (chains and single-session) passes an arm-integrity audit: no session root of the trial may pre-exist, and the off arm's session logs must contain zero `jspace/` events. Violations are recorded on `trial.integrity.violations`; the trial still counts and the experiment never aborts.

## J-Space metrics

Session-log metrics distinguish attempts from accepted state changes and successful results. `checkpointAttempts` counts calls; `checkpointWrites` counts new Checked entries in `jspace/card`; `shipAttempts` counts calls; `shipPasses` counts non-error ship results. `retryDenials` counts actual J-Space repeat refusals, while `duplicateCallAttempts` only groups repeated signatures. Card metrics record opens, non-placeholder Goal writes, Core writes, and placeholder Goals left open at session end. The legacy `identicalRetries` and `checkpoints` fields remain aliases so earlier run artifacts still validate.
