# bench/ — J-Space A/B benchmark suite (W0)

Paired measurement of the J-Space card and session-query tools: same model, same tasks, same harness, intervention ON vs OFF. This directory is **standalone tooling**, not a pnpm workspace member: plain ESM Node, zero runtime dependencies, tests via `node --test`.

Conventions follow the established evaluation harnesses rather than inventing new ones: per-trial source of truth with rebuilt aggregates (Terminal-Bench), one manifest + JSONL per arm run (Inspect AI, lm-eval), a task×arm matrix as the primary report view (OpenCompass, Promptfoo, Terminal-Bench dashboard), mean ± stderr with Wilson/bootstrap intervals (Inspect, lm-eval), and a delta-vs-baseline summary grade (Braintrust). Uncertainty is mandatory; single-run claims are the failure mode this suite exists to avoid.

## Arms

The eight-arm ladder covers every decision-relevant contrast. `sq-driver` exists for the session-query adoption experiment. Each arm is a `--patch` overlay applied to the shipped headless composition, which mounts `jspace` with `enabled: false` and does not mount the model-facing session-query tool at all.

| Arm | J-Space | Session-Query | Notes |
|---|---|---|---|
| `off` | disabled | absent | Clean control: no jspace events, no session-query tool calls. |
| `on` | available | absent | J-Space only; measures the jspace card in isolation. |
| `sq-only` | disabled | mounted | Session-query only; measures retrieval in isolation. |
| `sq-driver` | disabled | mounted | `sq-only` plus one system-prompt driver line naming the session-query tools; the adoption-experiment contrast. |
| `on-sq` | available | mounted | Shipped default composition plus the session-query tool. |
| `on-sq-verified` | available | mounted | `on-sq` plus `verifierTools: ['bash']` and `requireVerifiedEvidence: true`. |
| `on-adaptive` | available from step 10 | mounted | `on-sq` plus `engageAfterSteps: 10`; isolates the always-on prompt and schema cost from the card's long-horizon benefit. |
| `on-core` | available | absent | `on` plus `tool-jspace` `requireCoreOnOpen: true` and `requireCoreForShip: true`; prices the constraint-capture gates against `on`, the arm whose sessions left Core empty. |

Arms register in `runner/arms.js`. Every overlay carries a `jspace` config patch and the per-trial persistence redirect; an arm with a `toolJspace` config adds a `tool-jspace` patch; session-query arms additionally patch the shipped `session-query-sqlite` service to open a per-trial index at startup (it ships with `openAt: never` and an in-memory path) and append an `- insert:` layer mounting `tool-session-query`. Arms without session-query need no disable rows, because the tool is absent from the profile.

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
  tiers/        Provider-swap experiment overlays (`--tier-patch`)
  pressure/     Repeatable experiment overlays that force mid-task memory pressure
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

Real runs need an API key (or `--api-key-env none` for keyless tiers) and a built harness:

```sh
node bench/runner/run.js --experiment w0-2026-08-18 --arms off,on --repeats 3
node bench/runner/run.js --experiment w5-pressure --tasks 'constraint-survival-*,chain-ledger-deep' --arms off,on --repeats 1
node bench/runner/run.js --experiment w9-charter --arms off,on --repeats 31 --concurrency 4
```

