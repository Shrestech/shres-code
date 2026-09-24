# Agent Note: Bench priced, cache-inclusive accounting

Status: implemented

## Problem

A model-routing measurement compares arms that mix models with prices an order of magnitude apart, cached and uncached prompts, subscription routes, and routing judgments. The bench counted only `assistant/message` input and output tokens, so every one of those differences was invisible:

- Cache reads and writes were dropped. `TokenUsage` counts are disjoint, so a warm prompt looked smaller than a cold one of the same size.
- A token on a cheap model weighed the same as a token on a strong one.
- Failed attempts that the provider billed were not counted.
- Subscription quota could not be told apart from API spend.
- Judgment calls added cost and latency that no field recorded.
- Nothing could stop a confirmatory run at its dollar budget; `--max-total-tokens` bounds one trial, not an experiment.

[Descendant accounting](../testing/2026-08-26-bench-descendant-accounting-and-budget-cap.md) kept `costIncludingDescendants` null because no price table existed, and tokens were the only cost currency everywhere.

## Decision

### The cost-currency rule, amended for bench scope only

The runtime is unchanged: no runtime package carries a price table or a dollar field, and tokens remain the only runtime cost currency. Bench tooling prices trials from dated, research-only snapshots in [`bench/prices/`](../../../../bench/prices/README.md). A snapshot is a dated observation with sources, never edited after publication, and every trial records the snapshot id it was priced under, so a stored figure always resolves to the prices it used.

### Accounting

