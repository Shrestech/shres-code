# Agent Note: A summarizer context overflow reduces the region instead of failing

Status: implemented

## Problem

A summarization call replays the conversation region it condenses, so the request it sends is roughly the size of the history it is trying to shrink. When that region alone exceeds the summarizer's own context window, every attempt fails at the same size: the compaction cannot produce a smaller checkpoint because producing one requires sending what it is meant to replace. The failure is self-locking — the session that most needs compaction is the one that cannot perform it.

The wedge behind this change was exactly that shape. The overflow trigger bypasses pressure and retention and selects the maximal balanced head range, so the region was the whole remaining history; the summarizer reported `CONTEXT_WINDOW_EXCEEDED` after generating nothing useful, four times across three hours, for both the automatic recovery and the operator's `/compact`. Each failed attempt recorded only an error string, so nothing in the log said the region itself was the problem.

## Decision

`maxSummaryOverflowRetries` (validated non-negative integer, default `2`; `0` attempts no reduction) bounds how many times one compaction shrinks its region in response to a summarizer-reported context overflow. After a failed attempt the retention floor rises to `max(retainTokens + 1, surfaceTokens − floor(failedRegionTokens / 2))`, so the next selected region carries at most half the failed region's metered tokens. Termination is structural rather than time-based: the region at least halves per retry, or range selection declines.

Every attempt keeps its own closed `compaction/start`/`compaction/end` bracket and its own durable failure facts, and the 1-based attempt index is threaded through `compactRegion` so a retried sequence is legible from the log. Both automatic entry points and `compactNow` run through one private helper, so there is a single reduction policy; each call site supplies the transaction, which is what keeps the manual path's standalone bracket and durability checkpoint intact.

An overflow counts as the summarizer's when durable failure facts or an error code say so, read through the `cause` chain: a manual attempt classifies its failure as `ManualCompactionError('summary')` wrapping the summarizer's error, so a one-link-deep check would have missed it and reported a plain failure.

When the budget is spent, or the reduced region has no compactable span, the failure names the region's metered size, the attempt count, the summarizer target, and the usage that attempt reported. The manual path keeps its `summary` classification around that diagnostic so a command result stays classifiable.

## Alternatives considered

**Split the region into several summarization calls.** Rejected for this change: the compaction instruction requires one consolidated checkpoint with every constraint verbatim, so chunked summaries need a merge pass whose prompt is the concatenation of the parts — which can exceed the window again — and the whole design exists to reuse the conversation's warm prefix cache, which per-chunk calls invalidate. A hierarchical merge would need its own bounded policy; it is deferred rather than impossible.

**Switch to a larger-window summarizer on overflow.** Rejected: nothing verifies a summarization route's window against this region — the same failure returns one hop later — and silently changing the model that writes the checkpoint changes what the checkpoint says. The operator-facing diagnostic names it as a deliberate action instead.

**Keep failing and let the caller retry.** Rejected: the wedge proves the caller retries at the same size, because the region is selected from the surface, not from the failure.

**Drop the oldest messages to shrink the region.** Rejected: that removes history with no durable summary, which is the outcome compaction exists to avoid. Reducing the region by raising the retention floor keeps every dropped message inside the checkpoint's coverage until the summary lands.

## Consequences

A session whose history alone exceeds the summarizer's window can now compact, at the cost of retaining a larger verbatim tail: the checkpoint covers less history, so later turns carry more original text and pressure returns sooner. Bounded at `1 + maxSummaryOverflowRetries` attempts per compaction, each of which is a full provider call. The failure mode when the reduction cannot help is explicit and actionable instead of an unexplained overflow.

## Testing

`compaction-basic.spec.ts` covers field validation for the default policy and exact-target overrides, the halving guarantee (`shadowedTokenCount` at most half the pre-compaction surface), per-attempt brackets with facts on the failed one, and both exhaustion diagnostics. `compaction-loop-repro.spec.ts` drives the real loop with a summarizer that overflows once: the retried region is at most half the failed one's metered tokens and the checkpoint lands. `manual-compaction.spec.ts` proves `compactNow` reduces and commits two standalone brackets instead of failing `summary`.