`--concurrency <n>` (default `1`) runs up to n trials at once from the interleaved plan. Each trial already owns a unique scratch dir (`runs/<experiment>/scratch/<arm>/<taskId>/<trialIndex>`) and session-log root (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>`), so concurrent workers do not collide. `trials.jsonl` may append out of completion order; the report pairs on `taskId+trialIndex`, not file order. `1` is sequential and is the historical runner. SIGINT/SIGTERM abort in-flight harness processes and leave every already-appended line intact (`run.json` `endedAt` stays empty).

## Provider tiers

The runner generalizes beyond DeepSeek: `--api-key-env <VAR|none>` names the credential environment variable (`DEEPSEEK_API_KEY` by default), and `--tier-patch <path>` is a repeatable experiment-level composition overlay applied to every spawn after the per-arm overlay, in the order given. When the variable is not exported, the runner reads it from the harness credential store (`$SHRES_HOME/.credentials.yaml`, default `~/.shres`) and injects the value into the child environment — required because each trial runs under an experiment-local `SHRES_HOME` that hides the real store; the value never reaches any bench record. The CLI passes the arm overlay and every `--tier-patch` as repeated `--patch` flags — the shres launcher accepts repeatable `--patch` and flattens all layers into one `applyEntryPatches` call. `run.json` records the env var name (never the value) in `apiKeyEnv` and each overlay's path + SHA-256 in `tierPatches`, so a changed overlay file is a new experiment.

Ready tier overlays live in `bench/tiers/`. Each is a pure config patch on the `agent-default-model` entry, selecting one of the routes the base profile's `llm-pi-ai` entry already declares (`zai` with `apiKeyEnv: ZAI_API_KEY`, `ollama-cloud` with `apiKeyEnv: OLLAMA_API_KEY` and `baseURL: https://ollama.com/v1`). No tier file inserts or disables an adapter entry: the profile mounts `llm-pi-ai` itself, so inserting it again fails the load with `duplicate loader entry id`. A `config` key replaces the entry's whole config, so each tier file restates both `provider` and `model`.

**Z.ai tier** (GLM-5.2 via the shipped `zai` route):

```sh
node bench/runner/run.js \
  --experiment w4-2026-08-25-zai \
  --arms off,on,sq-only,on-sq,on-sq-verified,on-adaptive \
  --repeats 5 \
  --api-key-env ZAI_API_KEY \
  --tier-patch bench/tiers/zai.patch.yml
```

**Ollama Cloud tier** (DeepSeek-V4-Flash, hosted, key from https://ollama.com/settings/keys):

```sh
node bench/runner/run.js \
  --experiment w4-2026-08-25-ollama \
  --arms off,on,sq-only,on-sq,on-sq-verified,on-adaptive \
  --repeats 5 \
  --api-key-env OLLAMA_API_KEY \
  --tier-patch bench/tiers/ollama-deepseek.patch.yml
```

Both tiers are capable models, so expect ceiling effects on the short tasks: when pass rates saturate across arms, the discriminating signal moves to the long/chain and adversarial tasks and to the efficiency and forensics columns (tokens, turns, `danglingCard`, `verifiedCheckpointShare`). V4-Flash's high output speed also means more turns fit inside a task's time budget than on a slower tier — never compare wall time or turn counts across experiments, only across arms within one.

When `--api-key-env` is not `DEEPSEEK_API_KEY`, the `--base-url` default becomes null (the `DEEPSEEK_BASE_URL` env var fallback applies only for the default DeepSeek case).

## Pressure overlays

The catalog's 10–30-turn tasks never consume enough tokens to hit the shipped compaction threshold (`0.8 ×` a 1M-token window). Long-horizon features (J-Space card, session-query) only show their value under memory pressure — tokens consumed versus context available — so the bench forces that ratio with a composition overlay instead of inventing longer tasks.

`bench/pressure/forced-compaction.patch.yml` patches the shipped `compaction-basic` entry so automatic compaction fires around 10k–20k conversation tokens on the 1M-window models this suite uses. A patch `config` key replaces the entry's whole config, so the file restates every field automatic compaction needs. The overlay is experiment-level and applies identically to every arm; it is not an arm contrast.

`--tier-patch` is repeatable. Combine a provider tier with forced compaction by passing both, arm overlay first, then these in order:

```sh
node bench/runner/run.js \
  --experiment w4-2026-08-25-zai-pressure \
  --arms off,on,sq-only,on-sq,on-sq-verified,on-adaptive \
  --repeats 5 \
  --api-key-env ZAI_API_KEY \
  --tier-patch bench/tiers/zai.patch.yml \
  --tier-patch bench/pressure/forced-compaction.patch.yml
```

Each trial records `compactionCount` (`compaction/end` events in the session log) and `pressureFired` (`compactionCount > 0`). A long-horizon verdict only counts on trials where `pressureFired` is true — a pass-rate delta on trials that never compacted is not evidence about memory pressure.

## Protocol rules (pre-registered)

1. Arms run **interleaved** per task and repeat, never all-off-then-all-on — provider model drift must not confound the toggle. `--concurrency` does not reorder that list.
2. Model, temperature, base URL, harness commit, and task set are pinned in `run.json`; a changed task set is a new experiment.
3. Every aggregate reports uncertainty; a delta without an interval is not a result.
4. Primary metric is verifier-passed task success; LLM judgment is not used in v1.
5. The decision rule is stated before running: default-on only if `on` beats `off` on the long-horizon stratum with the interval excluding zero, and the short-stratum token overhead stays acceptable.
6. Mid-task compaction is forced through the sanctioned `BasicCompactionConfig` fields (`thresholdRatio`, default `0.8`; fires at `floor(contextWindow × ratio)`), never a harness source patch. The repeatable `--tier-patch` overlay `bench/pressure/forced-compaction.patch.yml` is the experiment-level way to lower that threshold identically on every arm.

## Chain tasks

A task with `phases` (at least 2) in task.json runs as a chain: one scratch dir whose workspace carries across phases, but a separate headless spawn per phase with a fresh per-phase session root (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>/phase-<i>`) — the session boundary is the experiment. The verifier runs once, after the final phase, against the carried workspace; a phase ending in PROVIDER_ERROR or HARNESS_ERROR aborts the chain and excludes the trial from the pass rate. Trial-level metrics are per-phase sums. Carry is **cold-only** today: `resumedFrom` stays null because the harness has no headless/SDK session resume or fork yet; card carry across sessions is a proposed uplift.

Every trial (chains and single-session) passes an arm-integrity audit: no session root of the trial may pre-exist; arms not expecting jspace (`off`, `sq-only`, `sq-driver`) must contain zero `jspace/` events in their session logs; arms not expecting session-query (`off`, `on`) must contain zero session-query `tool/call` events. The audit only checks absence, so an arm that permits jspace records no violation when a trial logs no jspace event — the expected outcome for an `on-adaptive` trial that finishes before step 10. Violations are recorded on `trial.integrity.violations`; the trial still counts and the experiment never aborts.

A task whose `task.json` names `setup` runs that command after the fixture copy and before the spawn, with argv `<scratch-dir> <session-log-root>`. `session-query-adoption` uses this to plant a prior-session JSONL into the trial persistence root (header `cwd` rewritten to the scratch dir so session-query workspace authority admits it). The trial locator skips `bench-prior-*` session ids so the planted log is never folded as the trial transcript. Adoption (whether session-query ran) is `metrics.sessionQueryCalls`; the verifier scores only whether the shipped workspace used the recorded fact.

The adoption experiment is `--arms sq-only,sq-driver --tasks session-query-adoption`.

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
| `compactionCount` | `number` | Count of `compaction/end` events (one closed compaction attempt). |
| `pressureFired` | `boolean` | `compactionCount > 0`. A long-horizon verdict only counts on trials where this is true. |

Aggregates flow through `report/build.js` into `ui/data.js`. The demo generator exercises every field.

## Report

`node bench/report/build.js [--experiment <name>|latest]` rebuilds per-arm `results.json` and `bench/ui/data.js` from `trials.jsonl`. `latest` (the default) picks the `runs/` directory with the newest modification time.

The payload's `comparisons` array holds one `off` vs treatment record for every non-baseline arm present in the experiment (`off` vs `on`, `off` vs `on-adaptive`, and so on). Each record carries the McNemar grade, accuracy delta, and per-task paired rows; there is no singular `comparison` field. Arm summaries include forensics and compaction aggregates (`meanDanglingCard`, `meanVerifiedCheckpointShare`, `meanSessionQueryCalls`, `totalNoopNoteRefusals`, `totalCompactionCount`, `pressureFiredRate`). The `pressure` stratum is a first-class catalog value alongside `long`, `short`, `adversarial`, and `chain`.

Serve the static report with `node bench/report/serve.js`. The UI contract lives in `bench/ui/CONTRACT.md`.
