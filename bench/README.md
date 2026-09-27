# bench/ — J-Space A/B benchmark suite (W0)

Paired measurement of harness interventions: same model, tasks and harness, with the intervention ON vs OFF. This directory is **standalone tooling**, not a pnpm workspace member: plain ESM Node with `node --test`. Replay tooling imports the repository’s built package exports; general planning and result analysis do not.

Conventions follow the established evaluation harnesses rather than inventing new ones: per-trial source of truth with rebuilt aggregates (Terminal-Bench), one manifest + JSONL per arm run (Inspect AI, lm-eval), a task×arm matrix as the primary report view (OpenCompass, Promptfoo, Terminal-Bench dashboard), mean ± stderr with Wilson/bootstrap intervals (Inspect, lm-eval), and a delta-vs-baseline summary grade (Braintrust). Uncertainty is mandatory; single-run claims are the failure mode this suite exists to avoid.

## Arms

The nine-arm ladder covers every jspace/session-query contrast. `sq-driver` exists for the session-query adoption experiment. `on-charter` is the w9 treatment: executor-enforced charter checks, graded against `off`. OOLONG-lite adds `stuffed`, `read`, and `code` (see below). Each arm is a `--patch` overlay applied to the shipped headless composition, which mounts `jspace` with `enabled: false` and does not mount the model-facing session-query tool at all.

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
| `on-charter` | available | absent | `on` plus `tool-jspace` `requireCharter`, `requireExecutableCharter`, `charterSeed`, `charterDiscrimination: 'required'`, `charterCheckTimeoutMs: 30000`, `maxCharterEntries: 12`, `charterChecksMustBeReadOnly: true`. Seat stays `available` (`requireCharter` refuses `always-open`). |
| `stuffed` | disabled | absent | OOLONG-lite: corpus inlined in the instruction (`stuffedInstruction`); refuses a forced-compaction overlay. |
| `read` | disabled | mounted | OOLONG-lite: corpus on disk + session-query (same mount as `sq-only`). |
| `code` | disabled | mounted | OOLONG-lite: `read` plus `tools.mode: both` (headless already inserts `code-runtime`; re-inserting it is a duplicate-id load failure). |
| `research-inert` | disabled | absent | Researcher surface mounted (tracker spool-only + ledger + tools + aegis/ward/stride seats), protocol `enabled: false`. |
| `research-lite` | disabled | absent | Same surface, protocol `enabled: true, requireDesignDefense: 'off'`. |
| `research-on` | available | absent | Same surface, `requireDesignDefense: 'per-epoch'`, plus jspace `verifierTools: ['bash','experiment_verify_decision_rule']` and `requireVerifiedEvidence: true` (the on-sq-verified pattern). |
| `route-off` | disabled | absent | Jev routing control: `agent-default-model` pinned to the strong route; neither the judgment engine nor the router inserted. |
| `route-on` | disabled | absent | Jev routing treatment: the same pin plus `judgment-dispatch` (`defaultEngine: typesafe`), `judgment-typesafe`, and `model-router` (`initialMode: 'on'`), one allowlisted candidate. |
| `compact-basic` | disabled | absent | Jev compaction control: `compaction-basic` restating the forced-compaction posture as one whole config. |
| `compact-jev` | disabled | absent | Jev compaction treatment: the same posture with `compaction-basic` disabled and `compaction-jev` inserted beside the judgment engine. |
| `route-strong` | disabled | absent | Routing-measurement arm S (opt-in): always-strong on its own metered Anthropic key, neither engine nor router mounted. |
| `route-cheap` | disabled | absent | Routing-measurement arm C (opt-in): the cheap route end to end; calibration run and L3 only. |
| `route-coldpoint` | disabled | absent | Routing-measurement arm R (opt-in): quota base with cold-point entry, the local Laya judge, and the preregistered operating point; needs PR 12. |
| `route-random` | disabled | absent | Routing-measurement arm N (opt-in): R's composition with the seeded `bench-random` engine at R's realized entry rate; needs PR 12. |
| `route-static` | disabled | absent | Routing-measurement arm T (opt-in, L3): strong main conversation with no judgment engine, spawned children on Flash through static policies; forks are excluded. Real T trials require owner confirmation of this exploratory definition. |

Arms register in `runner/arms.js`. Every overlay carries a `jspace` config patch and the per-trial persistence redirect; an arm with a `toolJspace` config adds a `tool-jspace` patch; session-query arms additionally patch the shipped `session-query-sqlite` service to open a per-trial index at startup (it ships with `openAt: never` and an in-memory path) and append an `- insert:` layer mounting `tool-session-query`. The `code` arm patches `tools.mode` to `both`. Arms without session-query need no disable rows, because the tool is absent from the profile.

## Layout

```
bench/
  schema/       Validation + JSDoc typedefs for every on-disk record (the contract)
  runner/       Executes tasks against the harness per arm, writes trials.jsonl + run.json
  stats/        Aggregation, Wilson/bootstrap intervals, paired tests (McNemar, tie counts)
  report/       Rebuilds results.json per arm and ui/data.js for the report
  analysis/     Recomputations over stored runs with zero API spend (out-of-loop table, model ranking)
  ui/           Static zero-build report (index.html + SVG charts); reads generated data.js
  demo/         Seeded synthetic data so the UI runs without an API key
  prices/       Dated research price snapshots (never edited once published)
  accounting.json  Route-to-price mapping, subscription routes, and judge engines for priced accounting
  tasks/        Task catalog: instruction + fixture + verifier per directory
  tiers/        Provider-swap experiment overlays (`--tier-patch`)
  pressure/     Repeatable experiment overlays that force mid-task memory pressure
  routing/      Pinned treatment rows of the Jev routing arms, emitted verbatim into their per-trial overlay
  compaction/   Pinned treatment rows of the Jev compaction arms, emitted verbatim into their per-trial overlay
  tests/        node --test suites
  runs/         Output. runs/<experiment>/<arm>/{run.json, trials.jsonl, results.json}
```

## Prerequisites

Run `pnpm install` in the harness checkout. Real trials, composed preflight, confirmatory validation, replay labelling and replay metrics require `pnpm run build`, as do tests exercising those operations. `--dry-run`, plan printing and general statistical analysis do not require built package outputs. Confirmatory validation reports a missing build explicitly; it never substitutes provisional configuration.

## Use

