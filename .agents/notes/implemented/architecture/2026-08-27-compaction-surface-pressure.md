# Agent Note: compaction pressure prices the surface, not the furniture

Status: implemented

## Problem

Automatic pressure compaction compared `tokenMeter.totalTokens` against `thresholdRatio × contextWindow`. `totalTokens` heuristically includes the request header — system prompt and tool schemas — which no compaction can remove. A threshold configured near or below that furniture floor fired on every step with nothing removable, and the same ratio applied wildly different real pressure on different window sizes. The bench's forced-compaction overlay (`thresholdRatio: 0.015`) hit exactly this: on 1M-token windows the 15.7k threshold sat below the ~13–16k fixed furniture of a real composition, and on 131k GLM windows it sat 7–8× below it, so every w6–w9 pressure trial compacted after nearly every step — induced amnesia, not memory pressure. Sessions showed batch-written rule slips, 4–7× re-read storms, and filename hallucinations as downstream symptoms.

## Decision

`TokenMeasurement` gains `headerTokens` — the heuristic furniture estimate under the effective header (`estimateHeader`, the same function the baseline already uses). `compaction-basic`'s pressure check now prices only what compaction can act on:

```ts ignore-check
const surfaceBudget = () => spec.thresholdTokens - measurement.headerTokens
if (surfaceBudget() <= spec.retainTokens) return null        // config cannot express pressure here
if (measurement.surfaceTokens < surfaceBudget()) return null // not yet under pressure
```

A threshold fully consumed by furniture plus the retained tail declines instead of looping. `thresholdRatio`'s contract becomes "fraction of the window usable for compactable content": window-size independent, furniture-immune, and structurally unable to doom-loop. The retry-exhaustion error names surface, budget, threshold, and furniture so misconfiguration is legible. `selectCompactableRange` already priced only surface nodes, so retention semantics are unchanged.

## Consequences

Default-shipped configurations (0.8 × window) behave identically at scale: furniture is a rounding error at 800k thresholds. Low-threshold pressure overlays now produce genuine pressure instead of step-boundary amnesia — prior w6–w9 pressure-run conclusions carry an instrument caveat until rerun under the fixed accounting (the overlay file's stale band commentary is corrected). The bench overlay's 0.015 ratio now means 15.7k of *surface* budget on 1M windows: mid-task compaction on 10–30-turn tasks with usable retained memory, which was the overlay's documented intent. Prime Agent's trigger (window minus fixed reserve, provider-usage measured, five tools of furniture) is structurally immune to this bug by simplicity; our fix keeps the richer composition while removing the floor from the measured side — large tool surfaces stop being a compaction liability.

## Alternatives considered

**Raise the bench overlay ratio only.** Rejected as the whole fix: window-relative thresholds still include furniture, so pressure would remain window- and composition-dependent; the same bug returns with any future low threshold.

**Exclude furniture by making `estimateHeader` return zero for the meter.** Rejected: request-pressure accounting (`totalTokens`) legitimately prices the full envelope for overflow and usage displays; only the pressure decision needed the split.

**Clamp the surface budget to ≥1 token.** Rejected: that turns "threshold below furniture" into an unreachable condition that exhausts retries; declining is the honest outcome.

## Testing

`packages/llm/token-meter`: `headerTokens` on the empty measurement and populated paths. `packages/compaction/compaction-basic` (267 passing with token-meter): the doom-loop regression — furniture alone above threshold declines; surface above the furniture-adjusted budget still triggers; retry exhaustion names the new budget; the pin-list and pruner interactions unchanged.
