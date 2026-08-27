# Agent Note: Compaction-retention tuning for constraint survival

Status: implemented

## Problem

Under pressure, compaction-basic fires many times per trial (thresholdRatio 0.8, retainRatio 0.16, summary maxTokens 8192). Constraints stated once in the user's instruction live at the surface head, which is exactly the span auto-compaction shadows. w6–w8 lost a `qty()` constraint across those resets. The summarizer's Critical Context section treated constraints as paraphraseable context, and nothing prevented a selected range from shadowing a seq the operator needed to keep.

## Decision

The summarization directive includes a dedicated `## Constraints` section and a rule that constraint-style statements (quantities, caps, prohibitions, required formats, house rules stated once) must be copied verbatim and must survive later checkpoint merges. Shipped pressure defaults are unchanged; the directive is the constraint-preserving change.

`pinSeqs` is an optional top-level Config array of unique non-negative safe integers. `selectCompactableRange` never includes those seqs: it skips a pinned head prefix and stops before a pin inside the would-be range, so a pinned node stays on the surface. Log-only seq-pointer events remain the model-visible re-fetch path for shadowed content ([`POINTER_READ_CUE`](../../../../packages/compaction/compaction-basic/src/pointers.ts)).

This is [roadmap WP1.6](../../proposed/feature/2026-08-26-beat-prime-agent-roadmap.md).

## Alternatives considered

**Raise retainRatio or lower thresholdRatio so the instruction tail survives.** Rejected as the primary fix — the instruction is at the head, not the retained tail. Changing shipped ratios without a measurement note would also violate the no-hardcoded-tunables / measure-before-default-flip rules. Ratios stay Config; this WP does not change their defaults.

**Pin the first user message automatically.** Rejected — a heuristic pin is a hidden default. Operators who know a seq must survive set `pinSeqs`.

**Leave constraints inside Critical Context.** Rejected — that section already asked to capture constraints among other context and still paraphrased them away. A dedicated section plus an explicit verbatim rule is the cue at summarization time.

## Consequences

Summarizer requests are longer by the Constraints section and two rule lines. Checkpoints that previously omitted a once-stated quantity are a summarizer-instruction miss, not a missing mechanism. `pinSeqs` is session-seq specific: a composition that copies numeric seqs across sessions will pin the wrong events; that is fail-loud at the wrong seq (the node is simply absent) rather than a silent global keep.

A constraint-survival arm on the pressure catalog (w6–w8 qty-slip) is pre-registered as the measurement for whether the verbatim rule plus optional `pinSeqs` changes pass rate; this WP does not run it. Shipped `thresholdRatio` / `retainRatio` / `maxTokens` stay 0.8 / 0.16 / 8192 until that arm reports.
