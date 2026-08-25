# bench/ — J-Space A/B benchmark suite (W0)

Paired measurement of the J-Space card and session-query tools: same model, same tasks, same harness, intervention ON vs OFF. This directory is **standalone tooling**, not a pnpm workspace member: plain ESM Node, zero runtime dependencies, tests via `node --test`.

Conventions follow the established evaluation harnesses rather than inventing new ones: per-trial source of truth with rebuilt aggregates (Terminal-Bench), one manifest + JSONL per arm run (Inspect AI, lm-eval), a task×arm matrix as the primary report view (OpenCompass, Promptfoo, Terminal-Bench dashboard), mean ± stderr with Wilson/bootstrap intervals (Inspect, lm-eval), and a delta-vs-baseline summary grade (Braintrust). Uncertainty is mandatory; single-run claims are the failure mode this suite exists to avoid.

## Arms

The five-arm ladder covers every decision-relevant contrast. Each arm is a `--patch` overlay applied to the shipped headless composition: the jspace settings toggle plus `disabled: true` entries that exclude plugin ids from the composition when the arm does not want them.

| Arm | J-Space | Session-Query | Notes |
|---|---|---|---|
| `off` | disabled | excluded | Clean control: no jspace events, no session-query tool calls. |
| `on` | available | excluded | J-Space only; measures the jspace card in isolation. |
| `sq-only` | disabled | mounted | Session-query only; measures retrieval in isolation. |
| `on-sq` | available | mounted | Shipped default: both jspace and session-query. |
| `on-sq-verified` | available | mounted | `on-sq` plus `verifierTools: ['bash']` and `requireVerifiedEvidence: true`. |

Arms register in `runner/arms.js`. The overlay mechanism appends `disabled: true` rows for plugin ids like `session-query-sqlite` and `tool-session-query` to the per-trial patch YAML, leveraging the Cordis Loader's entry-level disable.

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

Real runs need `DEEPSEEK_API_KEY` and a built harness:

```sh
node bench/runner/run.js --experiment w0-2026-08-18 --arms off,on --repeats 3
```

## Protocol rules (pre-registered)

1. Arms run **interleaved** per task and repeat, never all-off-then-all-on — provider model drift must not confound the toggle.
2. Model, temperature, base URL, harness commit, and task set are pinned in `run.json`; a changed task set is a new experiment.
3. Every aggregate reports uncertainty; a delta without an interval is not a result.
4. Primary metric is verifier-passed task success; LLM judgment is not used in v1.
5. The decision rule is stated before running: default-on only if `on` beats `off` on the long-horizon stratum with the interval excluding zero, and the short-stratum token overhead stays acceptable.
6. Compaction-stress tasks force mid-task compaction through the sanctioned tunable, never a harness patch: `BasicCompactionConfig.thresholdRatio` (a validated config field of the `compaction-basic` plugin, default `0.8`; compaction fires at `floor(contextWindow × ratio)`), lowered via the arm overlay.

## Chain tasks

A task with `phases` (at least 2) in task.json runs as a chain: one scratch dir whose workspace carries across phases, but a separate headless spawn per phase with a fresh per-phase session root (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>/phase-<i>`) — the session boundary is the experiment. The verifier runs once, after the final phase, against the carried workspace; a phase ending in PROVIDER_ERROR or HARNESS_ERROR aborts the chain and excludes the trial from the pass rate. Trial-level metrics are per-phase sums. Carry is **cold-only** today: `resumedFrom` stays null because the harness has no headless/SDK session resume or fork yet; card carry across sessions is a proposed uplift.

Every trial (chains and single-session) passes an arm-integrity audit: no session root of the trial may pre-exist; arms not expecting jspace (`off`, `sq-only`) must contain zero `jspace/` events in their session logs; arms not expecting session-query (`off`, `on`) must contain zero session-query `tool/call` events. Violations are recorded on `trial.integrity.violations`; the trial still counts and the experiment never aborts.

## Forensics metrics

Per-trial metrics beyond pass/fail, computed from the session JSONL:

| Field | Type | Description |
|---|---|---|
| `tokensIncludingDescendants` | `number \| null` | Sum of input+output tokens over descendant sessions; null because descendant sessions are not observable from the runner's top-level session roots in v1. |
| `costIncludingDescendants` | `number \| null` | Estimated cost over descendant sessions; null for the same reason. |
| `danglingCard` | `boolean \| null` | Card open at session end; null for jspace-off arms. |
| `verifiedCheckpointShare` | `number \| null` | Fraction of checkpoint tool results carrying `verified: true`; null when no checkpoints exist. |
| `coverageRefusalThenPad` | `number` | Count of checkpoint-refusal → immediate retry-success sequences within the same turn. |
| `noopNoteRefusals` | `number` | Count of `JSPACE_NOTE_NOOP` tool results. |
| `noteCapRefusals` | `number` | Count of note-cap denial tool results. |
| `sessionQueryCalls` | `number \| null` | Count of session_search/session_event_search/session_event_read/session_event_trace/session_trace calls; null for arms excluding the session-query consumer. |

Aggregates flow through `report/build.js` into `ui/data.js`. The demo generator exercises every field.
