# Jev Bench — Pre-registration (WP-jev)

This document fixes the Jev routing and compaction experiment before any real
(non-dry) trial runs. Every claim below is a decision rule stated before the
data exists; a changed decision rule is a new experiment name. The arms, the
tasks, and the command are frozen here; the metrics are implemented in
`bench/runner/metrics.js` and `bench/runner/accounting.js` and aggregated by
`bench/report/build.js`.

## Job definition

**The Jev experiment measures two claims — that judgment-backed routing spends
fewer billed tokens without losing task success, and that judgment-backed
compaction produces better summaries at comparable cost — and it measures
nothing else.** Routing is judged on paired route-on/route-off trials; the
compaction contrast is judged on paired compact-basic/compact-jev trials over
the forced-compaction posture. Adoption and degradation are screens on those
claims, never goals: a run in which the judgment engine is unreachable is not
evidence about the claim, and is reported as not-evaluable.

## Arms

Four arms, all mounted on the shipped headless composition (which mounts
neither the judgment engine, nor the router, nor a compaction provider of its
own):

| Arm | Judgment engine | Router | Compaction | Base |
|---|---|---|---|---|
| `route-off` | none | none | shipped default | strong route pinned by the tier patch |
| `route-on` | inserted (`judgment-typesafe`) | inserted, `initialMode: on` | shipped default | same tree; the weak route is the only candidate |
| `compact-basic` | none | none | `compaction-basic` with the forced-compaction posture | `bench/pressure/forced-compaction.patch.yml` |
| `compact-jev` | inserted (`judgment-typesafe`) | none | `compaction-jev` (basic row disabled), posture restated as one whole config | same posture, judgment-backed |

The router's config in `route-on` is frozen here: `tier: "fast"`,
`downgradeThreshold: 0.8`, `downgradeMargin: 0.1`,
`minTurnsDowngraded: 5`, `escalateBack: { scoreThreshold: 4 }`,
`maxRouteErrors: 2`, `onUnavailable: "fallback"`, and exactly one
candidate (the weak route). The judgment engine is the TypeSafe provider on its
`fast` tier (`jev-preview`, measured at 273 ms against 685 ms for
`accurate` on a 1.7k-token state), the tier both consumers use here.

## Tasks

| Stratum | Tasks | Repeats | Role |
|---|---|---|---|
| Primary | the existing long-horizon catalog under the forced-compaction posture | as pinned by the run | Both contrasts: route-on pairs against route-off on the same task and repeat; compact-jev pairs against compact-basic the same way. |
| Adversarial | the catalog's hardest stratum (the tasks the suite already marks adversarial) | as pinned by the run | Routing safety; any regression is automatic NO-GO. |
| Pressure | long-horizon tasks whose trials fire pressure compaction | as pinned by the run | Compaction adoption and the verifier-passed delta. |

Trials are interleaved across arms so a time trend cannot masquerade as an arm
effect, and every report pins the `run.json` that produced it.

## Hypotheses

- **H1 — Routing is non-inferior on success.** Task success under `route-on`
  is non-inferior to `route-off` at a **−5 point margin**, tested with
  McNemar on the paired trials and required to exclude −5 in its interval. A
  point estimate above the margin with an interval that includes it is null.
- **H2 — Routing spends fewer billed tokens where it acts.** On `route-on`
  trials with **≥1 downgraded decision**, mean `tokensIncludingDescendants`
  is at least **15% below** the paired `route-off` trial's. Billed tokens
  include the transition re-prefills by construction, so no estimator is added.
- **H3 — Adoption.** At least **2/3 of `route-on` trials log ≥1
  `model-routing/decision`**. Below that, the arm did not exercise the
  intervention and H2 is not-evaluable rather than confirmed.
- **H4 — The churn screen.** `cacheHitShare(route-on) ≥
  cacheHitShare(route-off) − 5 points`, applied **only when ≥80% of trials in
  both arms carry a reported cache-read count**. Otherwise this file declares it
  **NOT-EVALUABLE** — never silently skipped — and the economic case rests on
  H2's token delta alone.
- **H5 — Compaction improves the verifier-passed rate at comparable cost.** On
  `pressureFired` trials, the verifier-passed rate under `compact-jev`
  is at least **+10 points** over `compact-basic` with the interval
  excluding zero, and `tokensIncludingDescendants` stay within **1.2×** of
  the basic arm.
- **H6 — Verification adoption.** At least **2/3 of `compact-jev` trials
  that compact at all log ≥1 `compaction/verification`** event. Below that,
  H5 is not-evaluable.
- **H7 — The adversarial stratum is a hard floor.** **Any** regression on the
  adversarial stratum under `route-on` (a resolved-to-unresolved flip, or a
  success-rate drop whose interval excludes zero on the downside) is an
  **automatic NO-GO**, regardless of H2's magnitude.

