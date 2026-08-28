# Researcher Bench — Pre-registration (WP-research)

This document fixes the researcher experiment before any real (non-dry) trial
runs. Every claim below is a decision rule stated before the data exists; a
changed decision rule is a new experiment name.

## Job definition

**The researcher owns the integrity of the experimental record — an accepted or
rejected verdict becomes durable only through a debate-gated run whose machine
rule re-executes to satisfied — and owns nothing else.**

That single sentence is the whole scope. The researcher does not optimize task
outcome, does not fix bugs, and does not own the hypothesis; it owns the
verdict's durability. A verdict is "durable" when and only when every cited run
carries a machine decision rule that `experiment_verify_decision_rule`
re-executes to `satisfied` at record time, and the verdict is recorded in the
ledger only after that check passes (`unverified-run` refusal otherwise). The
protocol gate holds the experiment tools (`experiment_log_run`,
`experiment_log_metrics`) until a completed aegis+ward debate exists in the
current Goal epoch. Anything the researcher does beyond that boundary is out of
scope and measured only as overhead.

## Arms

Three arms form a capability floor ladder, all mounted on the shipped headless
composition (which mounts `jspace` off and none of the researcher surface):

| Arm | Protocol gate | jspace | Surface |
|---|---|---|---|
| `research-inert` | `enabled: false` (mounted, inert) | off (base default) | tracker (spool-only) + ledger + tool-tracker + tool-ledger + aegis/ward/stride seats |
| `research-lite` | `enabled: true, requireDesignDefense: 'off'` | off | same surface, gate installed but not enforced |
| `research-on` | `enabled: true, requireDesignDefense: 'per-epoch'` | on, `verifierTools: ['bash','experiment_verify_decision_rule']`, `requireVerifiedEvidence: true` | same surface, gate enforced, verified evidence required |

The ladder isolates the gate's cost (inert → lite: surface mount + prompt
section), the enforcement cost (lite → on: per-epoch defense + verified
evidence), and the capability floor (inert alone never produces a durable
verdict). The tracker is spool-only in every arm (no credentialRef): runs never
post to a live tracker, so `runsLogged` measures landed posts (zero by design)
and every metric is a local-log observation.

## Tasks

| Stratum | Tasks | Repeats | Role |
|---|---|---|---|
| Microcycle | `research-microcycle-accept`, `research-microcycle-reject` | 31 | Primary. H true / H false-but-attractively-framed; verdict + measurement in a plain `verdict.json`. |
| Pressure core | `constraint-survival-fare`, `constraint-survival-migration`, `chain-ledger-deep`, `math-derivation-chain` | 15 | Long-horizon; the debate/ledger cycle must not break task execution. |
| Short pair | the two microcycle tasks | 10 | Lighter-repeat friction stratum for token-overhead and abandonment. |

The microcycle pair is arm-neutral: any arm's trial that writes a correct
verdict + measurement is gradable; the research arms additionally run the
debate → log run → verify → record cycle before landing the verdict.

## Hypotheses

- **H1 — Structural integrity.** The protocol never corrupts the record: every
  durable ledger decision cites a run whose machine rule re-executes to
  `satisfied`, and no accepted/rejected verdict is recorded without a completed
  debate. Zero tolerance: a single `unverifiedAcceptRecovery` or
  `unverified-run` refusal ending recorded on a fabricated rule is a harness bug
  (screen: ≥2/3 of trials on `research-on` that attempt a durable verdict; then
  confirm ≥80% pass, never promoted silently — see Stats).
- **H2 — Flash adoption.** ≥2/3 of `research-on` microcycle trials complete the
  full cycle: debate → log run → verify → record (≥1 `debateCalls`, ≥1
  `runsLogged`... i.e. ≥1 recorded `ledger/decision`). Adoption is the fraction
  of microcycle trials that reach a durable verdict.
- **H3 — Friction bound.** `research-on` pays ≤4× `tokensIncludingDescendants`
  versus `on-sq` on the short pair (the debate seats are the added cost). Above
  4× the gate is a wall, not a guardrail.
- **H4 — Capability floor.** The inert → lite → on ladder decomposes where the
  protocol fails: `inert` never durably records (gate off = no defense), `lite`
  records without defense, `on` records only verified. A net-negative flash
  result (H2 fails) is a capability-floor FINDING, not a dismissal — it says the
  surface is unusable, not that integrity is unwanted.

## Metrics

**OPTIMIZE** (drive decisions): task success, tokens-to-success
(`tokensIncludingDescendants` per resolved trial), abandonment (`ledgerAbandoned`
= zero ledger decisions on a research trial).

**DIAGNOSTIC-ONLY** (never a pass/fail gate, reported for context):
`gateRefusals`, `debateCalls`, `deferredShare`, `thinDebates`,
`unverifiedRunRefusals`, `verifySatisfiedRate`. Every count is log-derived
(greps the session JSONL for event names and result text), never a
model self-report.

**Gaming proxies** (flag trials that look honest but are not):
- minimal-debate sequences — a debate pair whose combined seat-token volume is
  under the `thinDebates` floor (200);
- seq-0-anchor share — the fraction of trials whose debate never advances past
  the session-start epoch (defense satisfied once, never per-epoch);
- deferredShare ceiling — pre-registered at **50%**. Above it, trials count as
  laundered, not honest: deferring every decision sidesteps the machine-rule
  check, so a 50%-deferred arm is not a working researcher.

## Statistics

- **Primary contrast:** `research-on` vs `research-lite` on the microcycle
  stratum.
- **Intervals:** Wilson/bootstrap intervals on every pass rate and delta;
  McNemar exact test with ties on the paired microcycle trials.
- **Minimum effect:** 15 points on the microcycle pass rate with a CI excluding
  zero. A smaller or CI-zero-crossing delta is null, not a result.
- **Token-overhead ceiling:** 4× `tokensIncludingDescendants` vs `on-sq` on the
  short pair.
- **Screen discipline:** H1 recovery is a directional screen and is never
  quietly promoted to confirm. Confirm (≥80%) is a separate, later gate run with
  its own pre-registered thresholds.
- **Net-negative flash:** if H2 fails on `research-on`, the finding is a
  capability floor (H4), not evidence against the integrity objective.

## Tier

Runs use `bench/tiers/ollama-deepseek.patch.yml` (DeepSeek-V4-Flash over the
base `ollama-cloud` route) with `--api-key-env OLLAMA_API_KEY`; the key resolves
from `$SHRES_HOME/.credentials.yaml` (default `~/.shres`) when not exported and
is injected into the child environment only, never into any bench record.
`run.json`'s `model` pin is load-bearing: the `:cloud` tag floats to Ollama's
current default, so the recorded model is what an experiment actually ran and a
changed resolution is a new experiment.

## Pre-registered command

```sh
node bench/runner/run.js \
  --experiment researcher-2026-08-27 \
  --arms research-inert,research-lite,research-on \
  --tasks 'research-microcycle-*,constraint-survival-fare,constraint-survival-migration,chain-ledger-deep,math-derivation-chain' \
  --repeats 31 \
  --api-key-env OLLAMA_API_KEY \
  --tier-patch bench/tiers/ollama-deepseek.patch.yml
```

(Dry-run smoke: `--arms research-on --tasks research-microcycle-accept
--repeats 1 --dry-run` renders the composed overlay and exits 0 without
spending budget.)