[`bench/runner/accounting.js`](../../../../bench/runner/accounting.js) folds the root session and its descendants into a per-trial `accounting` record; [the bench README](../../../../bench/README.md#priced-accounting) lists the rules. Five of them carry the decision:

- **A billed call is a `usage` chunk.** The stream protocol emits at most one per call, and a failed attempt that reported usage still bills. A step's `assistant/message` adds a call only when the step logged no usage chunk. The token fields of descendant accounting keep their message-only numerator.
- **Cache counts are read by presence.** The bench restates the `TokenUsage` contract instead of importing `cacheCount`: a present count, including 0, is reported, and an absent one is not. A call without a reported cache-read count is unreported as a whole: its prompt, including any write it reports, leaves the cache-hit share and counts toward the unreported share, and its dollars enter only an upper bound that prices its whole input at the uncached input rate.
- **Unpriced is never $0.** A route missing from `bench/accounting.json`, a model the snapshot lacks, or a null input or output price makes the call unpriced, counted and named. A null cache price bills that class at the input rate. Writes bill at the 5-minute tier because logged usage carries no write TTL. Off-peak prices apply when the request time, the step's `step/start`, falls in a snapshot window in UTC.
- **Subscription routes are quota, not dollars.** `subscriptionProviders` is an explicit list of route ids. Their calls count as input-equivalent quota tokens: each class weighted by its price relative to the model's input price. A separate `apiEquivalentDollars` figure, with its upper bound, prices them at API list rates so a subscription arm compares with an API arm, and it never enters spend or the cap.
- **Local is $0, not unpriced.** `localProviders` routes and `localJudgeEngines` judges (the loopback Laya and Shield gateways) count as local calls at zero marginal cost. Both lists are explicit, and the loader refuses an id in two billing lists.
- **Judgments and TTFT are measured, not recorded.** `model-routing/decision`, `child-decision`, and `shadow-decision` fold when a log carries them. Judge calls are counted by kind and engine, their latency is summed and sampled, and the critical path sums `latencyMs` plus `eligibilityMs` over awaited consults. Vendor-plan engines are counted, and an LLM judge's own usage is priced. TTFT per step is the first token-bearing chunk minus `step/start`.

Arm summaries pool the records: total and upper-bound dollars, quota tokens, raw tokens by class, cache-hit and unreported shares, judge totals, and TTFT and judge-latency p50/p90.

The bench carries cache-hit shares at two named scopes, both computed by one function (`cacheShares`) and both read by presence:

- `metrics.cacheHitShare` and `metrics.cacheUnreportedShare` fold the root session's usage records. The Jev report aggregates (`meanCacheHitShare`, `cacheHitShareNullTrials`, `meanCacheUnreportedShare`) and the routing pre-registration's H4 churn screen read them.
- `accounting.cacheHitShare` and `accounting.unreportedShare` cover the whole closure per billed call.

Each share sits beside its unreported share, so no report renders unreported input as a measured 0. The pre-registration defines `cacheHitShare` as the root session's presence-based share, and H4 coverage counts trials that "carry a reported cache-read count". No confirmatory trial ran under the earlier definition, which read an absent count as a miss.

### The dollar cap

`--max-dollars` gates launches, not trials. Before each launch the runner adds settled spend to a projection of every in-flight trial and the new one at the largest settled trial's spend; once that would exceed the cap it launches nothing more. In-flight trials finish, `run.json` records a `budgetStop` with the figures behind it, and the run exits 3. Spend is the upper-bound dollars, so an unreported call cannot hide under the cap. A resume counts every recorded trial's spend. `run.json` pins the cap, the snapshot id, and the accounting-config hash.

## Alternatives considered

**Count only `assistant/message` usage, matching the token fields.** Rejected for dollars: a failed attempt that reported usage was billed, and a cap that cannot see it undercounts exactly the runs that retry most. The token fields keep the message-only numerator, so stored runs stay comparable.

**Price an unreported call at the cache-read rate, or at an estimated hit share.** Rejected: either invents a measurement the provider did not make. The upper bound is the only figure the log supports, and the exact figure excludes the call.

**Price an unverified or unmapped model at $0, or at a neighbouring model's price.** Rejected: $0 makes an unpriced strong route look free, and a borrowed price is an unsourced guess. Unpriced calls are counted and named instead.

**Count a subscription route's API-equivalent dollars as spend.** Rejected: a subscription call bills quota, not dollars, so the cap would stop a run for money it never spends. The list-price figure stays a separate comparison column.

**Report local routes as unpriced, or infer them from a loopback base URL.** Rejected: unpriced means the price is unknown, while a local call's marginal price is known to be zero. The session log carries no base URL, so an explicit list is the only source.

**Infer subscription routes from route ids, such as a `-session` suffix.** Rejected: a new route would change the dollar/quota split silently. The route list is explicit configuration, pinned by hash.

**A live dollar watcher that kills a trial mid-run.** Rejected: a killed trial becomes a delivered `BUDGET_EXCEEDED` verdict and changes pass rates, while the per-trial token cap already bounds one trial. The experiment budget needs only launch gating.

**A write-TTL class that prices 1-hour writes separately.** Deferred: logged usage cannot separate the tiers, so the class would have no producer. Writes bill at the 5-minute tier until usage records the tier.

**Keep only the closure-wide share and drop the root-session metric.** Rejected: the pre-registered H4 screen and the Jev report read the root session's share, and a root figure stays comparable with the root token fields. Both scopes are kept, named, and computed by the same presence-based arithmetic.

**Keep the root share's earlier definition, which read an absent cache count as a miss.** Rejected: it breaks the `TokenUsage` presence contract, and it turned a provider that reports no cache counts into a cold cache.

**Import the cache readers from `@shres-code/shres-code-llm`.** Rejected: the bench is standalone plain ESM outside the workspace, with no runtime dependencies.

**Anchor TTFT on `request/header`.** Rejected: the loop logs a header only on start, resume, or change, so it is not a per-step anchor.

## Consequences

Arms become comparable in dollars, the cache-hit share covers only calls that reported cache reads, subscription use is separated from spend, judgment cost and critical-path latency are visible, and a confirmatory run stops before its budget instead of after it.

The figures are only as current as the snapshot: a price change needs a new dated file, and an unmapped route shows up as unpriced calls rather than dollars. The cap cannot count unpriced calls, so a run on unpriced routes ends with a warning naming how many it missed. The first trials of a run launch before any spend exists to project, so the cap can overshoot by up to one concurrency's worth of trials. Logs written before pi-ai routes declared cache reporting read as unreported. Weekday and holiday qualifiers on off-peak windows are not applied. Judge usage is priced only when a decision record carries `usage`, which no engine writes yet. Tokenizers differ across vendors, so reports compare dollars, never token counts across vendors.

## Testing

`node --test` in `bench/` runs fixture snapshots with round prices. It covers:

- presence handling: an absent count is unreported, and 0 is a reported miss;
- chunk-versus-message call folding;
- off-peak switching at a window boundary, and a window that spans midnight;
- unpriced and unmapped models;
- the quota/dollar split, API-equivalent dollars for subscription calls, and local routes and judges at $0;
- judgment folding, including vendor plans, priced LLM judges, and the critical path;
- TTFT over plain and packed chunk rows;
- pooling and percentiles;
- snapshot and config validation, including an id in two billing lists;
- the budget projection;
- through the fake harness: priced trial records, a `--max-dollars` stop with its manifest record and resume, and the unpriced warning.