## Why there is no non-sticky arm

The non-sticky design is not run, and the reason is arithmetic fixed before the
data: a downgraded turn saves ≈$0.075, while a transition costs a **250–624K
token re-prefill** at production context sizes — **54 full-miss requests equal
92% of uncached dollars**, so a policy that flips routes around the break-even
point loses the saving it was built for. The sticky horizon is the protection:
with **±0.06 judgment-score wobble** around the 0.8 gate, a non-sticky policy
flaps across the boundary and re-prefills on nearly every flip, which is
**sub-break-even flapping** by construction rather than a measurable effect.
`minTurnsDowngraded: 0` keeps the non-sticky design reachable in Config,
so the claim stays falsifiable: a future run may disable stickiness
deliberately and measure the flapping directly. It is not measured here because
it is expected to lose, and a losing arm still costs real spend.

## Metrics

**OPTIMIZE** (drive decisions): task success (paired, per arm) and
`tokensIncludingDescendants` per resolved trial. Compaction adds the
verifier-passed rate on `pressureFired` trials.

**DIAGNOSTIC-ONLY** (never a pass/fail gate): `cacheHitShare` (nullable),
`modelTransitions`, `downgradedStreaks`, `downgradedShare`,
`keptStrongShare`, `routingHintCount` (only if the router logs
hints), `jevCompactionAcceptedBelowThreshold`, `jevSelectionDegraded`,
and the existing compaction forensics.

Every metric is derived from the session log and the reported usage, never from
a model self-report. `cacheHitShare` is the trial's `accounting.cacheHitShare`:
cache reads over the prompt tokens of the calls whose provider reported a
cache-read count, over the root session and its descendants. A call with no
reported count is excluded rather than read as a miss, and the share is
**null** when no call reported one; the aggregate reports how many trials were
null, because H4 depends on that count.

## Statistics

- **Primary contrasts:** `route-on` vs `route-off` on task success
  (McNemar on paired trials, non-inferiority at −5 points) and on
  `tokensIncludingDescendants` (paired bootstrap over the trials with ≥1
  downgraded decision); `compact-jev` vs `compact-basic` on the
  verifier-passed rate of `pressureFired` trials (paired bootstrap,
  +10 points, interval excluding zero).
- **Intervals:** bootstrap over trials, plus Wilson intervals on every pass
  rate; McNemar exact with ties on paired binary outcomes.
- **Minimum effect:** the margins above. A smaller or zero-crossing delta is
  null, not a result.
- **Screens are never promoted silently:** a failed screen (H3, H6) makes its
  hypothesis not-evaluable, and a screen whose data is missing (H4, or null
  `cacheHitShare` on more than 20% of trials in either arm) is declared
  not-evaluable in the report as well as here.
- **Uncertainty is mandatory:** every reported number carries its interval and
  its trial count; a metric with no interval is not reported as a result.

## Tier

The judgment consumers run on the `fast` tier (`jev-preview`): a
routing decision has a per-turn latency budget, and the measured tier gap
(273 ms vs 685 ms on a 1.7k-token state) is the difference between a decision
inside the turn and a decision that delays it. `accurate` is reserved for
the compaction verification cascade, where a draft already costs a summarization
call and the extra latency is small relative to it. A future run may re-test the
tier choice as its own experiment; this file fixes the tiers used here.

## Preconditions the result depends on

- **A live `TYPESAFE_API_KEY`.** Without it every judgment ask fails:
  routing resolves `kept-strong` (the configured
  `onUnavailable: "fallback"`) and compaction-jev degrades to the
  byte-identical basic behavior, so both arms become the baseline and the run is
  **not evidence**. The key resolves through the harness's existing credential
  injection (`apiKeyEnv`) and its value never enters a bench record.
- **The key is exported in the parent environment or resolvable from the
  harness credential store.** The runner takes the exported value first and
  otherwise the stored one, injects it into the child environment alone, and
  never records it; each arm therefore mounts the judgment engine with the
  reference name only. A run whose key came from neither place is a run without
  a key: it degrades to `kept-strong` and the byte-identical basic behavior and
  is **not evidence**, whatever its transcripts show.
- **A servable weak route.** The candidate must be servable by the endpoint the
  arms configure. If it is not, H3 fails by construction and the run reports the
  failed adoption rather than a routing result.
- **Usage data on the trials.** H4 and the token delta both read reported usage;
  a provider that returns none leaves those metrics null and the corresponding
  hypotheses not-evaluable.

## Pre-registered command

    node bench/runner/run.js --arms route-off,route-on,compact-basic,compact-jev

The exact task list, repeats, and tier flags come from the suite's normal argv
surface; the arms are frozen above, and any deviation is a new experiment name.
A `--dry-run` invocation of the same command is the integrity check that
every overlay renders and every arm loads; it is not evidence about any
hypothesis.