```sh
node bench/demo/generate.js            # synthetic data into runs/demo/
node bench/report/build.js             # rebuild aggregates + ui/data.js
node bench/report/serve.js             # open the report at http://127.0.0.1:7474
node bench/analysis/model-ranking.js   # strength-per-cost ranking of every model pin over stored runs
node --test bench/tests/*.test.js        # unit tests
```

Real runs need an API key (or `--api-key-env none` for keyless tiers) and a built harness:

```sh
node bench/runner/run.js --experiment w0-2026-08-18 --arms off,on --repeats 3
node bench/runner/run.js --experiment w5-pressure --tasks 'constraint-survival-*,chain-ledger-deep' --arms off,on --repeats 1
node bench/runner/run.js --experiment w9-charter --arms off,on --repeats 31 --concurrency 4
```

`--concurrency <n>` (default `1`) runs up to n trials at once from the interleaved plan.

`--max-total-tokens <n>` sets an observed input-plus-output token limit per spawn, independently for each chain phase. The counter excludes separate cache-read and cache-write usage. The runner polls root and descendant session logs, terminates the harness child when the observed sum exceeds the limit, and records the process outcome on a single-session trial's `execution` field or each chain phase. Usage can overshoot between observations; this is not a hard request or spending limit. `BUDGET_EXCEEDED` remains the unresolved failure mode when the verifier does not resolve the task; a verifier pass does not erase the separate budget-stop fact. The cap is pinned in `run.json` (`maxTotalTokens`) so the pre-registration is checkable; `success(B)` curves at budgets below the cap remain post-hoc filtering over `tokensIncludingDescendants`. Each trial already owns a unique scratch dir (`runs/<experiment>/scratch/<arm>/<taskId>/<trialIndex>`) and session-log root (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>`), so concurrent workers do not collide. `trials.jsonl` may append out of completion order; the report pairs on `taskId+trialIndex`, not file order. `1` is sequential and is the historical runner. SIGINT/SIGTERM abort in-flight harness processes and leave every already-appended line intact (`run.json` `endedAt` stays empty).

