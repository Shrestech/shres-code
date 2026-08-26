# Task authoring contract (18 tasks)

One directory per task. The directory name is the `taskId` and never changes after results exist — it is the pairing key across arms.

```
bench/tasks/<taskId>/
  task.json      task definition (schema below)
  fixture/       files copied into a scratch dir for each trial
  setup.mjs      optional; `node setup.mjs <scratch-dir> <session-log-root>`
  verify.mjs     verifier: `node verify.mjs <scratch-dir>` exits 0 = resolved
```

## task.json

```json
{
  "taskId": "multi-file-rename",
  "stratum": "long",
  "description": "One line shown in the report.",
  "instruction": "The exact prompt handed to the agent.",
  "verify": "node verify.mjs",
  "timeoutMs": 600000,
  "maxTurns": 40
}
```

- `stratum`: `long` (multi-file/multi-stage; the intervention should help), `short` (one-step; measures the tax), `adversarial` (prompt-injection fixture; measures persistence×authority), `chain` (multi-session; measures cross-session carry), `pressure` (memory is load-bearing: global rules stated once must survive a long stretch of work, or cross-session externalization / in-session retrieval is required; a pressure task may be a `phases` chain or a single long session).
- `instruction` is the complete prompt. It must not name J-Space — the on arm's behavior difference must come from the mounted machinery, not from being told it exists. Session-query naming belongs on the `sq-driver` arm overlay, not in the task prompt.
- `setup` is optional. When present it is `node setup.mjs` (same argv convention as `verify`, plus the persistence root): the runner invokes it after copying `fixture/` and before the harness spawn. Use it to plant files the agent must not see in the workspace — a prior session log into `session-log-root` — never to leak the oracle into `scratch`.
- `verify.mjs` is plain ESM Node, no dependencies, deterministic, and idempotent. It reads the scratch dir, prints a one-line detail, exits 0 (resolved) or 1. It must not depend on agent output formatting, only on end state.
- The runner copies `fixture/` into a fresh `runs/<experiment>/scratch/<arm>/<taskId>/<trialIndex>/` per trial; the agent's cwd is that copy. Nothing outside the scratch dir may be touched by task or verifier.
- Keep tasks small (minutes, not hours) — every task runs `repeats × arms` times per experiment.

## Task catalog

| taskId | Stratum | Description |
|---|---|---|
| `multi-file-rename` | long | Multi-file project rename with import references. |
| `cross-module-refactor` | long | Move a function across modules with import updates. |
| `config-migration` | long | Migrate legacy config keys to new schema. |
| `chain-data-pipeline` | long | Multi-file pipeline where constants drive transformations. |
| `compaction-stress-constraints` | long | Constraint validation under compaction stress. |
| `single-function-fix` | short | Fix a loop bound in one function. |
| `typo-guard` | short | Correct a typo in source files. |
| `log-line-cleanup` | short | Remove debug log lines from source. |
| `injection-ignore` | adversarial | Prompt injection in fixture; verifier fails on forbidden side effect. |
| `doc-poison` | adversarial | Poisoned instruction in fixture docs; verifier fails on sentinel. |
| `chain-debug-resume` | chain | Phase 1 discovers a bug, phase 2 fixes the resume path. |
| `chain-lib-extend` | chain | Three-phase library extension: discover, implement, integrate. |
| `chain-env-propagate` | chain | Phase 1 discovers env vars, phase 2 validates propagation. |
| `chain-api-versioning` | chain | Phase 1 reviews API v1, phase 2 implements v2 endpoint. |
| `math-derivation-chain` | chain | Phase 1 derives formulas, phase 2 implements them. |
| `constraint-survival-build` | pressure | Build ten inventory modules while retaining six global constraints stated once. |
| `constraint-survival-migration` | pressure | Migrate ten numbered modules under five global rules stated once. |
| `chain-ledger-deep` | pressure | Six-phase cold-session ledger: persist analysis decisions, survive distractors, reconcile. |
| `noise-needle` | pressure | Record three values from 2000-line diagnostic noise, then repair a multi-file project. |
| `session-query-adoption` | pressure | Apply a fact that exists only in a pre-seeded prior session log. |

## Chain tasks

A task whose task.json carries `phases` (an array of at least 2) is a chain: the trial runs one headless session per phase, in order, against the same scratch dir.

```json
{
  "taskId": "chain-debug-resume",
  "stratum": "chain",
  "description": "One line shown in the report.",
  "phases": [
    { "instruction": "phase 1 prompt" },
    { "instruction": "phase 2 prompt", "timeoutMs": 300000 }
  ],
  "verify": "node verify.mjs",
  "timeoutMs": 600000
}
```

- Top-level `instruction` is forbidden when `phases` is present. Each phase's `instruction` is the complete prompt for that phase and must not name J-Space, same as a single-session prompt. `timeoutMs` stays required: it is the per-phase default each phase may override.
- The scratch workspace persists across phases; sessions do not. Each phase spawns with a fresh session root (cold carry — cross-session card carry is blocked on harness resume support), so a phase's prompt can rely only on the files earlier phases left behind, never on their conversations.
- The verifier runs once, after the final phase, against the carried workspace. A phase that ends in PROVIDER_ERROR or HARNESS_ERROR aborts the chain: the trial is excluded from the pass rate with the phases completed so far recorded on `trial.phases`.
