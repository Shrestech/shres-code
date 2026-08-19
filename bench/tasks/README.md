# Task authoring contract

One directory per task. The directory name is the `taskId` and never changes after results exist — it is the pairing key across arms.

```
bench/tasks/<taskId>/
  task.json      task definition (schema below)
  fixture/       files copied into a scratch dir for each trial
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
  "timeoutMs": 600000
}
```

- `stratum`: `long` (multi-file/multi-stage; the intervention should help), `short` (one-step; measures the tax), `adversarial` (prompt-injection fixture; measures persistence×authority), `chain` (multi-session; measures cross-session carry).
- `instruction` is the complete prompt. It must not name J-Space — the on arm's behavior difference must come from the mounted machinery, not from being told it exists.
- `verify.mjs` is plain ESM Node, no dependencies, deterministic, and idempotent. It reads the scratch dir, prints a one-line detail, exits 0 (resolved) or 1. It must not depend on agent output formatting, only on end state.
- The runner copies `fixture/` into a fresh `runs/<experiment>/scratch/<arm>/<taskId>/<trialIndex>/` per trial; the agent's cwd is that copy. Nothing outside the scratch dir may be touched by task or verifier.
- Keep tasks small (minutes, not hours) — every task runs `repeats × arms` times per experiment.

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