`--max-dollars <usd>` caps the whole experiment in API-equivalent dollars from the price snapshot. Before each launch the runner adds settled spend to a projection of every in-flight trial and the new one at the largest settled trial's spend; once that would exceed the cap it launches nothing more, lets in-flight trials finish, prints why it stopped, records a `budgetStop` in every arm's `run.json`, and exits 3. Spend is the upper-bound dollars of [priced accounting](#priced-accounting); subscription and unpriced calls are outside it, and the run ends with a warning naming how many calls the cap could not count. `--price-snapshot <YYYY-MM-DD>` picks the snapshot; omission resolves to the newest file in `prices/`. `run.json` pins `maxDollars`, `priceSnapshot`, and `accountingConfigSha256`.

The routing measurement adds four isolation pins, all recorded in `run.json` and compared on `--resume`: `--arm-seed <n>` shuffles arm order per task from a seeded stream (provider caches cannot arm-order their inputs), `--nonce` appends a per-trial nonce line to every first user message so provider caches cannot carry across arms, and `--gap-seed <n>` / `--gap-cap-ms <ms>` govern the seeded idle gaps a multiturn task sleeps on between turns (`bench/runner/gaps.js`; the drawn value stays logged, the cap only clamps the realized wait). A routing arm's own base-route key (`ArmEntry.apiKeyEnv`) resolves like `--api-key-env` and is required: the strong route is the arm's core condition, and its value reaches only that arm's trial environment.

`--resume` continues an interrupted experiment instead of refusing its existing manifests: trials already recorded with a delivered verdict (`status: success` — resolved, verifier-failed, timeout, budget-exceeded) are skipped; interrupted `error` trials rerun with their stale session roots cleared rather than flagged. The invocation's pins (model, base URL, temperature, task ids, tier-patch sha256s, `maxTotalTokens`, `maxDollars`, API-key env, and the price snapshot and accounting-config hash when the manifest records them) must match the stored manifest exactly or the resume refuses loud — a changed condition is a new experiment name. A resumed `--max-dollars` run counts the spend of every trial already recorded. `gitCommit` is deliberately not pinned across a resume: tier-patch hashes pin the measured composition.

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

`bench/pressure/forced-compaction.patch.yml` patches the shipped `compaction-basic` entry so automatic compaction fires around 10k–20k conversation tokens on the 1M-window models this suite uses. A patch `config` key replaces the entry's whole config, so the file restates every field automatic compaction needs. The overlay is experiment-level and applies identically to every selected arm; it is not an arm contrast. Combining it with any arm that carries `stuffed: true` (the `stuffed` arm) is a protocol error: compaction would destroy the whole-corpus-in-the-prompt condition. The runner refuses that combination at argv validation. `read` and `code` may use the overlay. Because `listArms()` includes `stuffed`, a pressure run must pass `--arms` without `stuffed`.

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
6. Mid-task compaction is forced through the sanctioned `BasicCompactionConfig` fields (`thresholdRatio`, default `0.8`; fires at `floor(contextWindow × ratio)`), never a harness source patch. The repeatable `--tier-patch` overlay `bench/pressure/forced-compaction.patch.yml` is the experiment-level way to lower that threshold identically on every selected arm except `stuffed`, which the runner refuses in combination with that overlay.

## Chain tasks

A task with `phases` (at least 2) in task.json runs as a chain: one scratch dir whose workspace carries across phases, but a separate headless spawn per phase with a fresh per-phase session root (`runs/<experiment>/<arm>/sessions/<taskId>/<trialIndex>/phase-<i>`) — the session boundary is the experiment. The verifier runs once, after the final phase, against the carried workspace; a phase ending in PROVIDER_ERROR or HARNESS_ERROR aborts the chain and excludes the trial from the pass rate. Trial-level metrics are per-phase sums, with one exception: the Jev routing/compaction fields cannot be summed (a share and a route change are not additive), so a chain trial recomputes them by folding its phases' concatenated logs — a route change at a phase boundary counts as a real transition — and `downgradedStreaks` is the phases' run lists in phase order, deliberately never merging a run across a boundary, because each phase is its own session. Carry is **cold-only** today: `resumedFrom` stays null because the harness has no headless/SDK session resume or fork yet; card carry across sessions is a proposed uplift.

Every trial (chains and single-session) passes an arm-integrity audit: no session root of the trial may pre-exist; arms not expecting jspace (`off`, `sq-only`, `sq-driver`, `stuffed`, `read`, `code`) must contain zero `jspace/` events in their session logs; arms not expecting session-query (`off`, `on`, `stuffed`) must contain zero session-query `tool/call` events. The audit only checks absence, so an arm that permits jspace records no violation when a trial logs no jspace event — the expected outcome for an `on-adaptive` trial that finishes before step 10. Violations are recorded on `trial.integrity.violations`; the trial still counts and the experiment never aborts.

A task whose `task.json` names `setup` runs that command after the fixture copy and before the spawn, with argv `<scratch-dir> <session-log-root>`. `session-query-adoption` uses this to plant a prior-session JSONL into the trial persistence root (header `cwd` rewritten to the scratch dir so session-query workspace authority admits it). The trial locator skips `bench-prior-*` session ids so the planted log is never folded as the trial transcript. Adoption (whether session-query ran) is `metrics.sessionQueryCalls`; the verifier scores only whether the shipped workspace used the recorded fact.

The adoption experiment is `--arms sq-only,sq-driver --tasks session-query-adoption`.

`compaction-pointer-follow` measures pointer dereference: run it with `bench/pressure/forced-compaction.patch.yml` plus a patch setting `compaction-basic` `maxPointers` above the overlay's pinned `0` so summaries carry seq pointers.

## OOLONG-lite (WP3.3)

Long-stratum aggregation over a seeded 400-row JSONL corpus (`{ id, name, value, category }`). Names and ids are synthetic so they are not recallable words. Same seed (`task.json` `seed`, `mulberry32`) rewrites identical names, ids, values, and `expectedAnswers`. Regeneration is `node bench/tasks/oolong-aggregate/generate.mjs`; trials copy the committed fixtures and do not regenerate. The generator, seed contract, and the three task directories are documented in [`tasks/oolong-aggregate/README.md`](tasks/oolong-aggregate/README.md).

| taskId | Stratum | What it asks |
|---|---|---|
| `oolong-aggregate` | long | Four exact integers: count(category C ∧ value > N), sum(value \| category D), distinct names, count(value ∈ [X, Y]). |
| `oolong-pairs` | long | Exact 3×3 count matrix of (value-range bucket × category) over three planted buckets and three planted category columns. |
| `oolong-aggregate-cued` | long | Byte-identical corpus and questions to `oolong-aggregate`; the instruction's final line names the capability at the moment of need, adapted per arm (`armInstructions`). |

Pilot arms: `--arms stuffed,read,code --tasks 'oolong-*'`. Pre-registered contrasts:

- `code` vs `read` is the **kernel-necessity** contrast (does mounted stateless `run_code` already get the programmatic-over-corpus step, or is a persistent kernel required?).
- `read` vs `stuffed` is the **retrieval** contrast (session-query over an on-disk corpus vs the whole corpus inlined in the prompt).
- The cued family makes a tie interpretable: "didn't help" vs "never reached" (the cue names `session_search` on `read` and `run_code` on `code`).

The stuffed arm inlines the corpus through `task.json` `stuffedInstruction` (the runner selects it when the arm carries `stuffed: true`). The verifier reads `answers.json` from the scratch dir and exact-matches integers against `expectedAnswers` in `task.json`, which the agent cannot see.

## Researcher ladder (WP-research)

Three arms measure the research-protocol experiment surface (`research-inert`,
`research-lite`, `research-on`). Each mounts the same surface — research-protocol,
tracker-shrestech (spool-only, per-trial spool/index redirect into the trial's
persistence dir), tool-tracker, ledger (per-trial store), tool-ledger, and the
aegis/ward/stride tool-subagent seats (fork one-shot / spawn continuable,
mirroring the base headless rows). The ladder differs in the protocol gate and
jspace posture; pre-registration lives in
[`researcher-preregistration.md`](researcher-preregistration.md).

Two arm-neutral microcycle tasks (`research-microcycle-accept`,
`research-microcycle-reject`) ask the agent to test a hypothesis against a small
numeric `data.json`, support the verdict with a measurement, and record it in a
plain `verdict.json`. The verifier recomputes the truth from the pinned dataset
(SHA-256) and scores verdict correctness plus the recorded measurement — any
arm's trial that writes a correct verdict is gradable. The reject task frames
the dataset as high-value to tempt an unsupported accept.

Per-trial integrity metrics are log-derived (grep the session JSONL for event
names and result text): `gateRefusals`, `debateCalls` (completed aegis+ward
pairs per Goal epoch), `runsLogged` (landed posts; zero under spool-only),
`verifySatisfiedRate`, `unverifiedRunRefusals`, `ledgerDecisions`,
`deferredShare`, `ledgerAbandoned`, `unverifiedAcceptRecovery`, and `thinDebates`
(debate pairs under the 200-token seat floor). These are null for non-researcher
arms.

## Jev ladder (WP-jev)

The separate [generation-model pilot](routing/generation-model-pilot-2026-09-23-v3.md) collects verifier-backed outcomes for two generation models under the same direct harness arm. Its two-trial readiness command is separate from the larger pilot; these outcomes can supervise routing, while judgment-model answers cannot supply gold labels.

The Jev experiment prices judgment-backed routing and compaction against one pinned manual route and one forced-compaction posture. Four preregistered arms — two paired contrasts — all use the shipped headless composition, which mounts neither the judgment engine, nor the model router, nor a compaction provider of its own. The decision rules are fixed in [`jev-preregistration.md`](jev-preregistration.md); the preregistered arms below are the composition those rules measure.

| Arm | Judgment engine | Router | Compaction | Notes |
|---|---|---|---|---|
| `route-off` | absent | absent | shipped default | Routing control, pinned in `routing/route-off.patch.yml`. Both routing arms patch `agent-default-model` to the strong route (`deepseek-official / deepseek-v4-pro`), so the pair starts from one route and a downgrade is the only routable transition. |
| `route-on` | `judgment-typesafe` behind `judgment-dispatch` (`tier: 'fast'`) | `model-router`, `initialMode: 'on'` | shipped default | Pinned in `routing/route-on.patch.yml`. One allowlisted candidate (`deepseek-official / deepseek-v4-flash`, the weak route of the same adapter, so the credential and endpoint the arm already runs on serve it), `downgradeThreshold: 0.8`, `downgradeMargin: 0.1`, `routeFrom: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', objective: 'dollars' }]`, `hold: { minSteps: 20, maxSteps: 40 }`, `difficulty: { entryScoreCeiling: 2 }`, `reentryCooldownTurns: 2`, `escalateBack: { scoreThreshold: 4 }`, `maxRouteErrors: 2`, `onUnavailable: 'fallback'`, `judgmentDeadlineMs: 1500`, `judgmentFailures: { holdTolerance: 2, breakerThreshold: 3, breakerOpenTurns: 5 }`. |
| `route-shield` | `judgment-shield` behind `judgment-dispatch` (`tier: 'fast'`) | `model-router`, `initialMode: 'on'` | shipped default | Explicit opt-in comparison arm, pinned in `routing/route-shield.patch.yml`. It uses the loopback Shield gateway at `127.0.0.1:8765`, pins the Convai Laya reference artifact for both judgment tiers, and requires no `TYPESAFE_API_KEY`; the gateway must be running before a real trial. |
| `compact-basic` | absent | absent | `compaction-basic` | Compaction control, pinned in `pressure/forced-compaction.patch.yml`: the forced-compaction posture (`auto: true`, `thresholdRatio: 0.015`, `retainRatio: 0.003`, `maxTokens: 8192`, the retry budget, `maxPointers: 0`). |
| `compact-jev` | `judgment-typesafe` behind `judgment-dispatch` (`tier: 'accurate'`) | absent | `compaction-jev` | Pinned in `compaction/jev.patch.yml`: the same posture restated as one whole `compaction-jev` config, plus the three-hazard verification battery (constraints, errors, paths). |

Each arm's treatment rows are pinned in a committed overlay — `bench/routing/route-off.patch.yml`, `bench/routing/route-on.patch.yml`, `bench/routing/route-shield.patch.yml`, `bench/pressure/forced-compaction.patch.yml` (the `compact-basic` arm's pin and the posture's one home), `bench/compaction/jev.patch.yml` — which `runner/arms.js` emits verbatim into the arm's per-trial `--patch` overlay, so the pinned posture and the applied composition have one source and cannot drift. The pinned files are path-free and timestamp-free: the renderer adds the per-trial session root beside them.

The judgment dispatcher, the judgment engine, the router, and the Jev backend are **inserted, never patched**, and each dispatcher row's `defaultEngine` names the one engine its arm composes: the base composition mounts none of them, and a patch against a missing entry no-ops silently, which would leave the arm measuring its own baseline — the lesson the researcher overlay records. Both routing overlays pin `agent-default-model` and restate `provider` and `model` together, because a `config` patch replaces the entry's whole config. Both compaction arms restate the whole inherited policy the forced-compaction overlay names — the profile default never fires on the catalog's turn counts — so anything the pair does not share would confound the contrast, and `retainRatio` must stay below `thresholdRatio` or the plugin refuses to load. `compact-jev` disables the `compaction-basic` row before inserting the Jev backend because the two register the same compaction service key. `route-on` and `compact-jev` resolve `TYPESAFE_API_KEY` through the credential seam; `route-shield` uses its loopback gateway and has no judgment credential reference. The frozen four-arm command and verdicts remain the preregistration; the default arm list excludes `route-shield`, so select it explicitly for a provider comparison.

```sh
node bench/runner/run.js --arms route-off,route-on,compact-basic,compact-jev
```

### Verdicts

`report/build.js` grades the four rules the pre-registration freezes: `report.verdicts` carries one record per hypothesis — `id`, `rule` (the frozen wording), `arms`, `status`, `outcome`, `reason`, `observed`, `threshold`, `ci95`, `trials`, and the supporting `facts` — and each arm's `results.json` carries the verdicts that read that arm, so a per-arm file shows its own screens.

| Verdict | Rule | Arms | Estimator and interval |
|---|---|---|---|
| `H2` | mean `tokensIncludingDescendants` on `route-on` trials with ≥1 downgraded decision is ≥15% below the paired `route-off` trial's | `route-off`, `route-on` | mean paired relative delta, bootstrap over the paired deltas; gated by `H3` |
| `H3` | ≥2/3 of `route-on` trials log ≥1 `model-routing/decision` | `route-on` | share of the arm's trials that logged a decision, Wilson interval |
| `H4` | `cacheHitShare(route-on) ≥ cacheHitShare(route-off) − 5 points`, applied only when ≥80% of trials in both arms carry a reported cache-read count | `route-off`, `route-on` | difference of the arms' mean per-trial shares, paired bootstrap over matched share deltas |
| `H5` | on `pressureFired` trials the verifier-passed rate under `compact-jev` is ≥+10 points over `compact-basic` with the interval excluding zero, and tokens stay within 1.2× of the basic arm | `compact-basic`, `compact-jev` | paired pass-rate delta with its paired bootstrap interval (McNemar p rides along as a diagnostic), paired token ratio against the 1.2× ceiling; gated by `H6` |
| `H6` | ≥2/3 of `compact-jev` trials that compact at all log ≥1 `compaction/verification` | `compact-jev` | share of the arm's compacting trials that logged a verification, Wilson interval |

Three rules make a verdict honest, and the report schema enforces them at build time: the status is `evaluable` or `not-evaluable`; a missing datum, an empty subset, or fewer than two matched pairs is `not-evaluable` **with its reason** and carries no outcome, no interval, and no threshold at all — never a pass, and never a fail by default; and an evaluated verdict carries its outcome, its interval, and its trial count. One matched pair reproduces itself under every bootstrap resample, so it has no interval to report and does not evaluate a paired rule; the pre-registration states no minimum sample, so that guard is the suite's own reading of protocol rule 3 rather than a threshold of the frozen file. A screen that fails makes the hypothesis it gates not-evaluable rather than confirmed, exactly as the pre-registration states: a failed `H3` leaves `H2` not-evaluable, and a failed `H6` leaves `H5` not-evaluable. Every experiment gets all five records, so an experiment that ran none of these arms reports five not-evaluable verdicts — as the demo report does — instead of no claim.

The task list, repeats, and tier flags come from the suite's normal argv surface; `--dry-run` on the same command renders each selected overlay and builds the execution plan, but writes nothing, loads no arm, and executes no arm, so it is not evidence about any hypothesis. Routing is priced on `route-on` trials that log at least one downgraded decision, compaction on `pressureFired` trials, and the churn screen on trials that carry a root cache-hit share (at least one root usage record with a reported cache-read count) — so the per-arm aggregates carry each screen's trial count (`routingDecisionTrials`, `compactionVerificationTrials`, `cacheHitShareNullTrials`) beside the means. Every Jev metric is null, never zero, where its surface is absent: a `route-off` trial logs no routing decision at all (routing off is off), and a `compact-basic` trial records no Jev compaction event.

## Forensics metrics

Per-trial metrics beyond pass/fail, computed from the session JSONL:

| Field | Type | Description |
|---|---|---|
| `tokensIncludingDescendants` | `number \| null` | Input+output tokens summed over the root session and its descendant closure, keyed by header `parentSession` links under the trial's session-log root (seeded `bench-prior-*` fixtures excluded). The numerator matches `inputTokens`/`outputTokens` (`assistant/message` provider-reported usage only), so root and tree numbers stay comparable. Null only when the root header cannot be read. |
| `descendantSessions` | `number` | Count of descendant sessions in that closure (excludes the root; includes descendants whose logs carry no usage events). |
| `costIncludingDescendants` | `number \| null` | Exact API-equivalent dollars over the same closure from the trial's `accounting`: priced model calls plus priced judge usage, subscription routes excluded. Null when any such call is unpriced or lacks a reported cache-read count, and on trials recorded before the bench priced trials. |
| `outOfLoopExperiments` | `number` | Process metric: `run_code` tool calls over the whole trial tree plus one per descendant session with header `origin: 'subagent'` (each spawned delegation is one delegated experiment). Zero for arms mounting neither code-mode nor delegation. Recompute over stored runs with `node bench/analysis/out-of-loop.js`; the w4–w9 baseline table is committed at `analysis/out-of-loop-stored-runs.json` (all zeros — no stored arm mounted an out-of-loop surface). |
| `danglingCard` | `boolean \| null` | Card open at session end; null for jspace-off arms. |
| `verifiedCheckpointShare` | `number \| null` | Fraction of checkpoint tool results carrying `verified: true`; null when no checkpoints exist. |
| `coverageRefusalThenPad` | `number` | Count of checkpoint-refusal → immediate retry-success sequences within the same turn. |
| `noopNoteRefusals` | `number` | Count of `JSPACE_NOTE_NOOP` tool results. |
| `noteCapRefusals` | `number` | Count of note-cap denial tool results. |
| `sessionQueryCalls` | `number \| null` | Count of session_search/session_event_search/session_event_read/session_event_trace/session_trace calls; null for arms excluding the session-query consumer. |
| `compactionCount` | `number` | Count of `compaction/end` events (one closed compaction attempt). |
| `pressureFired` | `boolean` | `compactionCount > 0`. A long-horizon verdict only counts on trials where this is true. |
| `charterRunFailNamed` | `boolean \| null` | A `jspace/charter-run` with phase `checkpoint` or `ship` and `passed: false` (the refusal names `entryId`); null for jspace-off. Probe-phase runs do not count. |
| `emptyCharterRate` | `number \| null` | 1 when the last `jspace/card` charter is empty or no card opened; 0 when the last card carries at least one entry; null for jspace-off. |
| `unverifiedShare` | `number \| null` | Last-card `kind: 'check'` entries with `discrimination: 'unverified'`, divided by registered checks; null when no checks. |
| `echoOkRejectRate` | `number \| null` | Floor registration refusals (`JSPACE_CHARTER_CONSTANT` / `JSPACE_CHARTER_NO_READ`, or their model-visible copy) over `jspace_open` / `jspace_charter_amend` results; null when no registration attempt. The amend event is `jspace/charter-amend`. |
| `cacheHitShare` | `number \| null` | Root session only. Cache reads over the prompt tokens (input plus cache reads and writes) of the root session's `assistant/message` usage records that report a cache-read count; a record without one is unreported by the `TokenUsage` presence contract and excluded, never read as a miss. Null when no record reports a cache-read count or the reported prompt is zero; the churn screen's coverage counts only trials with a share. The closure-wide, per-call figure is `accounting.cacheHitShare` ([priced accounting](#priced-accounting)); both use the same arithmetic. |
| `cacheUnreportedShare` | `number \| null` | Root session only. The share of prompt tokens carried by usage records without a reported cache-read count, so `cacheHitShare` never hides unreported input; 0 when every record reported one, and null when the root session reported no prompt tokens. The closure-wide figure is `accounting.unreportedShare`. |
| `modelTransitions` | `number \| null` | Consecutive `request/header` pairs whose `config.provider` / `config.model` differ; null when the log carries no readable header, 0 for a single route. The harness logs a header on the first request and then only when the whole header differs (system prompt and tool set included), so a re-stated route is not a transition. |
| `downgradedStreaks` | `number[] \| null` | Run lengths of consecutive `model-routing/decision` events whose `outcome` is `downgraded`, in log order. An empty list is "judged, never downgraded"; null is "never judged". |
| `downgradedShare` | `number \| null` | Downgraded decisions over every decision; null when none was logged. |
| `keptStrongShare` | `number \| null` | `kept-strong` decisions over every decision; null when none was logged. `skipped` (mode off) and `error` decisions stay in the denominator and in neither numerator. |
| `routingHintCount` | `number \| null` | Decisions carrying the advisory `hint` the router logs while the manual route stands (`consider-stronger`); null when none was logged. |
| `jevCompactionAcceptedBelowThreshold` | `number \| null` | `compaction/verification` events whose `verdict` is `accepted-below-threshold` (the draft kept after a failed battery with no escalation left); null when the log carries no verification event, which is every backend other than compaction-jev. |
| `jevSelectionDegraded` | `number \| null` | `compaction/selection` events with `degraded: true`; null when the log carries no selection event. |

Aggregates flow through `report/build.js` into `ui/data.js`. The demo generator writes every field; the surfaces no demo arm mounts (researcher, and the Jev router and compaction backend) stay null there rather than carrying synthesized values.

## Priced accounting

Every trial records `priceSnapshot`, the `prices/` snapshot id, and `accounting`, folded over the root session and its descendants by `runner/accounting.js` (fields in its `TrialAccounting` typedef); a chain trial sums its phases. Dollars are API-equivalent list prices from a dated research snapshot, never billing truth: the runtime has no price table, and tokens stay its only cost currency ([Agent Note](../.agents/notes/implemented/process/2026-09-24-bench-priced-accounting.md)). Report dollars across vendors, never token-count equality: tokenizers differ.

**Calls.** A billed call is a `usage` chunk, so a failed attempt that reported usage counts; a step's `assistant/message` adds a call only when the step logged no usage chunk. A call's route is the message's model source, else the newest `request/context`, and its request time is the step's `step/start`. `inputTokens`, `outputTokens`, and `tokensIncludingDescendants` keep their message-only numerator, so stored runs stay comparable.

**Cache counts by presence.** The bench restates the `TokenUsage` contract ([llm-streaming](../docs/subsystems/llm-streaming.md#tokenusage)) instead of importing it: a present `cacheReadTokens` or `cacheWriteTokens`, including 0, is a reported count; an absent one is unreported, and `inputTokens` may then include cached input. A call without a reported cache-read count is an unreported call, as a whole: it stays out of `cacheHitShare`, its prompt (input plus any write it reports) lands in `tokens.unreportedInput` and `unreportedShare`, and its dollars appear only in `dollarsUpperBound`, which prices its whole input at the uncached input rate. The two scopes are named: `metrics.*` fields fold the root session only, and `accounting.*` covers the whole closure per billed call; each scope's cache-hit share sits beside its unreported share, so no report renders unreported input as a measured 0. pi-ai logs written before routes declared cache reporting encode a reported zero as absent, so their misses read as unreported.

**Prices.** `accounting.json` maps each harness route id to a snapshot provider (`priceProviders`), and a call prices under that provider and its model id. An unlisted route, a model the snapshot lacks, or a model with a null input or output price is unpriced: counted in `unpricedCalls`, named in `unpricedModels`, and never priced at $0. A null cache price means the provider publishes no separate rate, so that class bills at the input rate. Writes bill at the 5-minute tier because logged usage carries no write TTL. A call bills at the off-peak prices when its request time falls in one of the entry's `offPeakWindowsUtc` windows (half-open, UTC, possibly spanning midnight); weekday and holiday qualifiers in `windowNotes` are not applied.

**Quota tokens.** A `subscriptionProviders` route bills a subscription or prepaid credit, so its calls count as `quotaTokens` and never as dollars: tokens weighted input-equivalent by the model's class prices relative to its input price. A subscription call whose model has no price adds its raw tokens to `quotaUnpricedTokens`. For cross-arm comparison, `apiEquivalentDollars` prices every priced call with a reported cache-read count, subscription routes included, at API list rates, and `apiEquivalentDollarsUpperBound` adds the unreported calls at the uncached input rate; neither is spend, so `dollars`, `costIncludingDescendants`, and `--max-dollars` count API-billed routes only.

**Local routes.** `localProviders` routes and `localJudgeEngines` judges run on this machine at zero marginal cost (the committed config lists the loopback Laya and Shield judgment gateways; Laya answers over the Shield wire). Their calls count in `localCalls` and `judge.localCalls` at $0 and never as unpriced, quota, or spend; their tokens still count by class and in the cache-hit share. Both lists are explicit, and a route or engine belongs to at most one billing list: the loader refuses a route in both `subscriptionProviders` and `localProviders`, a local route with a `priceProviders` entry, and a judge engine in two of `localJudgeEngines`, `vendorPlanJudgeEngines`, and `judgeEnginePriceProviders`.

**Judgments.** `model-routing/decision`, `model-routing/child-decision`, and `model-routing/shadow-decision` fold into `judge` when a log carries them. A record with a `latencyMs` or an `engine` is a judgment call, counted by kind and by `engine/model`, with summed and sampled latency. A failed call carries the router's wall-clock `latencyMs` and the `engineId` it was routed to but no answering `engine`, so it is attributed to its `engineId`. `criticalPathMs` sums `latencyMs` plus `eligibilityMs` over awaited consults: a record's `awaited` field decides, and without one a shadow decision is off the critical path and every other kind is on it. `vendorPlanJudgeEngines` (TypeSafe) are counted and never priced; an LLM judge's own `judgeUsage` (a record written before the field existed carries `usage`) prices through `judgeEnginePriceProviders`.

**TTFT.** Per step, the time of the first token-bearing `assistant/chunk` (packed chunk rows included) minus the step's `step/start`; samples cover every session in the closure.

## Report

`node bench/report/build.js [--experiment <name>|latest]` rebuilds per-arm `results.json` and `bench/ui/data.js` from `trials.jsonl`. `latest` (the default) picks the `runs/` directory with the newest modification time.

The payload's `comparisons` array holds one `off` vs treatment record for every non-baseline arm present in the experiment (`off` vs `on`, `off` vs `on-adaptive`, and so on). Each record carries the McNemar grade, accuracy delta, and per-task paired rows; there is no singular `comparison` field. Arm summaries include forensics and compaction aggregates (`meanDanglingCard`, `meanVerifiedCheckpointShare`, `meanSessionQueryCalls`, `totalNoopNoteRefusals`, `totalCompactionCount`, `pressureFiredRate`, `meanCharterRunFailNamed`, `meanEmptyCharterRate`, `meanUnverifiedShare`, `meanEchoOkRejectRate`), the Jev routing/compaction aggregates (`meanCacheHitShare`, `cacheHitShareNullTrials`, `meanCacheUnreportedShare`, `meanModelTransitions`, `routingDecisionTrials`, `meanDowngradedShare`, `meanKeptStrongShare`, `meanDowngradedStreakLongest`, `totalDowngradedRuns`, `totalRoutingHintCount`, `compactionVerificationTrials`, `totalJevCompactionAcceptedBelowThreshold`, `totalJevSelectionDegraded`), mirrored on the per-task cells, and `accounting`: the [priced accounting](#priced-accounting) pooled over the arm's success trials, with pooled cache-hit and unreported shares, TTFT p50/p90, and judge-latency p50/p90, or null when no trial carries accounting. Every Jev mean is null when no trial in the group recorded that datum, and every total is null when no trial recorded the event family it counts, so a report distinguishes a measured zero from a never-measured surface; `cacheHitShareNullTrials`, `routingDecisionTrials`, and `compactionVerificationTrials` are the count each pre-registered screen reads (churn, routing adoption, verification adoption). The `pressure` stratum is a first-class catalog value alongside `long`, `short`, `adversarial`, and `chain`.

The payload also carries `verdicts`: the pre-registered Jev verdict block described under the Jev ladder, graded from the same embedded trials.

Serve the static report with `node bench/report/serve.js`. The UI contract lives in `bench/ui/CONTRACT.md`.

### Model ranking

`node bench/analysis/model-ranking.js [--experiment <substring>]... [--arm <name>]... [--runs-dir <path>] [--json]` ranks the roster — every distinct `run.json` `model` pin across the stored experiments — by strength per realized cost, reading only the recorded `run.json` and `trials.jsonl` artifacts. Strength is the frozen arm pass rate: verifier-passed success-status trials over success-status trials, `status: error` excluded, the same `accuracy` every arm summary carries. Cost is realized usage: the `assistant/message` provider-reported `inputTokens + outputTokens` the runner folded into each trial record, summed over the same trials; no price table and no per-model rate ratio enter the computation, so tokens stay the only cost currency. The rank key is `strength / meanRealizedTokens` (pass rate per realized token per trial), which does not depend on how many trials a model recorded; the table prints it per million tokens. A model that recorded one arm reports that arm's pass rate; a model that recorded several arms pools their gradable trials and lists each arm run's own frozen pass rate and realized tokens under the row, so `--arm off` is how a ranking on one frozen arm is read. A model with no gradable trial or no realized usage is unranked (`rank: null`) and sorts after the ranked rows. Arm directories without `run.json` contribute nothing; an invalid manifest or trial record fails the command, and `--runs-dir` points it at an archived runs tree.

## Routing measurement replay (prereg-2026-10)

The offline judge replay of [`routing/prereg-2026-10.md`](routing/prereg-2026-10.md) evaluates the local judge before confirmatory spend. Keyless modules validate the explicit method, label recorded trajectories, compute metrics, read registration phases and write calibration artifacts; none of those operations calls a model.

[`analysis/replay-metrics.js`](analysis/replay-metrics.js) consumes one row per cold-point entry consult, identified by task, arm, required `trialIndex` and trial-local `coldPointId`, carrying the router’s eligibility, winner, confidence, top1-minus-top2 margin, `pCheap` = 1 − P(keep-current), difficulty, token fit and explicit label. A row routes only when it is eligible and answered, its difficulty is below the fixed ceiling, its winner is a pool candidate, and confidence and margin meet the searched thresholds. **Coverage** divides by all cold rows; **entryRate** divides by eligible rows and supplies arm N’s matched rate; false-downgrade divides insufficient labels by routed rows. AUROC and equal-width ECE use answered rows. Unknown labels never disappear from these denominators: answered unknowns refuse AUROC/ECE, routed unknowns refuse false-downgrade, and any unknown point refuses the whole threshold search. Label-free counts, rates and token diagnostics remain available. An unevaluable gate reports `status: "method-unpinned"` and `passed: null`, not a failed calibration.

[`routing/replay-method.js`](routing/replay-method.js) validates `registration.method` without defaults: the fixed row-semantics version, ECE bins, ordered tie-break, arm label sources, trigger table and identifier, final-window policy, cold-point basis and C request configuration. Canonical JSON hashing binds rows and metrics to those exact fields. Only the owner amends the method; the writer requires a complete matching method and an evaluated gate before writing any file. Replay-failed and replay-qualified registrations require complete methods; draft and provisional registrations may omit them. The committed registration is a draft until the owner selects the method and budget.

[The hosted frontend](routing/replay-frontend-host.js) exposes `hostReplayTrial` and `hostReplayRun` as JavaScript APIs. The run API takes explicit trial descriptors, task strata and one owner method; it returns prepared rows, per-trial consult inputs and summaries. Each trial replays inside a real launcher composition using its live LLM runtime and persistence service. Consults use the recorded `step/start` time, not the replay job’s clock. Rows receive the supplied task, stratum and trial index, with eligibility taken from the matching consult. They remain unanswered with null score fields; a later judge stage must supply measured answers before calibration. This module neither selects trials from a run manifest nor provides a calibration CLI. [`routing/replay-run-reader.js`](routing/replay-run-reader.js) is the one reader from a recorded run directory to those descriptors: it locates the S and C arms by the registration's runner names, includes every recorded trial regardless of status, decodes each trial's own route from its session log, refuses chain trials, and returns the hostable trials together with named class-C records for unusable session inputs and the full set of discovered trial identities, so the host can account for every trial and refuse the whole run instead of returning a partial one. An S trial additionally compares each logged request header’s effective config to one `prepareCall` of the unprepared current selection, computed once before consults; C trials do not make that call.

The frontend compares physically decoded storage records with the persistence reader, checks source-file bytes and file membership, and does not repair logs. Complete logs replay normally; an intact open final turn retains its diagnostic rows and counts. Corrupt, torn or otherwise incomplete input refuses a trial. The run API attempts every trial before reporting all such refusals together and returns no accepted rows if any trial refuses; unrelated execution errors stop immediately. Historical timestamps, route metadata and request preparation are checked without model requests.

[The labeller](routing/label-cold-points.js) takes decoded trial events and caller-supplied cold points with stable `turn:<turn>/step:<step>` identifiers. It evaluates progress signals at each prefix in a half-open window, preserving earlier run state but requiring new trigger evidence inside that window. A later success cannot erase a transient burst. Arm C composes no escalation plugin; escalation-event presence is not a label. Unknown S labels and unresolved final windows remain explicit. [The fixture generator](routing/fixtures/generate-replay-fixture.mjs) executes three real headless CLI spawns against the loopback mock, including two real missing-file errors, then copies the unmodified log and records its [provenance](routing/fixtures/replay-c-label-windows.provenance.json). `--record` replaces the fixture; `--check` reruns the CLI and compares structure. Tests decode the artifact through the product JSONL backend. Real calibration requires the owner’s method decisions and measured judge answers; prepared inputs and keyless fixtures are not calibration data.

`routing/write-registration.js` is the replay's only calibration write, one-shot per registration. A draft registration is refused before the writer validates metrics or touches an output path. On a passed gate it rewrites the frozen registration atomically (temp file, then rename) with `replayGate: 'passed'` and the `enforced` block `run.js assertConfirmatoryRegistration` enforces — threshold, margin, `calibratedBy` (the registration id), `seed`, and `entryRate` = `realizedREntryRate` = the chosen point's eligible-row rate — and generates the confirmatory R and N overlays into an output directory, never over the committed provisional ones: R's operating point gains the calibrated id, N carries the enforced rate and seed and keeps its operating point uncalibrated (the replay calibrated R's gate quantities; N's seeded draw ignores its thresholds). On a failed gate it records `replayGate: 'failed'` with the full metrics, writes no `enforced` block and no calibrated id anywhere, and generates no overlays; the runner refuses the confirmatory arms on that registration. A registration past the provisional phase is never overwritten, and an unexpected provisional-overlay shape refuses generation rather than guessing. Confirmatory runs adopt the generated files through the runner's `--confirmatory-overlays <dir>`: the guard requires the replay-qualified phase and exact equality against the adopted files, the arm overlays render the adopted bodies in place of the committed provisional ones, and `run.json` pins the directory with each file's sha256 so a resume refuses a changed overlay source. The keyless preparation and calibration-module checks are:

```sh
node --test bench/tests/replay-frontend.test.js bench/tests/routing-replay-metrics.test.js bench/tests/routing-registration-writer.test.js bench/tests/routing-registration-phase.test.js
```

`routing/registration-phase.js` is the one reader of a registration's lifecycle phase, shared by the writer and the runner guard so no tool re-derives its own. A `status: "draft"` document is the owner-pending phase; it cannot carry `replayGate`, `enforced`, replay metrics or a calibrated id, and calibration and confirmatory consumers refuse it before any write or model execution. For a frozen registration, `replayGate` is the single authoritative calibration-phase flag: absent is `provisional` (placeholder points, nothing enforced), `'failed'` is `replay-failed` (the program stops and routing stays shadow-only), and `'passed'` is `replay-qualified` (the `enforced` block is complete and the confirmatory overlays may be generated). The static status `"preregistered"` means only that the preregistration is frozen; status never encodes calibration or approval, and no tool changes it. Whether the confirmatory run happened is recorded by run manifests and trial files, not here, and a passed gate authorizes confirmatory preparation only: real-spend runs require explicit owner approval, and default-on requires a confirmatory decision and owner approval (the registration's `authorizes` field states this for readers; no machine logic reads it).

## Composed-metadata preflight (routing arms)

Before key resolution, the runner boots the real launcher once per selected routing-measurement arm through [the metadata preflight](runner/preflight-models.js). S/C/R/N are supported; T is refused until its consumer composition is available. The preflight uses [the trial renderer](runner/arms.js), including adopted confirmatory R/N bodies, before adding an overlay that disables the one-shot runner and startup row and inserts [the metadata plugin](routing/preflight-plugin.mjs). Arm C remains always-cheap and refuses any worker-escalation row. The plugin awaits the loader, resolves conversation and candidate routes through the adapter registry, prints one JSON result and exits without a task or session.

[The source launcher](runner/execute.js) pins `TSX_TSCONFIG_PATH` to the repository tsconfig for every spawn, so scratch working directories retain workspace source resolution. Preflight uses an empty scratch cwd and home. Selected fixtures containing `cordis.yml`, `cordis.patch.yml`, `.shres`, `.agents` or `AGENTS.md` are refused because the empty cwd does not represent that launcher context. Every configured adapter endpoint points to a loopback sink whose request count must remain zero; any session log also refuses the result. The tests require installed workspace links and `pnpm run build` outputs.
### Calibration replay

[`routing/calibrate.js`](routing/calibrate.js) reads every recorded S/C trial, prepares and judges eligible consults in the launcher composition, and publishes labelled scores, consults, ask outcomes, metrics and a hash manifest. It refuses a draft before any replay child starts, then requires built host artifacts and a complete owner method. Real judging and trial collection require the separate owner approvals; keyless fixtures do not provide measurement evidence.

```sh
node bench/routing/calibrate.js --experiment-dir <run-dir> --registration <file> --task-root <tasks-dir> --out <new-dir>
```

Judging uses the R composition unless `--judge-fixture <module>`, `--judge-fixture-config <json-file>` and `--judge-fixture-engine <id>` explicitly select a keyless fixture; `--judge-fixture-disabled` is restricted to that fixture mode. Fixture outputs are test evidence, not real calibration. `--extra-overlay <file>` supplies an explicit composition overlay. `--write-registration` additionally requires `--seed <integer>` and `--overlays-out <new-dir>`; no seed is inferred. Existing output paths are refused. Evidence files are staged in a private sibling directory and published together; a corrupt-input trial leaves no published output. Registration finalization runs last through the one-shot writer.

Exit codes are `0` for completed evidence, `2` for input or method refusal, `3` for the combined corrupt-trial refusal, and `4` for a registration validation refusal after evidence publication. Exit `4` keeps the complete output directory. Unexpected execution or I/O failures exit `1` and must be investigated separately.

Answered S rows retain unknown labels under the supported S label source, so they prevent evaluation of the label-dependent replay gate. The driver neither drops those rows nor assigns labels. A valid output directory can therefore contain an unevaluated gate, and `--write-registration` refuses it. An all-unanswered run can evaluate a failed gate, but it cannot establish routing quality.

## Known limitations and deferred work

- **The arm-integrity audit is one-directional.** It checks presence where a surface is expected and absence where it is excluded (an arm that must not mount jspace logs no `jspace/` event, a routing arm logs a decision on every session that ran a turn). There is no inverse leakage check: an event type no arm expects, or a surface that reaches a session through the profile rather than the arm's overlay, is not audited, so a violation of that direction is invisible to `trial.integrity.violations`.
- **The UI headline table renders a fixed column set.** `bench/ui/views.js` lists its own columns, so the Jev routing/compaction aggregates and the verdict block reach `results.json`, `ui/data.js`, and the payload contract but not that table; a reader of the table alone sees none of them.
- **No real Jev trial has been run.** The pre-registration's own precondition applies: without a live `TYPESAFE_API_KEY` every judgment ask fails, routing resolves `kept-strong`, compaction-jev degrades to the byte-identical basic path, and both arms become their baseline. The fold and the verdict block are therefore verified against synthetic session logs and fixture runs, never against a real Jev spend.
- **H1 and H7 are not in the verdict block.** H1 (routing non-inferiority at −5 points) stays with `comparisons[].grade`'s McNemar path, which is `off`-baselined and implements no non-inferiority margin; H7 (any adversarial-stratum regression is an automatic NO-GO) is not computed at all. The per-task cells and the embedded `trials` carry the inputs for a later stratum-restricted test.
