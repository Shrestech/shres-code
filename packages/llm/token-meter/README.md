# @shres-code/shres-code-token-meter

Replay-aware token measurement through the singleton `ctx.tokenMeter` service. It advances one isolated fold per session from the durable log, so compaction and other pressure-sensitive plugins can share accounting without depending on `CompactionEngine`.

## Configuration

The estimator has no settings. It intentionally uses one fixed heuristic: four characters per token plus structural overhead for roles, blocks, and request-envelope fields. Any key is rejected; model capacity belongs to the adapter that owns an exact provider/model route and is available through `ctx.llm.resolveModelInfo().context`.

## Measurement contract

`ctx.tokenMeter` directly exposes two operations:

- `measure(session, requestHeader?)` returns request pressure and the current priced surface at one consumed-log revision.
- `estimateMessage(message)` prices one message with the fixed heuristic.

`measure()` synchronizes once and returns one detached, deeply immutable snapshot. `totalTokens` is request-and-response pressure, while `surfaceTokens` is the surface-only heuristic total and equals the sum of `nodes[].tokens`. A `requestHeader` override affects pressure fields only; the surface fields still describe the current session. Every call clones the positional nodes, so measurement is O(surface).

The fold tracks full request-header snapshots, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and the chunk seqs cited by each assistant message. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope and its total is no lower than that call's full heuristic anchor; a later success replaces the earlier anchor. Otherwise the complete current envelope and surface are estimated. Surface changes remain signed relative to a matching anchor, including negative deltas after shrinking replacements.

Usage accounting sums disjoint input, cache-read, cache-write, and output buckets through the LLM package's `promptTokens`; reasoning is not added again. Every successful call records an assistant anchor, including content-less calls. An explicit empty `sourceEventSeqs` list means a known empty provider stream, while an absent legacy list conservatively treats the durable assistant output as provider output.

## Session projections

When the composition provides `ctx.sessionProjections`, token-meter registers three units through an optional child fiber.

`tokenUsage` carries the complete durable log's `uncachedInputTokens`, `unreportedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. A call's input lands in `uncachedInputTokens` when its provider reported cache reads; when it did not, its whole prompt, including a write count carried without a read count, lands in `unreportedInputTokens`, because unreported input may include cache hits. The cache buckets sum reported counts only, read through `cacheCount`. A consumer computing a hit rate divides over reported input and shows the cache as not reported when no call reported it. Usage chunks are counted even when a request later fails; a final assistant-message usage for the same `(turn, step)` replaces that sample instead of double-counting it. Reasoning remains an output subdivision. The single last-sample slot relies on a session-log ordering property: once a later step reports usage, a legal log never reports usage for an earlier step again.

`contextPressure` carries optional `pressureTokens` — the newest provider-reported prompt size, `promptTokens` of that call's usage — optional `projectedTokens`, and optional `contextWindow` from the newest `request/context` record. Both figures stay absent until a provider reports usage; capacity stays absent for a route whose adapter advertises none. Output is excluded, so `pressureTokens` holds still while a turn streams and steps forward when the next request reports its usage.

`projectedTokens` is what the NEXT request's prompt would cost: the sample plus the heuristic repricing of everything the surface gained or lost since it was taken, clamped at zero and folded through the same `surface-fold.ts` the measurement service replays. Only the delta is estimated, so the figure stays anchored to the provider while reacting the moment content lands — or a compaction shadows a span. That last case is why the field exists: compaction summarizes through a direct `ctx.llm.stream()` call and appends no usage of its own, so `pressureTokens` alone reports the pre-compaction prompt until an entire further turn completes. Occupancy displays read `projectedTokens`.

`contextBreakdown` carries heuristic `systemTokens`, `toolsTokens`, and `messageTokens` — the context's composition rather than its provider-billed size. The envelope figures reprice last-wins on every `request/header`; the message figure replays `surface-fold.ts` — the same positional fold `measure()` runs — so it equals `measure().surfaceTokens` at every event boundary and compaction shrinks it the way it shrinks the next request. All three figures use the measurement service's fixed heuristic and are estimates: they will not sum to `projectedTokens`, whose provider anchor carries exactly the error — CJK text and JSON schemas underprice badly at four characters per token — that the composition rows still contain. Present them as an approximate composition, never as a total.

All three units use the standard projection baseline, live frame, higher-seq-wins store, and JSON checkpoint paths. Unloading token-meter removes all three keys. A composition without the projection seam keeps the measurement service's existing behavior.

### Context occupancy is an approximation, by design

The occupancy fields are independent last-wins records and are **not** one atomic observation of a single request. Switching models pairs the fresh capacity with the previous route's sample until the next request reports usage, and `pressureTokens` describes the last request rather than the surface as it stands right now — `projectedTokens` carries that sample forward over the surface's movement, but its anchor is still the older request.

This is deliberate. An occupancy percentage is a user-facing reference figure, not a billing record or a gating input — nothing in the harness makes decisions from it, and compaction reads `measure()` instead. A UI computes occupancy by dividing measured pressure by the separately resolved capacity for the selected model.

The [Agent Note](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) records the rejected atomic-pair comparison. Consumers that need an exact same-boundary figure should call `measure()` at their own request boundary rather than read this projection.

## Composition

```yaml
- name: '@shres-code/shres-code-token-meter'
- name: '@shres-code/shres-code-compaction-basic'
```

Both plugins have usable defaults. The meter remains independent of model routing and optional compaction. A deployment configures capacity on its LLM adapter and compaction policy on `shres-compaction-basic`.

## Model Experience

Indirectly, through consumers such as `shres-compaction-basic`; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The fixed heuristic is approximate** — content without reusable provider usage is priced by character count plus structural overhead, not an exact provider tokenizer or request serializer.
- **Every measurement clones the current surface** — coherent immutable snapshots make reads O(surface), including below-threshold pressure checks.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, provider, model, or call-config changes deliberately fall back to full heuristic estimation.
- **pi-ai logs written before cache-count reporting read as not reported** — before routes declared `cacheUsage`, the pi-ai adapter omitted a cache count whenever it was 0, so a measured miss in those logs is indistinguishable from an unreported count and lands in `unreportedInputTokens`. That reading is conservative and the logs are not migrated ([Agent Note](../../../.agents/notes/implemented/architecture/2026-09-24-three-state-cache-usage.md)).
- **Missing legacy source seqs are handled conservatively** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.
