# Agent Note: compaction pressure prices the next request, not only the heuristic surface

Status: implemented

## Problem

Automatic pressure compaction compared `tokenMeter.totalTokens` against `thresholdRatio × contextWindow`. `totalTokens` was entirely heuristic then, and it includes the request header — system prompt and tool schemas — which no compaction can remove. A threshold configured near or below that furniture floor fired on every step with nothing removable, and the same ratio applied wildly different real pressure on different window sizes. The bench's forced-compaction overlay (`thresholdRatio: 0.015`) hit exactly this: on 1M-token windows the 15.7k threshold sat below the ~13–16k fixed furniture of a real composition, and on 131k GLM windows it sat 7–8× below it, so every w6–w9 pressure trial compacted after nearly every step — induced amnesia, not memory pressure. Sessions showed batch-written rule slips, 4–7× re-read storms, and filename hallucinations as downstream symptoms.

## Decision

`TokenMeasurement.headerTokens` — the heuristic furniture estimate under the effective header (`estimateHeader`, the same function the baseline already uses) — still bounds what a threshold can mean for one composition, and pressure now compares the next request against that threshold in two readings:

```ts ignore-check
const spec = resolveCompactSpec(policy, context.contextWindow)
const surfaceBudget = () => spec.thresholdTokens - measurement.headerTokens
if (surfaceBudget() <= spec.retainTokens) return null              // config cannot express pressure here
if (!underPressure(measurement, spec.thresholdTokens)) return null // not yet under pressure
```

`pressureReading` prefers the provider-anchored figure — `totalTokens` while `baseline.kind === 'usage'`, which is the last response's reported prompt and output plus the meter's signed repricing of everything the surface gained since — and falls back to `surfaceTokens + headerTokens` before the first response reports usage, or once a header change moves the anchor. Both readings compare against `thresholdTokens` directly, so the request furniture is counted on the measured side; the furniture split survives as a configuration rule rather than as the measured side.

That rule still does what it was introduced for: a threshold fully consumed by furniture plus the retained tail declines instead of looping, so `thresholdRatio` stays window-size independent and structurally unable to doom-loop, and the retry-exhaustion error names surface, budget, threshold, furniture, and the reading's source and size. `selectCompactableRange` still prices only surface nodes, so retention semantics are unchanged.

The reading changed because the heuristic estimator cannot see adapter-private replay or measure density the wire carries: the same session can sit under the heuristic budget while the provider reports far more — 1.65x at the wedge behind [the scoped overflow guard](../bug-fix/2026-09-16-scope-usage-overflow-detection-to-truncating-protocols.md). Reported usage is the authority for the request that produced it.

## Consequences

Default-shipped configurations (0.8 × window) behave identically at scale: furniture is a rounding error at 800k thresholds. Low-threshold pressure overlays now produce genuine pressure instead of step-boundary amnesia — prior w6–w9 pressure-run conclusions carry an instrument caveat until rerun under the fixed accounting (the overlay file's stale band commentary is corrected). The bench overlay's 0.015 ratio now means 15.7k of *surface* budget on 1M windows: mid-task compaction on 10–30-turn tasks with usable retained memory, which was the overlay's documented intent. Prime Agent's trigger (window minus fixed reserve, provider-usage measured, five tools of furniture) is structurally immune to this bug by simplicity; our fix keeps the richer composition: pressure prices the next request — the provider's own figure whenever it reported one — against the threshold, so a large tool surface is priced where it actually costs instead of being subtracted from an estimate the wire already exceeded.

## Alternatives considered

**Raise the bench overlay ratio only.** Rejected as the whole fix: window-relative thresholds still include furniture, so pressure would remain window- and composition-dependent; the same bug returns with any future low threshold.

**Exclude furniture by making `estimateHeader` return zero for the meter.** Rejected: request-pressure accounting (`totalTokens`) legitimately prices the full envelope for overflow and usage displays; only the pressure decision needed the split.

**Clamp the surface budget to ≥1 token.** Rejected: that turns "threshold below furniture" into an unreachable condition that exhausts retries; declining is the honest outcome.

**Keep pricing only the heuristic surface (this note's previous decision).** Lost once the wedge showed the heuristic reading at 92% of its budget while the provider reported a 303k-token prompt: a gate that cannot see what the wire carries cannot protect the window, and no threshold ratio repairs a 1.65x undercount.

**Price `totalTokens` unconditionally.** Rejected: without a usage anchor `totalTokens` is the estimate plus furniture — the comparison this note removed — so the fallback keeps the split, and a header change deliberately drops back to it because the anchor describes the request it came from.

## Testing

`packages/llm/token-meter`: `headerTokens` on the empty measurement and populated paths. `packages/compaction/compaction-basic` (267 passing with token-meter): the doom-loop regression — furniture alone above threshold declines; surface above the furniture-adjusted budget still triggers; retry exhaustion names the new budget; the pin-list and pruner interactions unchanged. `compaction-loop-repro.spec.ts` drives the real loop twice over the same scripted turn — once with the adapter reporting a prompt above the window and once reporting none — and asserts the anchored run compacts while the heuristic run, whose pre-step gate is reached, declines.
