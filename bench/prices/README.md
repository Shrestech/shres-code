# Bench price snapshots

Dated, research-only reference prices for the models the routing bench can price. A snapshot is an input to bench cost accounting, not to the runtime.

## Research only

**The runtime has no price table, and this folder does not add one.** Tokens are the only runtime cost currency; a snapshot exists so the bench runner can price each trial in API-equivalent dollars beside the raw token counts it records ([priced accounting](../README.md#priced-accounting), [BENCHMARK.md](../../BENCHMARK.md)). The runner prices under the newest snapshot unless `--price-snapshot` names one.

Nothing here is billing truth. A snapshot records what a pricing page said on its `fetched` date, and prices change without notice; re-check the `sourceUrl` before trusting any figure.

## Adding a snapshot

Add a new file named `YYYY-MM-DD.json` for the date the prices were read. **Never edit a published snapshot.** A correction is a new dated file, so every trial's recorded `priceSnapshot` keeps resolving to the numbers it was measured against.

A snapshot is valid only while every price is either a verified non-negative number or `null`.

## Schema

Top level: `snapshotDate` (equals the filename's date), `currency`, `priceUnit`, `researchOnly`, and `models`.

Each `models` entry:

| Field | Meaning |
|---|---|
| `provider` | Route family the price belongs to (`anthropic`, `deepseek`, `ollama`, `zai`, `moonshot`, …). |
| `model` | Model id exactly as the route names it. |
| `currency` | `USD` for every entry in this snapshot set. |
| `input` | USD per 1M cache-miss input tokens. |
| `output` | USD per 1M output tokens. |
| `cacheWrite5m` | USD per 1M tokens written into a 5-minute cache tier; `null` when the provider publishes none. |
| `cacheWrite1h` | USD per 1M tokens written into a 1-hour cache tier; `null` when the provider publishes none. |
| `cacheRead` | USD per 1M cache-hit (read) input tokens. |
| `offPeak` | The same five price fields for the provider's off-peak schedule, or `null` when it publishes none. |
| `nullFields` | Every price field the entry leaves `null`, named as `cacheWrite5m` or `offPeak.cacheWrite1h`; it matches the entry's null prices exactly. |
| `peakWindowsUtc` | Published peak windows, each `HH:MM-HH:MM` in UTC. |
| `offPeakWindowsUtc` | Published off-peak windows in the same form. A window may span midnight; weekday and holiday qualifiers live in `windowNotes`. An empty list beside a non-empty `peakWindowsUtc` means the provider publishes no off-peak rate for that model, so every hour bills at the peak price. |
| `windowNotes` | Prose for the schedule's qualifiers; `null` when the provider publishes no peak/off-peak split. |
| `cacheTtlNotes` | Prose for the cache TTL tiers, write premiums, and retention; `null` when the provider documents none. |
| `sourceUrl` | The pricing page the values were read from; `null` only on an entry with no fetched source. |
| `fetched` | The date the source was read. |
| `unverified` | `true` when the entry holds any value that could not be verified against the review's audited sources. |
| `notes` | Prose on what is missing or unpriced; `null` when the entry is complete. |
| `verification` | Optional. A short statement of who checked the entry against primary sources and when, e.g. `Lead check of primary sources, 2026-09-24`. |
| `verificationSources` | Optional. The source URLs a `verification` covered; present only alongside `verification`. |

`nullFields` names every price field the entry leaves `null`, and the test asserts it matches the null prices exactly. A `null` means the provider publishes no separate rate for that field, and `notes` or `cacheTtlNotes` says why.

`unverified: true` is reserved for an entry whose whole price row is unknown: every price field is `null`, and `notes` records why. An entry with any verified price carries `unverified: false`, even when some of its fields are unpublished.

## Provenance

`2026-09-24.json` was compiled from the audited price and cache sections of the routing review's verification notes, cross-checked against the fetched pricing pages. A verified value appears as a number; a field the provider publishes no separate rate for is `null` and named in `nullFields`; only an entry with no verified price at all carries `unverified: true`. No price in a snapshot may be inferred from a sibling model, a multiplier, or an unpublished tier.

The `deepseek-v4-pro` entries carry a `verification` of `Lead check of primary sources, 2026-09-24`, citing both the DeepSeek and Ollama pricing pages: peak input `1.32`, cache hit `0.044`, and output `3.96` per 1M tokens, halved off-peak.
