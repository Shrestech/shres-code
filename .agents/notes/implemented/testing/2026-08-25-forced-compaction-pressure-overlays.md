# Agent Note: Forced-compaction pressure overlays and compaction metrics

Status: implemented

## Problem

The W0 catalog's tasks finish in 10–30 turns. On the 1M-token windows the suite actually uses (DeepSeek V4 Flash, Ollama Cloud `deepseek-v4-flash:cloud`), shipped compaction fires at `floor(contextWindow × 0.8)` — about 800k tokens — so a live pilot never reaches memory pressure. Long-horizon features (J-Space card, session-query) only show their value when tokens consumed approach context available; without that ratio the A/B cannot test the harness behavior it exists to measure. Lengthening every task would add catalog cost and still depend on the model writing enough tokens. `--tier-patch` already existed but accepted only one file, so a provider swap and a pressure overlay could not compose.

## Decision

`--tier-patch` is repeatable. The runner collects every occurrence in given order, applies each after the per-arm overlay via repeated `--patch` flags, and records `{ path, sha256 }` for each file in `run.json`'s `tierPatches` array (empty when unused). There is no `tierPatch` singleton; this is a pre-release format change with no compatibility shim.

`bench/pressure/forced-compaction.patch.yml` patches the shipped `compaction-basic` entry (base bundle, no config of its own). A patch `config` key replaces the whole entry config (`applyEntryPatches` in vendored include), so the file restates every field automatic compaction needs: `auto: true`, `thresholdRatio: 0.015`, `retainRatio: 0.003`, `maxTokens: 8192`, `compactionRetries: 1`, `maxOverflowRetries: 1`. `0.015 × 1_000_000 = 15_000` tokens, inside the 10k–20k band that 10–30-turn tasks can reach; `retainRatio` must stay below `thresholdRatio` or plugin load fails (the shipped default `0.16` cannot be left implicit). The overlay is experiment-level and identical on every arm — it is not an arm contrast.

Trial metrics fold `compaction/end` from the session log into `compactionCount` (one closed attempt, success or error). `compaction/start`, `compaction/summary`, and `compaction/prune` do not increment the count; unknown event types still fall through. `pressureFired` is `compactionCount > 0`. Chain trials sum `compactionCount` across phases and derive `pressureFired` from the total. A long-horizon verdict only counts on trials where `pressureFired` is true.

## Alternatives considered

**Longer tasks instead of a composition overlay.** Rejected: catalog cost and verifier work grow, and token volume still depends on the model. The pressure ratio is a config property of `compaction-basic`, so an overlay reuses the sanctioned tunable.

**A single `--tier-patch` plus a separate `--pressure-patch` flag.** Rejected: both are experiment-level `--patch` overlays applied after the arm overlay. Repeatable `--tier-patch` is one mechanism; a second flag would duplicate parsing, hashing, and `run.json` recording.

**Counting every `compaction/*` event.** Rejected: one successful cycle logs `start` + `summary` + `end` (and sometimes `prune`). `compaction/end` is the closed-attempt marker the engine always attempts, including failures that record `error`.

**Lowering `thresholdRatio` on one arm only.** Rejected: pressure must apply identically to every arm, or the A/B confounds the intervention with whether compaction fired.

## Consequences

Provider-tier and pressure overlays compose (`--tier-patch bench/tiers/zai.patch.yml --tier-patch bench/pressure/forced-compaction.patch.yml`). Existing `run.json` files that stored `tierPatch` are invalid against the current schema; a changed experiment name is required anyway when overlays change. On a 200k-token window the same ratio fires near 3k tokens — earlier than the 10k–20k target, still mid-task. Trials that never compact remain in the file; the interpretation rule excludes them from long-horizon claims rather than dropping them from the pass rate.

## Testing

`node --test bench/tests/*.test.js` covers repeatable `--tier-patch` parsing and `run.json` recording, structural asserts on the overlay YAML, a synthetic session-log fold of `compaction/end`, and schema accept/reject for the new metric and manifest fields.

## Related

- [Five-arm bench ladder and forensics metrics](2026-08-25-bench-arm-ladder-and-forensics-metrics.md) — owns the arm overlays, forensics fields, and the original `--tier-patch` / `apiKeyEnv` mechanism this extends.
- [J-Space W0 benchmark suite](2026-08-18-jspace-w0-benchmark-suite.md) — owns `bench/` as the measurement instrument.
