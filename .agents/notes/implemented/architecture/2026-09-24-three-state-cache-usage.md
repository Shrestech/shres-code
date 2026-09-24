# Agent Note: Cache counts record whether the provider reported them

Status: implemented

## Problem

`TokenUsage.cacheReadTokens` and `cacheWriteTokens` were optional with no stated meaning for absence. The pi-ai adapter omitted a cache count whenever it was 0, because pi-ai's `Usage` defaults a count the provider did not send to 0 and cannot tell the two apart. The DeepSeek adapter wrote a count exactly when the wire carried one, and the CLI bridge never wrote one. A reader therefore saw the same absent field for three different facts: a measured miss, a provider without cache accounting, and an adapter that dropped a zero.

Every consumer resolved the ambiguity by reading absence as 0. The chat stats line showed `Cache hit 0%` for sessions whose provider never reported cache counts, prompt-size sums treated a missing count as a measured zero, and aggregates added partial counts as if they were totals. Cache-hit analysis over recorded sessions could not separate cold caches from missing telemetry, so any policy that reasons about prompt-cache state had no trustworthy input.

## Decision

Presence is the report. `cacheReadTokens` and `cacheWriteTokens` each record whether the provider reported that count: present, including 0, means the provider reported it for this call; absent means it did not, and `inputTokens` may then include cached input. Adapters must emit a reported zero and must not emit an unreported count. The read count decides whether a call's cache counts are reported: `cacheWriteTokens` is reported only alongside `cacheReadTokens`, so a provider that reports cache hits but has no write concept omits the write count, and producers must not emit a write count without a read count. The contract is the JSDoc of `TokenUsage` in `packages/llm/llm/src/types.ts` and is restated in [llm-streaming.md](../../../../docs/subsystems/llm-streaming.md#tokenusage). The durable format is unchanged, `SESSION_FORMAT_VERSION` stays 0, and recorded fixtures already obey the contract.

### Producers

- **pi-ai.** A route declares `cacheUsage: 'reported' | 'unreported'` on its profile. `resolveCacheUsage` in `packages/llm/llm-pi-ai/src/config.ts` resolves each request: the route's declaration wins; otherwise the model's protocol decides. `anthropic-messages` and the OpenAI Responses family report cache counts in every response and resolve to `reported`; every other protocol a catalog model can speak, including chat completions, Gemini, Vertex, Bedrock, and Mistral, resolves to `unreported`, so an unproven protocol never presents a missing count as a miss. `mapUsage` emits both counts, zeros included, on a reported route, and on an unreported route emits neither and adds any counts pi-ai parsed back into `inputTokens`, so the input is the whole prompt.
- **Session adapters.** `llm-claude-session`, `llm-codex-session`, `llm-grok-session`, and `llm-xai-apikey` each declare `cacheUsage: 'reported'` explicitly in `resolveRoute`. `llm-cursor-session` emits no usage.
- **DeepSeek** already writes `cacheReadTokens` exactly when the wire carries `prompt_cache_hit_tokens` or `prompt_tokens_details.cached_tokens`, and never writes `cacheWriteTokens`. **The CLI bridge** never reads a CLI's cache counts, so both are always absent. Only their documentation changes.
- **Invariant.** The LLM stream invariant rejects a present count that is not a non-negative safe integer, and a write count without a read count. No producer emits that shape: pi-ai emits both counts or neither, and DeepSeek emits reads only.

### Readers

`packages/llm/llm/src/usage.ts` is the one home for reading the contract. The package root re-exports it, and browser code imports it from the dependency-minimal `@shres-code/shres-code-llm/usage` entry.

- `cacheCount(usage, 'read' | 'write')` returns the reported count or `undefined`; a write count carried without a read count is returned as unreported.
- `promptTokens(usage)` returns `inputTokens` plus every cache count the usage carries, which is the whole prompt whether or not the counts were reported.
- `addTokenUsage(total, next)` sums two usages under the same contract. A cache count stays present only when both operands reported it; otherwise the sum folds every value of that count the operands carry into `inputTokens`, so an aggregate never presents a partial count as a total and its `promptTokens` equals the operands' combined prompt.

Consumers:

- **token-meter.** The `tokenUsage` projection gains an `unreportedInputTokens` bucket. A call's input lands in `uncachedInputTokens` only when its provider reported cache reads; otherwise its whole prompt, including a write count carried without a read count, lands in `unreportedInputTokens`. The cache buckets sum reported counts. `stateVersion` is 3, so cached rows from a previous classification are discarded. `contextPressure.pressureTokens` and the measurement service's usage totals use `promptTokens`.
- **Stats line.** Billed input adds the unreported bucket. Cache hit divides cache reads by the input of calls that reported cache reads, and the strip shows `Cache not reported` when no call did.
- **Trajectory.** A request row shows `Cached: not reported` when the provider did not report cache reads, and its `Other` row appears only when it did; a write count carried without a read count shows as input, never as a cache write. Per-assistant and cumulative request usage sum through `addTokenUsage`.
- **Compaction, loader-smoke, and the client fixture API.** The compaction failure message reports `promptTokens`, the loader-smoke turn result sums with `addTokenUsage`, and the connection fixture's projection mirror matches the token-meter buckets.

Time to first token stays derived from the log instead of recorded in `TokenUsage`: a step's first token-bearing `assistant/chunk` time minus that step's `step/start` time, which is the fold the client runtime already uses. `request/header` cannot anchor it, because the loop logs a header only when the header changes.

## Alternatives considered

**A required tagged union, `TokenUsage.cache: { kind: 'reported'; readTokens; writeTokens } | { kind: 'unreported' }` (rejected).** It states the three states in the type, but the premise that old logs would be rejected is false: the session loader checks event types, not payload fields, and the upgrader chain does not exist yet. Every existing log would load and then crash its readers with a `TypeError` on `usage.cache.kind`, and a crash is not a rejection. It would also rewrite about 100 committed replay fixtures holding 426 recorded usage objects and conflict with every reader on in-flight branches.

**The tagged union with a fixture migration (rejected).** Migrating committed fixtures removes the churn in this repository but leaves every user's existing session log crashing its readers.

**The tagged union with a durable-boundary normalizer for old logs (rejected).** A read-time shim that rewrites old usage into the union keeps old logs working, but it is a compatibility path for a format that presence already expresses, and it would have to guess reportedness for every old pi-ai log anyway.

**A separate reportedness flag beside the counts (rejected).** A field such as `cacheReported: boolean` duplicates what presence already says and creates two sources of truth that can disagree.

**Observing reportedness from the wire (deferred).** pi-ai's `Usage` hides whether the provider sent a count, so the adapter cannot observe it today. The route declaration stands in for it, and `packages/llm/llm-pi-ai/src/stream.ts` carries an `XXX(pi-ai upstream)` note to read presence from raw provider usage when pi-ai exposes it.

**Classify the two counts independently (rejected).** Before the read count decided, a usage carrying a write count but no read count was classified three ways: token-meter and the stats line counted the write as reported, bench accounting folded it into unreported input, and `addTokenUsage` treated read and write independently. The read count is what makes a call's input classifiable, because without it `inputTokens` may hold cache hits, so a lone write cannot make the call's cache figures trustworthy. Making the read count decide gives every consumer the bench's reading, and rejecting the shape at the producer boundary keeps it out of the log.

**A write-TTL classification on reported writes (deferred).** A `writeTtl` of `short`, `long`, or `mixed` would let accounting price 5-minute and 1-hour cache writes separately, but no producer can fill it: pi-ai flattens the per-TTL creation split. It waits for a producer.

## Consequences

Cache accounting now distinguishes a measured miss from missing telemetry: a hit rate is computed only over input that carries a cache report, and the product says `not reported` instead of `0%`. The durable format, the recorded fixtures, and every existing session log keep working without migration.

The route declaration is trusted, not observed. A `reported` declaration on a provider without cache accounting shows misses as 0, and an `unreported` declaration on a provider that reports counts hides them; the pi-ai README lists this as a known limitation.

pi-ai logs written before this change encode a reported zero as absent, so their misses read as not reported and land in `unreportedInputTokens`. This is conservative, and the logs are not migrated.

Aggregates over calls with mixed reporting fold the partially reported counts into input and drop them from the cache figures, so a session that mixes a reporting and a non-reporting route shows fewer cache tokens and more input than a partial sum would. The prompt total is exact either way.

Sessions recorded from providers that never reported cache counts now show `Cache not reported` where the stats line showed `Cache hit 0%`, and the hit rate of a session that mixes reported and unreported calls rises because unreported input leaves the denominator.
